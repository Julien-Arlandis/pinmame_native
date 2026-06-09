// audio.cpp — Pipeline audio WASM : ring buffer YM2151, DAC push, hooks OSD, pacing

#include <cstring>
#include <emscripten.h>

#ifndef __rolq
#define __rolq(x,c) (((unsigned long long)(x) << (c)) | ((unsigned long long)(x) >> (64 - (c))))
#endif
#ifndef __rorq
#define __rorq(x,c) (((unsigned long long)(x) >> (c)) | ((unsigned long long)(x) << (64 - (c))))
#endif

extern "C" {
#include "driver.h"
#include "sound/ym2151.h"
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
    // ── Pont hardware YM2151 (OPM) ────────────────────────────────────────────
    extern void stream_update(int stream, int min_interval);

    static void (*g_mame_opm_irq_handler)(int, int) = nullptr;

    static void native_jarek_irq_bridge(int state) {
        if (g_mame_opm_irq_handler) { g_mame_opm_irq_handler(0, state); }
    }

    int OPMInit(int num, int clock, int rate, void (*timer_handler)(int, int, int, double), void (*irq_handler)(int, int)) {
        g_mame_opm_irq_handler = irq_handler;
        int res = YM2151Init(num, (double)clock, (double)rate);
        YM2151SetIrqHandler(num, native_jarek_irq_bridge);
        return res;
    }

    void OPMShutdown(void) { YM2151Shutdown(); }
    void OPMResetChip(int num) { YM2151ResetChip(num); }

    void OPMUpdateOne(int num, INT16 **buffer, int length) {
        YM2151UpdateOne(num, buffer, length);
    }

    void OPMSetPortHander(int num, void (*PortWrite)(unsigned int offset, unsigned char data)) {}

    int YM2151TimerOver(int num, int c) { return 0; }

    static int g_gts80b_sound_reg_latch = 0;
    void YM2151_register_port_0_w(offs_t offset, data8_t data) {
        g_gts80b_sound_reg_latch = data;
    }
    void YM2151_data_port_0_w(offs_t offset, data8_t data) {
        for (int i = 0; i < 4; i++) { stream_update(i, 0); }
        YM2151WriteReg(0, g_gts80b_sound_reg_latch, data);
    }

    // ── Stubs OSD son + puces secondaires ─────────────────────────────────────
    int osd_init_sound(void) { return 0; }
    void proc_mechsounds(int p1, int p2) {}

    int YM2203_sh_start(const struct MachineSound *msound) { return 0; }
    void YM2203_sh_stop(void) {}
    void YM2203_sh_reset(void) {}

    int OKIM6295_sh_start(const struct MachineSound *msound) { return 0; }
    void OKIM6295_sh_stop(void) {}
    void OKIM6295_sh_update(void) {}

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
