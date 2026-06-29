// =========================================================================
// 🔌 INFRASTRUCTURE PINMAME WASM - PONT DE CONTROLE API C++
// 🏷️ VERSION : v3.204 — dump WAV : capture on-demand (au clic, pas au boot)
// =========================================================================

#include <iostream>
#include <cstdio>
#include <stdint.h>
#include <cstdlib>
#include <cstring>
#include <cstdarg>
// -------------------------------------------------------------------------
// HAL — code spécifique à la plateforme, inline ici
// -------------------------------------------------------------------------
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#include <chrono>

typedef int64_t hal_cycles_t;
static hal_cycles_t hal_cycles(void) {
    static auto t0 = std::chrono::steady_clock::now();
    return (hal_cycles_t)std::chrono::duration_cast<std::chrono::nanoseconds>(
        std::chrono::steady_clock::now() - t0).count();
}
static hal_cycles_t hal_cycles_per_second(void) { return 1000000000LL; }
static void hal_sleep_ms(int ms) { emscripten_sleep(ms); }
static void hal_osd_exit(void) {
    EM_ASM({ if (window.postWasmLog) window.postWasmLog("osd_exit called"); });
    EM_ASM({ throw new Error("PinMAME: emulation stopped"); });
}
static void hal_push_audio(uint32_t ptr, int count, uint32_t gen) {
    EM_ASM({ if (window.pushWasmAudio) window.pushWasmAudio($0, $1, $2); }, ptr, count, gen);
}
static void hal_push_display(uint32_t ptr, uint32_t gen) {
    EM_ASM({ if (window.pushWasmDisplay) window.pushWasmDisplay($0, $1); }, ptr, gen);
}
static void hal_push_display_text(const char* text, uint32_t gen) {
    EM_ASM({ if (window.pushWasmDisplayText) window.pushWasmDisplayText(UTF8ToString($0), $1); }, text, gen);
}
static void hal_push_lamps(uint32_t ptr, uint32_t gen) {
    EM_ASM({ if (window.pushWasmLamps) window.pushWasmLamps($0, $1); }, ptr, gen);
}
static void hal_push_solens(uint32_t state, uint32_t gen) {
    EM_ASM({ if (window.pushWasmSolens) window.pushWasmSolens($0, $1); }, state, gen);
}
static void hal_post_machine_info(const char* info) {
    EM_ASM({ if (window.postWasmMachineInfo) window.postWasmMachineInfo(UTF8ToString($0)); }, info);
}
static void hal_post_log(uint32_t cmd, uint32_t gen) {
    EM_ASM({ if (window.postWasmLog) window.postWasmLog($0, $1); }, cmd, gen);
}
static const char* hal_rompath(void) { return "/roms"; }

#else
// ESP32 / natif — fonctions fournies par esp32/hal_native.cpp ou esp32/hal_esp32.cpp
#include <stdint.h>
#ifdef ESP_PLATFORM
#include <math.h>
#endif
typedef int64_t hal_cycles_t;
extern "C" {
    hal_cycles_t hal_cycles(void);
    hal_cycles_t hal_cycles_per_second(void);
    void hal_sleep_ms(int ms);
    void hal_osd_exit(void);
    void hal_push_audio(uintptr_t ptr, int count, uint32_t gen);
    void hal_push_display(uintptr_t ptr, uint32_t gen);
    void hal_push_display_text(const char* text, uint32_t gen);
    void hal_push_lamps(uintptr_t ptr, uint32_t gen);
    void hal_push_solens(uint32_t state, uint32_t gen);
    void hal_post_machine_info(const char* info);
    void hal_post_log(uint32_t cmd, uint32_t gen);
    const char* hal_rompath(void);
}
#endif

#ifndef EMSCRIPTEN_KEEPALIVE
#define EMSCRIPTEN_KEEPALIVE __attribute__((used))
#endif

#ifndef __rolq
#define __rolq(x,c) (((unsigned long long)(x) << (c)) | ((unsigned long long)(x) >> (64 - (c))))
#endif
#ifndef __rorq
#define __rorq(x,c) (((unsigned long long)(x) >> (c)) | ((unsigned long long)(x) << (64 - (c))))
#endif

typedef uint8_t BMTYPE; 

extern "C" {
#include "driver.h"
#include "sound/ym2151.h"
#include "core.h"
#include "usrintrf.h"
#include "sound/samples.h"
#include "inptport.h" 
}

#define ABMAX 131072
// Sur ESP32 : synthèse à 6000Hz, puis 8× upsample (repeat) vers 48kHz UAC.
// Halving the sample rate halves the YM2151 work per frame → ~2× more FPS.
// Sur WASM/natif : 44100Hz pour la qualité maximale.
#ifdef ESP_PLATFORM
#define SPF   100    // 6000Hz → ring rempli par OPMUpdateOne (Core 1), upsample wall-clock dans audio_push_frame
#else
#define SPF   735    // 44100 / 60 fps
#endif
#define DMAX  4096

// PSRAM_BSS_ATTR : défini dans pinmame_config.h (ESP32) → .ext_ram.bss
// Vide sur natif/WASM → pas d'effet
#ifndef PSRAM_BSS_ATTR
#define PSRAM_BSS_ATTR
#endif

// Gros buffers : 256KB + 8KB + 32KB → PSRAM sur ESP32, SRAM sur natif/WASM
static PSRAM_BSS_ATTR INT16 g_ring[ABMAX];
static INT16 g_lin[DMAX];
static volatile int g_wi = 0, g_ri = 0;  // volatile : partagé Core 0 (prod) / Core 1 (cons)
static int   g_dac[2][DMAX], g_dn[2] = {};

extern "C" void stream_update(int, int);

// 1MB utilisé comme bitmap scratch + ui_bitmap → obligatoirement en PSRAM
static PSRAM_BSS_ATTR uint8_t g_dummy_buffer[1024 * 1024];
static uint8_t g_shared_corridor[4096] = {0};
static char g_display_text[100] = "Analyseur Global Actif";
// 40KB retourné par decodegfx() comme GfxElement factice → PSRAM
static PSRAM_BSS_ATTR uint32_t g_font_security_anchor[10000]; 
static int g_selected_game_index = 0;

// =========================================================================
// 🛰️ STRUCTURE ET TAMPON FIFO DU PROTOCOLE ASCII EXTRAIT
// =========================================================================
#define DISPLAY_QUEUE_MAX 512

struct DisplayEvent {
    uint8_t position;   // Adresse de la cellule (0 à 39)
    uint8_t ascii_char; // Code ASCII (7-bits ou combiné 8-bits ex: 0xB2)
    uint8_t action;     // 0 = WRITE, 1 = MOVE, 2 = CLEAR
};

static DisplayEvent g_display_queue[DISPLAY_QUEUE_MAX];
static int g_display_write_ptr = 0;
static int g_display_read_ptr = 0;
static uint8_t g_virtual_cursor = 0; // Registre de suivi de curseur Gottlieb

/**
 * Pousse un événement ASCII brut intercepté dans la file d'attente WebAssembly
 */
static void push_display_event(uint8_t pos, uint8_t ascii, uint8_t action) {
    int next_write = (g_display_write_ptr + 1) % DISPLAY_QUEUE_MAX;
    if (next_write == g_display_read_ptr) return; // Sécurité : file saturée, on drop
    
    g_display_queue[g_display_write_ptr].position = pos;
    g_display_queue[g_display_write_ptr].ascii_char = ascii;
    g_display_queue[g_display_write_ptr].action = action;
    g_display_write_ptr = next_write;
}

// NOP handlers for WASM table indices 29-31 that fall in the "unknown static" range
// (> STATIC_BANKMAX=24 but not RAM/ROM/RAMROM/NOP). These are needed because
// init_static() never initializes rmemhandler8[29] or wmemhandler8[30-31].
extern "C" data8_t api_nop_read8(offs_t address) { return 0; }
extern "C" void api_nop_write8(offs_t address, data8_t data) {}

// __wrap_run_machine is called instead of run_machine() via --wrap=run_machine.
// It installs safe handler stubs for entries 29-31 (which are "unused" in MAME
// but get populated by populate_memory with WASM table indices that land there)
// AFTER init_machine() has set up the tables, BEFORE the CPU starts executing.
extern "C" int __real_run_machine(void);
extern "C" int __wrap_run_machine(void) {
    memory_set_bankhandler_r(29, 0, api_nop_read8);
    memory_set_bankhandler_w(29, 0, api_nop_write8);
    memory_set_bankhandler_w(30, 0, api_nop_write8);
    return __real_run_machine();
}
extern "C" void sndbrd_0_data_w(int offset, int data);

