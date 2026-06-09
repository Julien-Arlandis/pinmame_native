// audio.cpp — Pipeline audio WASM : ring buffer YM2151, DAC push, hooks OSD, pacing

#include <cstring>
#include <emscripten.h>

extern "C" {
#include "driver.h"
}

// ── Tailles des tampons ───────────────────────────────────────────────────────
#define C_AUDIO_BUFFER_MAX 131072
#define SAMPLES_PER_FRAME  735
#define DAC_BUF_MAX        4096

// ── Ring buffer YM2151 / stream OSD ──────────────────────────────────────────
static INT16 g_audio_ring_buffer[C_AUDIO_BUFFER_MAX];
static int   g_audio_write_idx = 0;
static int   g_audio_read_idx  = 0;
static INT16 g_linear_audio_buffer[C_AUDIO_BUFFER_MAX];

// ── DAC push buffer ───────────────────────────────────────────────────────────
// Intercepté via --wrap=DAC_DC_offset_correction_data_16_w.
// L'intégrateur DC-offset est appliqué ici (réplique exacte de dac.c ligne 90).
// g_dac_buf stocke des valeurs en -32768..32767 ; JS normalise par 32768.
static int    g_dac_buf[2][DAC_BUF_MAX];
static int    g_dac_n[2]          = {0, 0};
static double g_dac_integrator[2] = {0.0, 0.0};
static int    g_dac_prev_data[2]  = {0, 0};

extern "C" void emscripten_sleep(unsigned int ms);

// ── Hooks OSD audio (appelés par MAME chaque frame) ──────────────────────────
extern "C" {

    int osd_start_audio_stream(int stereo) { return SAMPLES_PER_FRAME; }

    int osd_update_audio_stream(INT16 *buffer) {
        int shorts = SAMPLES_PER_FRAME * 2;
        for (int i = 0; i < shorts; i++) {
            g_audio_ring_buffer[g_audio_write_idx] = buffer[i];
            g_audio_write_idx = (g_audio_write_idx + 1) % C_AUDIO_BUFFER_MAX;
        }
        return SAMPLES_PER_FRAME;
    }

    void osd_stop_audio_stream(void) {}
    void osd_sound_enable(int enable) {}

    // ── Appelé depuis artwork_update_video_and_audio dans api.cpp ────────────
    void audio_push_frame(uint32_t emulator_generation) {
        int pending = (g_audio_write_idx - g_audio_read_idx + C_AUDIO_BUFFER_MAX) % C_AUDIO_BUFFER_MAX;
        if (pending == 0) return;
        if (pending > 4096) pending = 4096;
        for (int i = 0; i < pending; i++) {
            g_linear_audio_buffer[i] = g_audio_ring_buffer[g_audio_read_idx];
            g_audio_read_idx = (g_audio_read_idx + 1) % C_AUDIO_BUFFER_MAX;
        }
        EM_ASM({
            if (window.pushWasmAudio) window.pushWasmAudio($0, $1, $2);
        }, (uint32_t)g_linear_audio_buffer, pending, emulator_generation);
    }

    // Paliers de sleep : régule la vitesse d'émulation selon la profondeur du
    // buffer audio JS. 12 ms plancher évite le sur-débit perceptible à 10 ms
    // tout en garantissant un remplissage suffisant quand le buffer se vide.
    void audio_frame_pacing(uint32_t js_buffer_dist) {
        if      (js_buffer_dist > 8192) emscripten_sleep(20);
        else if (js_buffer_dist > 4096) emscripten_sleep(17);
        else if (js_buffer_dist > 1600) emscripten_sleep(15);
        else                             emscripten_sleep(12);
    }

    // ── Exports DAC pour JS ───────────────────────────────────────────────────
    EMSCRIPTEN_KEEPALIVE
    int api_get_dac_count(int chip) { return (unsigned)chip < 2 ? g_dac_n[chip] : 0; }

    EMSCRIPTEN_KEEPALIVE
    int* api_get_dac_buffer(int chip) { return (unsigned)chip < 2 ? g_dac_buf[chip] : nullptr; }

    EMSCRIPTEN_KEEPALIVE
    void api_reset_dac_buffer(int chip) { if ((unsigned)chip < 2) g_dac_n[chip] = 0; }

} // extern "C"

// ── Wrapper --wrap=DAC_DC_offset_correction_data_16_w ────────────────────────
// Intercepte chaque écriture DAC. Applique l'intégrateur DC-offset (réplique de
// dac.c) et stocke le résultat dans g_dac_buf pour mélange inter-frame côté JS.
extern "C" void __real_DAC_DC_offset_correction_data_16_w(int num, int data);
extern "C" void __wrap_DAC_DC_offset_correction_data_16_w(int num, int data) {
    if ((unsigned)num < 2 && g_dac_n[num] < DAC_BUF_MAX) {
        g_dac_integrator[num] = g_dac_integrator[num] * 0.990 + (data - g_dac_prev_data[num]);
        g_dac_prev_data[num]  = data;
        int out = (int)g_dac_integrator[num];
        if (out < -32768) out = -32768;
        else if (out > 32767) out = 32767;
        g_dac_buf[num][g_dac_n[num]++] = out;
    }
    // __real_ NON appelé : le stream DAC MAME reste à 0.
}
