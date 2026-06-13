// =========================================================================
// HAL — implémentation native Mac/Linux
// Audio : PCM INT16 stéréo 44100Hz sur stdout
//   pipe : ./pinmame_native bonebstr 2>/dev/null | aplay -f S16_LE -r 44100 -c 2
//   macOS: ./pinmame_native bonebstr 2>/dev/null | ffplay -f s16le -ar 44100 -ac 2 -i pipe:0
// =========================================================================

#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <stdint.h>
typedef int64_t hal_cycles_t;
#include <alloca.h>

// DAC depuis api.cpp
extern "C" {
    int  api_get_dac_count(int c);
    int* api_get_dac_buffer(int c);
    void api_reset_dac_buffer(int c);
}

extern "C" {

hal_cycles_t hal_cycles(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (hal_cycles_t)ts.tv_sec * 1000000000LL + ts.tv_nsec;
}

hal_cycles_t hal_cycles_per_second(void) { return 1000000000LL; }

void hal_sleep_ms(int ms) { usleep((useconds_t)ms * 1000); }

void hal_osd_exit(void) { fprintf(stderr, "\n[PinMAME] osd_exit\n"); }

void hal_push_audio(uintptr_t ptr, int count, uint32_t gen) {
    (void)gen;
    if (!count) return;

    const int16_t* ym = (const int16_t*)ptr;
    const int n = count >> 1;  // nombre de paires stéréo

    // --- Mixage DAC (même logique que runtime-audio.js) ---
    static float dac_prev1 = 0.0f, dac_prev2 = 0.0f;
    static const float K1 = 3.0f/6, K2 = 2.0f/6, K3 = 1.0f/6;

    float* dac_mix = (float*)alloca(n * sizeof(float));
    memset(dac_mix, 0, n * sizeof(float));

    for (int c = 0; c < 2; c++) {
        int nd = api_get_dac_count(c);
        if (!nd) continue;
        int* db = api_get_dac_buffer(c);
        float sc = (float)nd / n;
        for (int i = 0; i < n; i++) {
            float idx  = i * sc;
            int   i0   = (int)idx;
            int   i1   = (i0 + 1 < nd) ? i0 + 1 : nd - 1;
            float frac = idx - i0;
            float raw  = (db[i0] * (1.0f - frac) + db[i1] * frac) / 65536.0f;
            float filt = raw * K1 + dac_prev1 * K2 + dac_prev2 * K3;
            dac_mix[i] += filt;
            dac_prev2 = dac_prev1;
            dac_prev1 = raw;
        }
        api_reset_dac_buffer(c);
    }

    // --- Mix YM2151 + DAC → INT16 stéréo sur stdout ---
    int16_t* out = (int16_t*)alloca(n * 2 * sizeof(int16_t));
    for (int i = 0; i < n; i++) {
        float ym_l = ym[i*2]   / 32768.0f;
        float ym_r = ym[i*2+1] / 32768.0f;
        float mix  = ((ym_l + ym_r) * 0.5f + dac_mix[i]) * 0.5f;
        // clamp
        if (mix >  1.0f) mix =  1.0f;
        if (mix < -1.0f) mix = -1.0f;
        int16_t s = (int16_t)(mix * 32767.0f);
        out[i*2]   = s;
        out[i*2+1] = s;
    }
    fwrite(out, sizeof(int16_t), n * 2, stdout);
    fflush(stdout);
}

void hal_push_display(uintptr_t ptr, uint32_t gen) {
    (void)ptr; (void)gen;
}

void hal_push_display_text(const char* text, uint32_t gen) {
    (void)gen;
    fprintf(stderr, "\r[VFD] %-40s", text);
    fflush(stderr);
}

void hal_push_lamps(uintptr_t ptr, uint32_t gen) {
    (void)ptr; (void)gen;
}

void hal_push_solens(uint32_t state, uint32_t gen) {
    (void)gen;
    fprintf(stderr, " [SOL] %08X\r", state);
}

void hal_post_machine_info(const char* info) {
    fprintf(stderr, "[MACHINE] %s\n", info);
}

void hal_post_log(uint32_t cmd, uint32_t gen) {
    (void)gen;
    fprintf(stderr, "[SND] cmd=0x%02X\n", (unsigned)cmd);
}

const char* hal_rompath(void) { return "./roms"; }

} // extern "C"