extern "C" void libpinmame_log_error(const char* format, ...) {
    va_list args;
    va_start(args, format);
    vfprintf(stderr, format, args);
    va_end(args);
    std::cerr << std::endl;
}

// Override logerror so MAME's init errors appear in the console
extern "C" void logerror(const char* text, ...) {
    char buf[512];
    va_list args;
    va_start(args, text);
    vsnprintf(buf, sizeof(buf), text, args);
    va_end(args);
    fprintf(stderr, "[MAME] %s", buf);
}

// =========================================================================
// 🌟 2. PONT SYSTÈME OSD MAME 🌟
// =========================================================================
extern "C" {
    int run_game(int game_num);
    unsigned int cpunum_get_reg(int cpunum, int regnum);
    extern int bailing;
    extern struct osd_bitmap *scrbitmap;

    char build_version[] = "PinMAME-WASM-V195.06";
    int alpha_active = 0;
    int spriteram_size = 0;
    int spriteram_2_size = 0;
    uint8_t* buffered_spriteram = nullptr;
    uint8_t* buffered_spriteram_2 = nullptr;
    uint16_t* buffered_spriteram16 = nullptr;
    uint16_t* buffered_spriteram16_2 = nullptr;
    uint32_t* buffered_spriteram32 = nullptr;
    uint32_t* buffered_spriteram32_2 = nullptr;
    int hrud = 0; 
    UINT8 ui_dirty = 0; 
    int frameskip = 0;
    int he_did_cheat = 0;
    int g_low_latency_throttle = 0;
    struct Samplesinterface samples_interface;

    int pdrawgfx_shadow_lowpri = 0; 

    struct mame_bitmap *priority_bitmap = (struct mame_bitmap *)g_dummy_buffer; 
    char* rompath_extra = nullptr;  // initialisé à hal_rompath() au boot

    cycles_t osd_cycles(void)            { return (cycles_t)hal_cycles(); }
    cycles_t osd_cycles_per_second(void) { return (cycles_t)hal_cycles_per_second(); }
    
    int osd_init(void) { return 0; }
    void osd_exit(void) {
        hal_osd_exit();
    }
    void osd_pause(int paused) {}
    int osd_skip_this_frame(void) { return 0; }
    int osd_init_video(void) { return 0; }
    int osd_init_input(void) { return 0; }

    int osd_create_display(const struct osd_create_params *params, UINT32 *rgb_components) { return 0; }
    void osd_close_display(void) {}
    int osd_allocate_colors(unsigned int totalcolors, const UINT8 *palette, UINT32 *pens, int resettable) { return 0; }
    void osd_modify_pen(int pen, int red, int green, int blue) {}
    void osd_free_colors(void) {}
    int osd_display_loading_rom_message(const char *name, struct rom_load_data *romdata) { return 0; }
    
    struct GfxElement *builduifont(void) {
        // GfxElement factice avec colortable valide (4 slots pour pens 0-3)
        // palette_init() écrit colortable[0..3] — NULL causerait un SIGSEGV
        static pen_t g_ui_colortable[4] = {0, 1, 2, 3};
        static struct GfxElement g_uifont = {};
        if (!g_uifont.colortable) {
            g_uifont.colortable = g_ui_colortable;
            g_uifont.total_colors = 4;
            g_uifont.color_granularity = 4;
        }
        return &g_uifont;
    }
    struct osd_bitmap* artwork_get_ui_bitmap(void) { return (struct osd_bitmap*)g_dummy_buffer; }
    void init_user_interface(void) {} 

    void pic8259_0_config(int p1, int p2) {}
#ifndef ESP_PLATFORM
    int sem_timedwait(void* sem, const void* abs_timeout) { return 0; }
#endif
    void bulb_init(void) {}
    float bulb_heat_up_factor(int p1, float p2, float p3, float p4) { return 0.0f; }
    float bulb_filament_temperature_to_emission(int p1, float p2) { return 0.0f; }
    int hard_disk_open(int p1, int p2, int p3) { return 0; }
    int hard_disk_get_header(int p1) { return 0; }
    int hard_disk_create(int p1, int p2) { return 0; }
    void hard_disk_close_all(void) {}
    void hard_disk_set_interface(void *interface) {}

    int tilemap_init(void) { return 0; }
    void tilemap_close(void) {}
    void artwork_enable(int enable) {}
    int artwork_create_display(int p1, int p2, int p3) { return 0; }
    void set_vh_global_attribute(int attrib, int value) {}
    void freegfx(struct GfxElement *gfx) {}
    struct GfxElement *decodegfx(const unsigned char *src, const struct GfxLayout *gl) { return (struct GfxElement *)g_font_security_anchor; }
    
    int showcopyright(struct mame_bitmap *bitmap) { return 0; }
    int showgamewarnings(struct mame_bitmap *bitmap) { return 0; }
    int showgameinfo(struct mame_bitmap *bitmap) { return 0; }
    void InitCheat(void) {}
    void StopCheat(void) {}

    void osd_customize_inputport_defaults(struct ipd *defaults) {}
    void osd_analogjoy_read(int player, int analog_axis[MAX_ANALOG_AXES], InputCode analogjoy_input[MAX_ANALOG_AXES]) {}
    void osd_trak_read(int player, int *deltax, int *deltay) {}
    void osd_lightgun_read(int player, int *deltax, int *deltay) {}
    
    // Listes vides avec sentinelle {nullptr,0,0} — MAME itère dessus avec while(name)
    // Retourner nullptr causerait un SIGSEGV dans input.c:internal_oscode_find_keyboard
    static const struct KeyboardInfo g_empty_keylist[] = {{ nullptr, 0, 0 }};
    static const struct JoystickInfo g_empty_joylist[] = {{ nullptr, 0, 0 }};
    const struct KeyboardInfo *osd_get_key_list(void) { return g_empty_keylist; }
    const struct JoystickInfo *osd_get_joy_list(void) { return g_empty_joylist; }
    
    int osd_is_key_pressed(int keycode) { return 0; }
    int osd_is_joy_pressed(int joycode) { return 0; }
    int osd_is_joystick_axis_code(int p1) { return 0; }
    int rc_check_and_create_dir(const char *p1) { return 0; }
    int osd_readkey(void) { return 0; }

    void usrintf_showmessage(const char *text, ...) {}
    void alpha_init(void) {}
    int uistring_init(int lang) { return 0; }
    void uistring_shutdown(void) {}
    
    void i8259_init(int count) {}
    void hs_init(void) {}
    void hs_open(int p1) {}
    void hs_close(void) {}
    void hs_update(void) {} 

    void fillbitmap(struct mame_bitmap *dest, UINT32 pen, const struct rectangle *clip) {}
    void drawgfx(struct mame_bitmap *dest, const struct GfxElement *gfx, unsigned int code, unsigned int color, int flipx, int flipy, int destx, int desty, const struct rectangle *clip, int transparency, int transparent_color) {}
    void set_pixel_functions(struct mame_bitmap *bitmap) {}
    int handle_user_interface(struct mame_bitmap *bitmap) { return 0; }
    int artwork_load_artwork_file(void) { return 0; }
    void pic8259_0_issue_irq(int p1) {}
    void throttle_speed_part(int p1, int p2) {}

    int video_init(void) { return 0; }

    void* s11csIntf = nullptr;    void* wpcsIntf = nullptr;     void* dcsIntf = nullptr;      void* by32Intf = nullptr;
    void* by51Intf = nullptr;     void* s11jsIntf = nullptr;    void* by61Intf = nullptr;     
    void* by45Intf = nullptr;     void* byTCSIntf = nullptr;    void* bySDIntf = nullptr;     void* s67sIntf = nullptr;     
    void* s11sIntf = nullptr;     void* de2sIntf = nullptr;     void* de1sIntf = nullptr;     void* dedmd16Intf = nullptr;  
    void* dedmd32Intf = nullptr;  void* dedmd64Intf = nullptr;  void* hankinIntf = nullptr;   void* atari1sIntf = nullptr;  
    void* atari2sIntf = nullptr;  void* taitoIntf = nullptr;    void* zac1311Intf = nullptr;  void* zac1125Prf = nullptr;   void* zac1125Intf = nullptr;
    void* zac1346Intf = nullptr;  void* zac1370Intf = nullptr;  void* st100Intf = nullptr;    void* st300Intf = nullptr;    
    void* astroIntf = nullptr;    void* gpSSU1Intf = nullptr;   void* gpSSU2Intf = nullptr;   void* gpSSU4Intf = nullptr;   
    void* gpMSU1Intf = nullptr;   void* gpMSU3Intf = nullptr;   void* alvgs1Intf = nullptr;   void* alvgs2Intf = nullptr;   
    void* alvgdmdIntf = nullptr;  void* capcomsIntf = nullptr;  void* spinbIntf = nullptr;    void* mrgameIntf = nullptr;   
    void* de3sIntf = nullptr;     void* rowametIntf = nullptr;  void* nuovaIntf = nullptr;    void* grandIntf = nullptr;    
    void* jvhIntf = nullptr;      void* tabartIntf = nullptr;   void* jeutelIntf = nullptr;   void* play1sIntf = nullptr;   
    void* play2sIntf = nullptr;   void* play3sIntf = nullptr;   void* play4sIntf = nullptr;   void* zsuIntf = nullptr;      
    void* playzsIntf = nullptr;   void* tecnoplayIntf = nullptr; void* joctronicIntf = nullptr; void* barniIntf = nullptr;

    // =========================================================================
    // 🎯 3. LE RÉCEPTACLE DES INTERCEPTIONS ASCII (NATIVE HOOK)
    // =========================================================================
    EMSCRIPTEN_KEEPALIVE
    void api_hook_gottlieb_display_write(uint8_t data) {
        if (data == 0x01) { 
            g_virtual_cursor = 0;
            push_display_event(0, 0, 2); 
            return;
        }
        if (data >= 0x40 && data <= 0x53) { 
            g_virtual_cursor = data - 0x40;
            push_display_event(g_virtual_cursor, 0, 1); 
            return;
        }
        if (data >= 0x60 && data <= 0x73) { 
            g_virtual_cursor = (data - 0x60) + 20;
            push_display_event(g_virtual_cursor, 0, 1); 
            return;
        }
        if (data >= 0x20) { 
            push_display_event(g_virtual_cursor, data, 0); 
            g_virtual_cursor++;
            if (g_virtual_cursor >= 40) g_virtual_cursor = 0;
        }
    }

    EMSCRIPTEN_KEEPALIVE
    DisplayEvent* api_pop_ascii_event() {
        if (g_display_read_ptr == g_display_write_ptr) return nullptr;
        DisplayEvent* ev = &g_display_queue[g_display_read_ptr];
        g_display_read_ptr = (g_display_read_ptr + 1) % DISPLAY_QUEUE_MAX;
        return ev;
    }

    static int g_stereo = 1;
    int osd_start_audio_stream(int stereo) {
        g_stereo = stereo; return SPF;
    }

#ifdef ESP_PLATFORM
    #include "esp_log.h"
    #include "esp_timer.h"
    // BIT(x,n) de PinMAME/common.h entre en conflit avec BIT(x) d'ESP-IDF/xt_utils.h
    #pragma push_macro("BIT")
    #undef BIT
    #include "freertos/FreeRTOS.h"
    #include "freertos/task.h"
    #include "freertos/semphr.h"
    #pragma pop_macro("BIT")
    // Carte son GTS80B (gts80s.c) : nmi_callback() se réarme indéfiniment via
    // timer_set() et appelle cpu_boost_interleave(10us,800us) à chaque réarmement
    // -> c'est ça qui hache le scheduler (1378 appels/frame). On neutralise
    // systématiquement ce boost (le CPU audio tourne normalement par ailleurs,
    // il n'a pas besoin de ce boost d'interleave pour produire le son).
    extern "C" void __real_cpu_boost_interleave(double timeslice_time, double boost_duration);
    extern "C" void __wrap_cpu_boost_interleave(double timeslice_time, double boost_duration) {}

    static volatile bool     g_sound_enabled = true;
    static volatile int32_t  g_ym_irq_count  = 0;
    static volatile bool     g_ym2151_ready  = false;
    static void (*g_irq)(int, int) = nullptr;
    static volatile int32_t  g_bridge_s1 = 0;
    static volatile int32_t  g_bridge_s0 = 0;
    // Taux réel YM2151 = baseclock/64, capturé dans OPMInit (pas options.samplerate !).
    // 2151intf.c ligne 132 : rate = intf->baseclock/64. → indépendant de options.samplerate.
    static volatile int g_opm_sample_rate = 0;
    // Mutex YM2151 : sérialise YM2151UpdateOne (Core 0, synth_task) et
    // YM2151WriteReg (Core 1, emulation_task) pour éviter le data race SMP.
#ifdef ESP_PLATFORM
    static SemaphoreHandle_t g_ym_mutex = NULL;
#endif

    // Skip adaptatif cpu2/3 (DAC cards GTS80B) :
    // - NMI en attente → exécuter immédiatement (pas de skip)
    // - Pas de NMI → skip 87.5% pour économiser le CPU
    // Cela résout le deadlock de v3.182 : cpu1 envoie NMI à cpu2/3, cpu2/3
    // répondent immédiatement au lieu d'attendre leur prochain tour skippé.
    static volatile int32_t g_nmi_pending[4] = {};
    static volatile int32_t g_nmi_pm_total = 0; // cumulatif NMIs reçus par cpu1
    static volatile int32_t g_irq_hold_cpu1 = 0; // HOLD_LINE IRQ0 cpu1 (soundlatches)
    static volatile bool    g_attract_started = false; // vrai après soundlatch 0xe4
    static uint8_t          g_cpu0_skip = 0;
    static uint8_t          g_cpu23_skip = 0; // skip 87.5% quand pas de NMI en attente

    // v3.174 : wrapper YM2151_word_0_w pour tracer les writes de cpu1 vers le YM2151.
    // Diagnostic clé : si jamais appelé → cpu1 ne programme pas le YM2151.
    extern "C" void __real_YM2151_word_0_w(unsigned int offset, unsigned char data);
    extern "C" void __wrap_YM2151_word_0_w(unsigned int offset, unsigned char data) {
        static int32_t g_ym_wc = 0;
        int32_t n = ++g_ym_wc;
        if (n <= 30 || (n % 500) == 0)
            ESP_LOGE("YM2151", "write #%ld port=%d data=0x%02x hold_cpu1=%ld nmi_total=%ld",
                     (long)n, (int)offset, (int)data, (long)g_irq_hold_cpu1, (long)g_nmi_pm_total);
        __real_YM2151_word_0_w(offset, data);
    }

    // v3.174 : wrapper soundlatch_w pour tracer les commandes cpu0→cpu1.
    extern "C" void __real_soundlatch_w(int offset, int data);
    extern "C" void __wrap_soundlatch_w(int offset, int data) {
        static int32_t g_sl = 0;
        int32_t n = ++g_sl;
        if (n <= 20)
            ESP_LOGE("SLATCH", "soundlatch_w #%ld data=0x%02x hold_cpu1=%ld",
                     (long)n, (unsigned)data & 0xff, (long)g_irq_hold_cpu1);
        // 0xe4 = commande "musique attract" → activer le skip cpu0 (50%)
        if (((unsigned)data & 0xff) == 0xe4)
            g_attract_started = true;
        __real_soundlatch_w(offset, data);
    }

    extern "C" void __real_cpu_set_irq_line(int cpu_num, int irq_line, int state);

    // Wrapper m6502_execute
    extern "C" int __real_m6502_execute(int cycles);
    extern "C" int cpu_getactivecpu(void);
    extern "C" int __wrap_m6502_execute(int cycles) {
        const int cpu = cpu_getactivecpu();
        // cpu0 : pleine vitesse jusqu'à la commande "musique attract" (0xe4).
        // Après 0xe4 : skip 50% (& 1) → FPS ≈ 59fps → NMI ≈ 961/s ≈ 976Hz correct.
        // Déclenché par 0xe4 dans __wrap_soundlatch_w, pas par hold_cpu1 (pollué YM IRQ).
        if (cpu == 0 && g_attract_started) {
            if ((++g_cpu0_skip & 1) != 0) return cycles;
        }

        // cpu2/3 (DAC cards) : exécuter UNIQUEMENT sur NMI (s80bs_cause_dac_nmi_w).
        // Sans NMI : skip 100% (return cycles). Le scheduler MAME avance normalement
        // mais les cpu2/3 n'écrivent rien au DAC → zéro son parasite.
        // Sans ce skip, la boucle d'attente des cpu2/3 génère du bruit DAC aléatoire.
        if (cpu == 2 || cpu == 3) {
            if (g_nmi_pending[cpu] > 0) {
                __atomic_sub_fetch(&g_nmi_pending[cpu], 1, __ATOMIC_RELAXED);
            } else {
                return cycles;
            }
        }

        static int64_t s_in_us = 0, s_in_cycles = 0;
        static int64_t s_out_us = 0;
        static int64_t s_last_exit_us = 0;
        static int64_t s_report_t0 = 0;
        static int64_t s_call_count = 0;
        static int64_t s_irq_delivered = 0;

        if (g_ym_irq_count > 0 && g_irq && cpu > 0) {
            __atomic_sub_fetch(&g_ym_irq_count, 1, __ATOMIC_RELAXED);
            g_irq(0, 1);  // IRQHandler(chip=0, state=ASSERT=1) → ym2151_irq(1) → cpu1 IRQ0
            s_irq_delivered++;
        }

        int64_t enter_us = esp_timer_get_time();
        if (s_last_exit_us > 0)
            s_out_us += enter_us - s_last_exit_us;

        int ret = __real_m6502_execute(cycles);

        int64_t exit_us = esp_timer_get_time();
        s_in_us     += exit_us - enter_us;
        s_in_cycles += cycles;
        s_call_count++;
        s_last_exit_us = exit_us;

        if (exit_us - s_report_t0 >= 3000000LL) {
            int64_t esp_in  = s_in_cycles > 0 ? (s_in_us  * 240LL / s_in_cycles)  : 0;
            int64_t avg_cyc = s_call_count > 0 ? s_in_cycles / s_call_count : 0;
            int32_t hold = (int32_t)g_irq_hold_cpu1;
            int32_t bs1 = __atomic_exchange_n(&g_bridge_s1, 0, __ATOMIC_RELAXED);
            int32_t bs0 = __atomic_exchange_n(&g_bridge_s0, 0, __ATOMIC_RELAXED);
            ESP_LOGE("M6502", "cpu=%d cyc=%lld calls=%lld avg_cyc/call=%lld in_ms=%lld out_ms=%lld esp/cyc_in=%lld irq_del=%lld nmi_total=%ld hold_cpu1=%ld nmi_p2=%ld nmi_p3=%ld ym_tmr_fire=%ld ym_tmr_clr=%ld",
                cpu,
                (long long)s_in_cycles, (long long)s_call_count, (long long)avg_cyc,
                (long long)(s_in_us/1000), (long long)(s_out_us/1000),
                (long long)esp_in, (long long)s_irq_delivered,
                (long)g_nmi_pm_total, (long)hold,
                (long)g_nmi_pending[2], (long)g_nmi_pending[3],
                (long)bs1, (long)bs0);
            s_in_us = 0; s_in_cycles = 0; s_out_us = 0; s_call_count = 0; s_irq_delivered = 0;
            s_report_t0 = exit_us;
        }
        return ret;
    }

    // NMIs cpu1 et cpu2/3 tous débloqués.
    // cpu2/3 : g_nmi_pending[] permet le skip adaptatif dans __wrap_m6502_execute.
    extern "C" void __wrap_cpu_set_irq_line(int cpu_num, int irq_line, int state) {
        // HOLD_LINE=2 = soundlatch, ASSERT_LINE=1 = IRQ YM2151 timer (très fréquente).
        // Compter uniquement les soundlatches (state==2) sinon hold_cpu1 monte en ms.
        if (cpu_num == 1 && irq_line == 0 && state == 2)
            __atomic_add_fetch(&g_irq_hold_cpu1, 1, __ATOMIC_RELAXED);
        if (irq_line == 127 && state == 3) {
            if (cpu_num == 1)
                __atomic_add_fetch(&g_nmi_pm_total, 1, __ATOMIC_RELAXED);
            else if (cpu_num == 2 || cpu_num == 3)
                __atomic_add_fetch(&g_nmi_pending[cpu_num], 1, __ATOMIC_RELAXED);
        }
        __real_cpu_set_irq_line(cpu_num, irq_line, state);
    }

    // Impose un minimum de timeslice pour éviter l'overhead des milliers d'appels
    // à cpu_timeslice() par seconde (avg=160µs, min=0µs par perte de précision float).
    // 1ms → ~600 appels/s (÷6 baseline). Timeslice plus grand n'aide pas car les
    // callbacks audio (YM2151, DAC) dominent le out_ms indépendamment de la taille.
    static constexpr double MIN_TIMESLICE_S = 0.001;  // 1ms = 2000 cycles @ 2MHz

    extern "C" double __real_timer_time_until_next_timer(void);
    extern "C" double __wrap_timer_time_until_next_timer(void) {
        double t = __real_timer_time_until_next_timer();
        static double  s_min = 1.0, s_sum = 0.0;
        static int64_t s_count = 0, s_last = 0;
        if (t < s_min) s_min = t;
        s_sum += t;
        s_count++;
        int64_t now = esp_timer_get_time();
        if (now - s_last >= 3000000LL) {
            double avg_us = s_count > 0 ? s_sum / s_count * 1e6 : 0.0;
            ESP_LOGE("TMR", "calls=%lld min_us=%.1f avg_us=%.1f",
                (long long)s_count, s_min * 1e6, avg_us);
            s_min = 1.0; s_sum = 0.0; s_count = 0; s_last = now;
        }
        return t < MIN_TIMESLICE_S ? MIN_TIMESLICE_S : t;
    }

#endif

    int osd_update_audio_stream(INT16 *b) {
        if (g_stereo) {
            for (int i = 0; i < SPF * 2; i++) { g_ring[g_wi] = b[i]; g_wi = (g_wi + 1) % ABMAX; }
        } else {
            for (int i = 0; i < SPF; i++) {
                g_ring[g_wi] = b[i]; g_wi = (g_wi + 1) % ABMAX;
                g_ring[g_wi] = b[i]; g_wi = (g_wi + 1) % ABMAX;
            }
        }
        return SPF;
    }
    void osd_stop_audio_stream() {}
    void osd_sound_enable(int) {}
    int  osd_init_sound() { return 1; } // son désactivé (pas de casque UAC connecté)
    void proc_mechsounds(int, int) {}
    int  YM2203_sh_start(const struct MachineSound *) { return 0; }
    void YM2203_sh_stop() {} void YM2203_sh_reset() {}
    int  OKIM6295_sh_start(const struct MachineSound *) { return 0; }
    void OKIM6295_sh_stop() {} void OKIM6295_sh_update() {}

    void audio_push_frame(uint32_t gen) {
#ifdef ESP_PLATFORM
        (void)gen;
        g_dn[0] = g_dn[1] = 0;

        // Throttle emulation_task à exactement 60fps (16667µs/frame) avec phase-lock.
        // esp_timer donne la précision µs ; vTaskDelay libère Core 1 pendant l'attente.
        // Quand un frame dépasse 16.667ms (émulation trop lourde), on ne dort pas :
        // s_next_us reste en avance et la dette se résorbe automatiquement sur les frames suivants.
        // Si le retard dépasse 2 frames (>33ms), on réancre pour éviter un spiral-down.
        static int64_t s_next_us = 0;
        int64_t now_us = esp_timer_get_time();
        if (s_next_us == 0) { s_next_us = now_us + 16667; return; }
        int64_t wait_us = s_next_us - now_us;
        if (wait_us > 1000) {
            vTaskDelay(pdMS_TO_TICKS((wait_us + 500) / 1000));
        }
        s_next_us += 16667;
        if (s_next_us < esp_timer_get_time() - 33334) {
            s_next_us = esp_timer_get_time() + 16667;
        }
#else
        int n = (g_wi - g_ri + ABMAX) % ABMAX;
        if (!n) return;
        if (n > DMAX) n = DMAX;
        for (int i = 0; i < n; i++) { g_lin[i] = g_ring[g_ri]; g_ri = (g_ri + 1) % ABMAX; }
        hal_push_audio((uintptr_t)g_lin, n, gen);
#endif
    }

    // irq_bridge : appelé par le YM2151 dans deux contextes distincts.
    //   s=1 : timer overflow depuis synth_task (Core 0) → queue l'ASSERT pour Core 1
    //   s=0 : flag effacé par YM2151WriteReg (Core 1, inside CPU IRQ handler)
    //          → livre le CLEAR immédiatement (on est déjà sur Core 1)
    // Sans ce CLEAR, la ligne IRQ reste assertée → le 6808 reboucle en permanence
    // dans son handler → musique figée → son de plus en plus lent.
#ifdef ESP_PLATFORM
    static void IRAM_ATTR irq_bridge(int s) {
        if (s) {
            __atomic_add_fetch(&g_ym_irq_count, 1, __ATOMIC_RELAXED);
            __atomic_add_fetch(&g_bridge_s1, 1, __ATOMIC_RELAXED);
        } else {
            __atomic_add_fetch(&g_bridge_s0, 1, __ATOMIC_RELAXED);
            if (g_irq) g_irq(0, 0); // CLEAR sur Core 1 : safe (YM2151WriteReg l'appelle)
        }
    }
#endif
    int OPMInit(int n, int c, int r, void (*)(int,int,int,double), void (*ih)(int,int)) {
#ifdef ESP_PLATFORM
        g_irq = ih;
        g_opm_sample_rate = r;  // baseclock/64 = taux réel UpdateOne (≈62500 pour GTS80B)
        if (!g_ym_mutex) g_ym_mutex = xSemaphoreCreateMutex();
        ESP_LOGE("OPM", "OPMInit n=%d clock=%d rate=%d g_irq=%s", n, c, r, ih ? "NON-NULL" : "NULL");
        int res = YM2151Init(n,(double)c,(double)r); YM2151SetIrqHandler(n,irq_bridge);
        g_ym2151_ready = true;
#else
        int res = YM2151Init(n,(double)c,(double)r);
#endif
        return res;
    }

    void OPMShutdown() { YM2151Shutdown(); }
    void OPMResetChip(int n) { YM2151ResetChip(n); }
    void OPMUpdateOne(int n, INT16 **b, int l) {
#ifdef ESP_PLATFORM
        (void)n; (void)b; (void)l; // synth_task (Core 0) avance le YM2151
#else
        YM2151UpdateOne(n, b, l);
#endif
    }
    void OPMSetPortHander(int, void (*)(unsigned, unsigned char)) {}
    int  YM2151TimerOver(int, int) { return 0; }
    static int g_reg = 0;
    void YM2151_register_port_0_w(offs_t, data8_t d) { g_reg = d; }
    void YM2151_data_port_0_w(offs_t, data8_t d) {
#ifndef ESP_PLATFORM
        for (int i = 0; i < 4; i++) stream_update(i, 0);
#endif
        // Pas de mutex : UpdateOne (Core 0) dure ~6ms → bloquerait emulation_task.
        // Race bénigne : au pire 1-2 samples corrompus lors d'un changement de note.
        YM2151WriteReg(0, g_reg, d);
    }
    EMSCRIPTEN_KEEPALIVE int  api_get_dac_count(int c)   { return (unsigned)c < 2 ? g_dn[c] : 0; }
    EMSCRIPTEN_KEEPALIVE int* api_get_dac_buffer(int c)   { return (unsigned)c < 2 ? g_dac[c] : nullptr; }
    EMSCRIPTEN_KEEPALIVE void api_reset_dac_buffer(int c) { if ((unsigned)c < 2) g_dn[c] = 0; }

    void artwork_update_video_and_audio(struct mame_display *display) {
        static uint16_t prev_segments[40] = {};
        static uint8_t  prev_lamps[12]    = {};
        static uint32_t prev_solenoids    = 0xFFFFFFFF;
        static bool     machine_info_posted = false;

#ifdef ESP_PLATFORM
        // Compteur FPS + mesure temps frame total vs temps callback
        static int64_t fps_t0 = 0;
        static int fps_count = 0;
        static int64_t s_last_frame_us = 0;
        static int64_t s_cb_us = 0, s_emu_us = 0, s_frame_count = 0;
        int64_t cb_enter_us = esp_timer_get_time();
        if (s_last_frame_us > 0)
            s_emu_us += cb_enter_us - s_last_frame_us;  // temps pur emulation entre 2 callbacks
        s_frame_count++;
        int64_t now_us = hal_cycles() / 1000LL;
        fps_count++;
        if (now_us - fps_t0 >= 5000000LL) {
            float fps = fps_count * 1000000.0f / (float)(now_us - fps_t0);
            extern void esp_loge_fps(float fps);
            esp_loge_fps(fps);
            fps_t0 = now_us;
            fps_count = 0;
        }

        // Diagnostic temporaire : cycles cumulés par CPU, pour savoir si le CPU
        // son (souvent CPU_AUDIO_CPU, ex. celui qui pilote DAC+YM2151 sur GTS80B)
        // progresse réellement ou reste figé (bug "aucun son").
        {
            static int64_t s_last_cyc_log_us = 0;
            static UINT64 s_last_cycles[MAX_CPU] = {0};
            if (now_us - s_last_cyc_log_us >= 3000000LL) {
                s_last_cyc_log_us = now_us;
                if (Machine && Machine->drv) {
                    char line[160];
                    int off = 0;
                    for (int i = 0; i < MAX_CPU; i++) {
                        if (!Machine->drv->cpu[i].cpu_type) break;
                        UINT64 c = cpunum_gettotalcycles64(i);
                        UINT64 d = c - s_last_cycles[i];
                        s_last_cycles[i] = c;
                        bool audio = (Machine->drv->cpu[i].cpu_flags & CPU_AUDIO_CPU) != 0;
                        off += snprintf(line + off, sizeof(line) - off, "cpu%d%s=%llu ", i, audio ? "(audio)" : "", (unsigned long long)d);
                    }
                    ESP_LOGE("CPUCYC", "%s", line);
                }
            }
        }
#endif

#ifndef ESP_PLATFORM
        {
            static int wasm_frame_count = 0;
            static double wasm_fps_t0 = -1.0;
            wasm_frame_count++;
            double now_ms = emscripten_get_now();
            if (wasm_fps_t0 < 0) wasm_fps_t0 = now_ms;
            if (now_ms - wasm_fps_t0 >= 5000.0) {
                double fps = wasm_frame_count * 1000.0 / (now_ms - wasm_fps_t0);
                EM_ASM({ if (window.postWasmFps) window.postWasmFps($0); }, fps);
                wasm_frame_count = 0;
                wasm_fps_t0 = now_ms;
            }
        }
#endif

        // Generation written by JS at boot (slot 1076). Passed to every callback so JS
        // can reject calls from stale Wasm instances that are still looping after ROM change.
        uint32_t emulator_generation = 0;
        memcpy(&emulator_generation, &g_shared_corridor[1076], 4);

        // Post full machine info once on first frame: CPUs + sound chips + stereo + rate.
        if (!machine_info_posted && Machine && Machine->drv) {
            machine_info_posted = true;
            char info[512] = {0};
            int len = 0;

            // ROM name (pour handleStatusLine côté browser)
            const char* rom_name_st = (const char*)&g_shared_corridor[1000];
            if (rom_name_st[0])
                len += snprintf(info + len, sizeof(info) - len, "rom=%s&", rom_name_st);

            // CPUs
            len += snprintf(info + len, sizeof(info) - len, "cpu=");
            bool first_cpu = true;
            for (int i = 0; i < MAX_CPU; i++) {
                if (!Machine->drv->cpu[i].cpu_type) break;
                const char* cname = cputype_name(Machine->drv->cpu[i].cpu_type);
                int clk = Machine->drv->cpu[i].cpu_clock;
                bool audio = (Machine->drv->cpu[i].cpu_flags & CPU_AUDIO_CPU) != 0;
                char clk_str[16];
                if (clk >= 1000000) snprintf(clk_str, sizeof(clk_str), "%dMHz", clk / 1000000);
                else                snprintf(clk_str, sizeof(clk_str), "%dkHz", clk / 1000);
                len += snprintf(info + len, sizeof(info) - len, "%s%s@%s%s",
                    first_cpu ? "" : "+", cname ? cname : "?", clk_str, audio ? "(audio)" : "");
                first_cpu = false;
            }

            // Sound chips
            len += snprintf(info + len, sizeof(info) - len, "|snd=");
            bool first_snd = true;
            char chip_list[128] = {0};
            int clen = 0;
            for (int i = 0; i < MAX_SOUND; i++) {
                if (!Machine->drv->sound[i].sound_type) break;
                const char* sname = sound_name(&Machine->drv->sound[i]);
                if (!sname) sname = "?";
                len += snprintf(info + len, sizeof(info) - len, "%s%s", first_snd ? "" : "+", sname);
                // also build chip_list for legacy postWasmSoundChips
                if (!first_snd && clen < (int)sizeof(chip_list) - 3) { chip_list[clen++] = ','; chip_list[clen++] = ' '; }
                for (int k = 0; sname[k] && clen < (int)sizeof(chip_list) - 1; k++) chip_list[clen++] = sname[k];
                first_snd = false;
            }

            // Stereo + rate
            len += snprintf(info + len, sizeof(info) - len, "|stereo=%d|rate=%d", g_stereo, options.samplerate);

            // Type d'afficheur Gottlieb
            if (core_gameData) {
                const char* dsp = (core_gameData->gen & GEN_GTS80B) ? "80B" : "80";
                len += snprintf(info + len, sizeof(info) - len, "|dsp=%s", dsp);
            }

            hal_post_machine_info(info);
        }

        uint16_t* vfd_export = (uint16_t*)g_shared_corridor;
        for (int i = 0; i < 20; i++) {
            vfd_export[i]      = coreGlobals.segments[i].w & 0xFFFF;
            vfd_export[20 + i] = coreGlobals.segments[20 + i].w & 0xFFFF;
        }
        if (memcmp(prev_segments, vfd_export, 40 * sizeof(uint16_t)) != 0) {
            memcpy(prev_segments, vfd_export, 40 * sizeof(uint16_t));
            hal_push_display((uintptr_t)g_shared_corridor, emulator_generation);
            // Decode segments → ASCII text via core_ascii2seg16 reverse scan
            char display_text[41];
            for (int i = 0; i < 40; i++) {
                uint16_t seg = coreGlobals.segments[i].w & 0xFFFF;
                display_text[i] = ' ';
                if (seg != 0) {
                    for (int c = 0x20; c < 0x80; c++) {
                        if (core_ascii2seg16[c] == seg) { display_text[i] = (char)c; break; }
                    }
                }
            }
            display_text[40] = '\0';
            hal_push_display_text(display_text, emulator_generation);
        }

        for (int sw = 0; sw < 80; sw++) { core_setSw(sw, g_shared_corridor[100 + sw]); }

        if (Machine && Machine->input_ports) {
            struct InputPort *port = Machine->input_ports;
            int current_dip_index = 0;
            while (port->type != IPT_END && current_dip_index < 32) {
                if (port->type == IPT_DIPSWITCH_NAME) {
                    port->default_value = g_shared_corridor[400 + current_dip_index]
                                          ? port->mask : 0;
                    current_dip_index++;
                }
                port++;
            }
        }

        for (int b = 0; b < 10; b++) { g_shared_corridor[200 + b] = coreGlobals.swMatrix[b]; }
        for (int l = 0; l < 12; l++) { g_shared_corridor[300 + l] = coreGlobals.lampMatrix[l]; }
        if (memcmp(prev_lamps, (const void*)coreGlobals.lampMatrix, 12) != 0) {
            memcpy(prev_lamps, (const void*)coreGlobals.lampMatrix, 12);
            hal_push_lamps((uintptr_t)(g_shared_corridor + 300), emulator_generation);
        }

        uint32_t solenoids_state = coreGlobals.solenoids;
        if (solenoids_state != prev_solenoids) {
            prev_solenoids = solenoids_state;
            hal_push_solens(solenoids_state, emulator_generation);
        }

        uint8_t sound_user_cmd = g_shared_corridor[1060];
        if (sound_user_cmd > 0) {
            g_shared_corridor[1060] = 0;
            sndbrd_0_data_w(0, sound_user_cmd);
            hal_post_log(sound_user_cmd, emulator_generation);
        }

#ifdef ESP_PLATFORM
        g_sound_enabled = (g_shared_corridor[1061] == 0);
#endif

        audio_push_frame(emulator_generation);

#ifdef ESP_PLATFORM
        {
            int64_t cb_exit_us = esp_timer_get_time();
            s_cb_us += cb_exit_us - cb_enter_us;
            s_last_frame_us = cb_exit_us;
            if (s_frame_count >= 20) {
                ESP_LOGE("FRAME", "frames=%lld emu_ms=%lld cb_ms=%lld emu%%=%lld",
                    (long long)s_frame_count,
                    (long long)(s_emu_us/1000), (long long)(s_cb_us/1000),
                    s_emu_us ? (long long)(s_emu_us*100/(s_emu_us+s_cb_us)) : 0);
                s_emu_us = 0; s_cb_us = 0; s_frame_count = 0;
            }
        }
#endif

#ifndef ESP_PLATFORM
        uint32_t js_buffer_dist = 0;
        memcpy(&js_buffer_dist, &g_shared_corridor[1070], 4);
        hal_sleep_ms(8 + js_buffer_dist / 512);
#endif
    }

    void osd_update_video_and_audio(struct mame_display *display) {
        artwork_update_video_and_audio(display);
    }

    // =========================================================================
    // 🎯 4. EXPORTS MAME VERS WEBASSEMBLY (VERROUILLAGE KEEPALIVE COMPLET)
    // =========================================================================
    
    EMSCRIPTEN_KEEPALIVE
    uint8_t* pinmame_get_gprom_ptr() { return g_shared_corridor; }
    
    EMSCRIPTEN_KEEPALIVE
    uint8_t* pinmame_get_dsprom_ptr() { return g_shared_corridor; } 
    
    EMSCRIPTEN_KEEPALIVE
    const char* pinmame_get_display() { return g_display_text; }
    
    EMSCRIPTEN_KEEPALIVE
    const char* pinmame_get_version() { return "PinMAME Pure Native Link V195.06"; }
    
    EMSCRIPTEN_KEEPALIVE
    void pinmame_web_entry(int gprom_size, int dsprom_size) {}
    
    EMSCRIPTEN_KEEPALIVE
    void pinmame_web_tick(int cycles) {}

    // ── driver_0 : racine factice requise par clone_of dans les GameDrivers ──
    // Sans const : linkage externe en C++ (const namespace = interne par défaut)
    // Sur ESP32, driver_0 est fourni par driver0_native.c — pas ici.
#ifndef ESP_PLATFORM
    __attribute__((used)) struct GameDriver driver_0 = {
        __FILE__, 0, "", 0, 0, 0, 0, 0, 0, 0, 0, 0x4000 /* NOT_A_DRIVER */
    };
#endif

    // ── Drivers Gottlieb System 80B ─────────────────────────────────────────
    // Chicago Cubs Triple Play (#696)
    extern struct GameDriver driver_triplay;
    extern struct GameDriver driver_triplyfp;
    extern struct GameDriver driver_triplaya;
    extern struct GameDriver driver_triplyf1;
    extern struct GameDriver driver_triplayg;
    extern struct GameDriver driver_triplgfp;
    // Bounty Hunter (#694)
    extern struct GameDriver driver_bountyh;
    extern struct GameDriver driver_bounthfp;
    extern struct GameDriver driver_bountyhg;
    extern struct GameDriver driver_bountgfp;
    // Tag-Team Pinball (#698)
    extern struct GameDriver driver_tagteam;
    extern struct GameDriver driver_tagtemfp;
    extern struct GameDriver driver_tagteamg;
    extern struct GameDriver driver_tagtmgfp;
    extern struct GameDriver driver_tagteam2;
    extern struct GameDriver driver_tagtem2f;
    // Rock (#697)
    extern struct GameDriver driver_rock;
    extern struct GameDriver driver_rockfp;
    extern struct GameDriver driver_rockg;
    extern struct GameDriver driver_rockgfp;
    // S80B Test Fixture
    extern struct GameDriver driver_s80btest;
    // Raven (#702)
    extern struct GameDriver driver_raven;
    extern struct GameDriver driver_ravenfp;
    extern struct GameDriver driver_raveng;
    extern struct GameDriver driver_ravengfp;
    extern struct GameDriver driver_ravena;
    extern struct GameDriver driver_ravenafp;
    extern struct GameDriver driver_rambo;
    // Rock Encore (#704)
    extern struct GameDriver driver_rock_enc;
    extern struct GameDriver driver_rock_efp;
    extern struct GameDriver driver_rock_eg;
    extern struct GameDriver driver_rockegfp;
    extern struct GameDriver driver_clash;
    // Hollywood Heat (#703)
    extern struct GameDriver driver_hlywoodh;
    extern struct GameDriver driver_hlywdhfp;
    extern struct GameDriver driver_hlywodhg;
    extern struct GameDriver driver_hlywhgfp;
    extern struct GameDriver driver_hlywodhf;
    extern struct GameDriver driver_hlywhffp;
    extern struct GameDriver driver_bubba;
    extern struct GameDriver driver_beachbms;
    extern struct GameDriver driver_tomjerry;
    // Genesis (#705)
    extern struct GameDriver driver_genesis;
    extern struct GameDriver driver_genesifp;
    extern struct GameDriver driver_genesisg;
    extern struct GameDriver driver_genesgfp;
    extern struct GameDriver driver_genesisf;
    extern struct GameDriver driver_genesffp;
    // Gold Wings (#707)
    extern struct GameDriver driver_goldwing;
    extern struct GameDriver driver_goldwgfp;
    extern struct GameDriver driver_gldwingg;
    extern struct GameDriver driver_gldwggfp;
    extern struct GameDriver driver_gldwingf;
    extern struct GameDriver driver_gldwgffp;
    // Monte Carlo (#708)
    extern struct GameDriver driver_mntecrlo;
    extern struct GameDriver driver_mntecrfp;
    extern struct GameDriver driver_mntecrlga;
    extern struct GameDriver driver_mntecrlg;
    extern struct GameDriver driver_mntcrgfp;
    extern struct GameDriver driver_mntcrgmfp;
    extern struct GameDriver driver_mntecrlf;
    extern struct GameDriver driver_mntcrffp;
    extern struct GameDriver driver_mntcrfmfp;
    extern struct GameDriver driver_mntecrla;
    extern struct GameDriver driver_mntcrafp;
    extern struct GameDriver driver_mntecrl2;
    extern struct GameDriver driver_mntcr2fp;
    extern struct GameDriver driver_mntcrmfp;
    // Spring Break (#706)
    extern struct GameDriver driver_sprbreak;
    extern struct GameDriver driver_sprbrkfp;
    extern struct GameDriver driver_sprbrkg;
    extern struct GameDriver driver_sprbrgfp;
    extern struct GameDriver driver_sprbrkf;
    extern struct GameDriver driver_sprbrffp;
    extern struct GameDriver driver_sprbrka;
    extern struct GameDriver driver_sprbrafp;
    extern struct GameDriver driver_sprbrks;
    extern struct GameDriver driver_sprbrsfp;
    // Amazon Hunt II (#684C)
    extern struct GameDriver driver_amazonh2;
    extern struct GameDriver driver_amazn2fp;
    // Arena (#709)
    extern struct GameDriver driver_arena;
    extern struct GameDriver driver_arena_fp;
    extern struct GameDriver driver_arenag;
    extern struct GameDriver driver_arenagfp;
    extern struct GameDriver driver_arenaf;
    extern struct GameDriver driver_arenaffp;
    extern struct GameDriver driver_arenaa;
    extern struct GameDriver driver_arenaafp;
    extern struct GameDriver driver_arena2;
    // Victory (#710)
    extern struct GameDriver driver_victory;
    extern struct GameDriver driver_victryfp;
    extern struct GameDriver driver_victoryg;
    extern struct GameDriver driver_victrgfp;
    extern struct GameDriver driver_victoryf;
    extern struct GameDriver driver_victrffp;
    extern struct GameDriver driver_victr101;
    extern struct GameDriver driver_victr11;
    extern struct GameDriver driver_victr12;
    extern struct GameDriver driver_victr13;
    // Diamond Lady (#711)
    extern struct GameDriver driver_diamond;
    extern struct GameDriver driver_diamonfp;
    extern struct GameDriver driver_diamondg;
    extern struct GameDriver driver_diamngfp;
    extern struct GameDriver driver_diamondf;
    extern struct GameDriver driver_diamnffp;
    // TX-Sector (#712)
    extern struct GameDriver driver_txsector;
    extern struct GameDriver driver_txsectfp;
    extern struct GameDriver driver_txsectrg;
    extern struct GameDriver driver_txsecgfp;
    extern struct GameDriver driver_txsectrf;
    extern struct GameDriver driver_txsecffp;
    // Robo-War (#714)
    extern struct GameDriver driver_robowars;
    extern struct GameDriver driver_robowrfp;
    extern struct GameDriver driver_robowarf;
    extern struct GameDriver driver_robowffp;
    // Bad Girls (#717)
    extern struct GameDriver driver_badgirls;
    extern struct GameDriver driver_badgirl2;
    extern struct GameDriver driver_badgrlfp;
    extern struct GameDriver driver_badgirlg;
    extern struct GameDriver driver_badgrgfp;
    extern struct GameDriver driver_badgirlf;
    extern struct GameDriver driver_badgrffp;
    // Excalibur (#715)
    extern struct GameDriver driver_excaliba;
    extern struct GameDriver driver_excalbfp;
    extern struct GameDriver driver_excalibg;
    extern struct GameDriver driver_excalgfp;
    extern struct GameDriver driver_excalibr;
    extern struct GameDriver driver_excalffp;
    // Big House (#713)
    extern struct GameDriver driver_bighouse;
    extern struct GameDriver driver_bighosfp;
    extern struct GameDriver driver_bighousg;
    extern struct GameDriver driver_bighsgfp;
    extern struct GameDriver driver_bighousf;
    extern struct GameDriver driver_bighsffp;
    // Hot Shots (#718)
    extern struct GameDriver driver_hotshots;
    extern struct GameDriver driver_hotshtfp;
    extern struct GameDriver driver_hotshotg;
    extern struct GameDriver driver_hotshgfp;
    extern struct GameDriver driver_hotshotf;
    extern struct GameDriver driver_hotshffp;
    // Bone Busters Inc. (#719)
    extern struct GameDriver driver_bonebstr;
    extern struct GameDriver driver_bonebsfp;
    extern struct GameDriver driver_bonebstg;
    extern struct GameDriver driver_bonebgfp;
    extern struct GameDriver driver_bonebstf;
    extern struct GameDriver driver_bonebffp;
    // Night Moves (C-101)
    extern struct GameDriver driver_nmoves;
    extern struct GameDriver driver_nmovesfp;
    // Amazon Hunt III (#684D)
    extern struct GameDriver driver_amazonh3;
    extern struct GameDriver driver_amazn3fp;
    extern struct GameDriver driver_amazon3a;
    extern struct GameDriver driver_amaz3afp;
    // ManilaMatic (GTS80B hardware)
    extern struct GameDriver driver_topsound;
    extern struct GameDriver driver_mmmaster;
    // ────────────────────────────────────────────────────────────────────────

    struct GameDriver *drivers[] = {
        &driver_triplay,   &driver_triplyfp,  &driver_triplaya,  &driver_triplyf1,
        &driver_triplayg,  &driver_triplgfp,
        &driver_bountyh,   &driver_bounthfp,  &driver_bountyhg,  &driver_bountgfp,
        &driver_tagteam,   &driver_tagtemfp,  &driver_tagteamg,  &driver_tagtmgfp,
        &driver_tagteam2,  &driver_tagtem2f,
        &driver_rock,      &driver_rockfp,    &driver_rockg,     &driver_rockgfp,
        &driver_s80btest,
        &driver_raven,     &driver_ravenfp,   &driver_raveng,    &driver_ravengfp,
        &driver_ravena,    &driver_ravenafp,  &driver_rambo,
        &driver_rock_enc,  &driver_rock_efp,  &driver_rock_eg,   &driver_rockegfp,
        &driver_clash,
        &driver_hlywoodh,  &driver_hlywdhfp,  &driver_hlywodhg,  &driver_hlywhgfp,
        &driver_hlywodhf,  &driver_hlywhffp,  &driver_bubba,     &driver_beachbms,
        &driver_tomjerry,
        &driver_genesis,   &driver_genesifp,  &driver_genesisg,  &driver_genesgfp,
        &driver_genesisf,  &driver_genesffp,
        &driver_goldwing,  &driver_goldwgfp,  &driver_gldwingg,  &driver_gldwggfp,
        &driver_gldwingf,  &driver_gldwgffp,
        &driver_mntecrlo,  &driver_mntecrfp,  &driver_mntecrlga, &driver_mntecrlg,
        &driver_mntcrgfp,  &driver_mntcrgmfp, &driver_mntecrlf,  &driver_mntcrffp,
        &driver_mntcrfmfp, &driver_mntecrla,  &driver_mntcrafp,  &driver_mntecrl2,
        &driver_mntcr2fp,  &driver_mntcrmfp,
        &driver_sprbreak,  &driver_sprbrkfp,  &driver_sprbrkg,   &driver_sprbrgfp,
        &driver_sprbrkf,   &driver_sprbrffp,  &driver_sprbrka,   &driver_sprbrafp,
        &driver_sprbrks,   &driver_sprbrsfp,
        &driver_amazonh2,  &driver_amazn2fp,
        &driver_arena,     &driver_arena_fp,  &driver_arenag,    &driver_arenagfp,
        &driver_arenaf,    &driver_arenaffp,  &driver_arenaa,    &driver_arenaafp,
        &driver_arena2,
        &driver_victory,   &driver_victryfp,  &driver_victoryg,  &driver_victrgfp,
        &driver_victoryf,  &driver_victrffp,  &driver_victr101,  &driver_victr11,
        &driver_victr12,   &driver_victr13,
        &driver_diamond,   &driver_diamonfp,  &driver_diamondg,  &driver_diamngfp,
        &driver_diamondf,  &driver_diamnffp,
        &driver_txsector,  &driver_txsectfp,  &driver_txsectrg,  &driver_txsecgfp,
        &driver_txsectrf,  &driver_txsecffp,
        &driver_robowars,  &driver_robowrfp,  &driver_robowarf,  &driver_robowffp,
        &driver_badgirls,  &driver_badgirl2,  &driver_badgrlfp,  &driver_badgirlg,
        &driver_badgrgfp,  &driver_badgirlf,  &driver_badgrffp,
        &driver_excaliba,  &driver_excalbfp,  &driver_excalibg,  &driver_excalgfp,
        &driver_excalibr,  &driver_excalffp,
        &driver_bighouse,  &driver_bighosfp,  &driver_bighousg,  &driver_bighsgfp,
        &driver_bighousf,  &driver_bighsffp,
        &driver_hotshots,  &driver_hotshtfp,  &driver_hotshotg,  &driver_hotshgfp,
        &driver_hotshotf,  &driver_hotshffp,
        &driver_bonebstr,  &driver_bonebsfp,  &driver_bonebstg,  &driver_bonebgfp,
        &driver_bonebstf,  &driver_bonebffp,
        &driver_nmoves,    &driver_nmovesfp,
        &driver_amazonh3,  &driver_amazn3fp,  &driver_amazon3a,  &driver_amaz3afp,
        &driver_topsound,  &driver_mmmaster,
        nullptr
    };

    extern GameOptions options;

    EMSCRIPTEN_KEEPALIVE
    void pinmame_web_boot() {
        const char* rom_name = (const char*)&g_shared_corridor[1000];
        int game_index = -1;
        for (int i = 0; drivers[i] != nullptr; i++) {
            if (strcmp(drivers[i]->name, rom_name) == 0) {
                game_index = i;
                break;
            }
        }
        if (game_index < 0) return;
        // Pre-call driver_init pour que core_gameData soit valide avant
        // memory_init (appelé par run_game avant driver_init).
        if (drivers[game_index]->driver_init)
            drivers[game_index]->driver_init();
        if (!rompath_extra) rompath_extra = (char*)hal_rompath();
#ifdef ESP_PLATFORM
        options.samplerate = 44100;  // stream callbacks OPMUpdateOne sont no-op sur ESP32 → valeur par défaut
#else
        options.samplerate = 44100;
#endif
        options.gui_host = 1;
        bailing = 0;
        run_game(game_index);
    }

}

// YM2151 synthèse au taux réel du chip (baseclock/64, capturé dans g_opm_sample_rate).
// Pour GTS80B : baseclock=4MHz → 4000000/64 = 62500 Hz.
// Synth sur Core 0 (prio 4) → n'interfère ni avec UAC ni avec emulation (Core 1).
// Resample 62500 → 48000 Hz par Bresenham (downsample) dans synth_task.
#ifdef ESP_PLATFORM
#define YM_RATE_FALLBACK  62500  // fallback si g_opm_sample_rate pas encore reçu
#define YM_BUF   2400    // 62500 × 34ms = 2125 samples → 2400 avec marge
static INT16 s_synth_L[YM_BUF], s_synth_R[YM_BUF];
static INT16 s_lin[DMAX];  // buffer de sortie synth_task — distinct de g_lin (chemin DAC emulation)

static void synth_task(void* pv) {
    while (!g_ym2151_ready) vTaskDelay(pdMS_TO_TICKS(10));

    INT16* bufs[2] = { s_synth_L, s_synth_R };
    int64_t s_last_us = 0;
    TickType_t tick = xTaskGetTickCount();

    for (;;) {
        vTaskDelayUntil(&tick, pdMS_TO_TICKS(17));

        int64_t now_us = esp_timer_get_time();
        if (s_last_us == 0) { s_last_us = now_us; continue; }
        int64_t elapsed_us = now_us - s_last_us;
        s_last_us = now_us;

        // Capituler elapsed_us à 1 frame (17ms) pour briser la boucle de rétroaction :
        //   elapsed↑ → in_count↑ → UpdateOne plus lourd → contention bus DRAM partagé
        //   → emulation_task Core 1 ralentit → FPS chute → tempo instable.
        // vTaskDelayUntil est absolu : si ce cycle est court (elapsed<17ms après retard),
        // il compense au cycle suivant — la moyenne reste exactement 62500 Hz.
        // Si retard extrême (>34ms), reset tick pour éviter la busy-loop (watchdog IDLE0).
        if (elapsed_us > 34000LL) tick = xTaskGetTickCount();
        if (elapsed_us > 17000LL) elapsed_us = 17000LL;

        // Taux réel du chip : baseclock/64 (ex. 62500 Hz pour GTS80B 4MHz).
        // CRITIQUE : utiliser le taux réel, pas YM_RATE arbitraire.
        int ym_rate = g_opm_sample_rate > 0 ? g_opm_sample_rate : YM_RATE_FALLBACK;

        // in_count et target_pairs calculés sur le même elapsed_us cappé.
        int in_count = (int)((int64_t)ym_rate * elapsed_us / 1000000LL);
        if (in_count <= 0) continue;
        if (in_count > YM_BUF) in_count = YM_BUF;

        int target_pairs = (int)((int64_t)48000LL * elapsed_us / 1000000LL);
        if (target_pairs <= 0) continue;
        if (target_pairs > DMAX / 2) target_pairs = DMAX / 2;

        if (g_sound_enabled) {
            // Pas de mutex : tenir le mutex ~6ms bloquerait emulation_task (Core 1)
            // → perturbation de tempo. Race bénigne acceptée (≤2 samples corrompus).
            YM2151UpdateOne(0, bufs, in_count);
        } else {
            memset(s_synth_L, 0, in_count * sizeof(INT16));
            memset(s_synth_R, 0, in_count * sizeof(INT16));
        }

        int out = 0;
        for (int j = 0; j < target_pairs; j++) {
            int src = (j * in_count) / target_pairs;  // Bresenham select
            s_lin[out++] = s_synth_L[src];
            s_lin[out++] = s_synth_R[src];
        }

        // Mixer le DAC/speech depuis g_ring (OPMUpdateOne est no-op sur ESP32,
        // donc g_ring contient uniquement les chips non-YM2151).
        // g_ring est rempli à SPF=100 paires stéréo/frame (≈6kHz).
        {
            static INT16 dac_buf[SPF * 4];  // max 2 frames de DAC
            int dac_n = (g_wi - g_ri + ABMAX) % ABMAX;
            if (dac_n > SPF * 4) dac_n = SPF * 4;
            if (dac_n >= 2) {
                for (int i = 0; i < dac_n; i++) { dac_buf[i] = g_ring[g_ri]; g_ri = (g_ri + 1) % ABMAX; }
                int dac_pairs = dac_n / 2;
                for (int j = 0; j < target_pairs; j++) {
                    int dsrc = (dac_pairs > 1) ? (j * dac_pairs) / target_pairs : 0;
                    if (dsrc >= dac_pairs) dsrc = dac_pairs - 1;
                    int L = (int)s_lin[j*2]   + (int)dac_buf[dsrc*2];
                    int R = (int)s_lin[j*2+1] + (int)dac_buf[dsrc*2+1];
                    s_lin[j*2]   = (INT16)(L > 32767 ? 32767 : (L < -32768 ? -32768 : L));
                    s_lin[j*2+1] = (INT16)(R > 32767 ? 32767 : (R < -32768 ? -32768 : R));
                }
            }
        }

        if (out > 0) hal_push_audio((uintptr_t)s_lin, out, 0);
    }
}
#endif

extern "C" void api_start_synth_task(void) {
#ifdef ESP_PLATFORM
    // Core 0, priorité 4 (< uac_audio_task=8 et USB host=10).
    // → synth ne peut PAS préempter la chaîne UAC → LA correct.
    // → Core 1 (emulation_task) totalement libre → tempo correct.
    // Mutex g_ym_mutex protège YM2151UpdateOne (Core 0) vs YM2151WriteReg (Core 1).
    xTaskCreatePinnedToCore(synth_task, "synth", 4096, NULL,
                            4, NULL, 0);
#endif
}

extern "C" void __wrap_DAC_DC_offset_correction_data_16_w(int n, int d) {
    if ((unsigned)n < 2 && g_dn[n] < DMAX)
        g_dac[n][g_dn[n]++] = d;
}

