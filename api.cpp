// =========================================================================
// 🔌 INFRASTRUCTURE PINMAME WASM - PONT DE CONTROLE API C++
// 🏷️ VERSION : API-CORE-GATEWAY-V195.07 (EVENT-DRIVEN NOTIFICATION COUNTERS)
// =========================================================================

#include <iostream>
#include <cstdio>
#include <stdint.h>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <cstdarg> 
#include <emscripten.h> 

#ifndef __rolq
#define __rolq(x,c) (((unsigned long long)(x) << (c)) | ((unsigned long long)(x) >> (64 - (c))))
#endif
#ifndef __rorq
#define __rorq(x,c) (((unsigned long long)(x) >> (c)) | ((unsigned long long)(x) << (64 - (c))))
#endif

typedef uint8_t BMTYPE; 

extern "C" {
#include "driver.h"
#include "core.h"
#include "usrintrf.h"
#include "sound/ym2151.h" 
#include "sound/samples.h" 
#include "inptport.h" 
}

static uint8_t g_dummy_buffer[1024 * 1024] = {0}; 
static uint8_t g_shared_corridor[4096] = {0};      
static char g_display_text[100] = "Analyseur Global Actif";
static uint32_t g_font_security_anchor[10000] = {0}; 
static int g_selected_game_index = 0;

// =========================================================================
// 🎵 TAMPONS AUDIO MAME -> WEBASSEMBLY
// =========================================================================
#define C_AUDIO_BUFFER_MAX 131072
#define SAMPLES_PER_FRAME 735


// ── DAC push buffer ───────────────────────────────────────────────────────────
// Intercepté via --wrap=DAC_DC_offset_correction_data_16_w.
// Les valeurs brutes (volume×data, 0..65025) sont accumulées ici chaque frame.
// JS lit via api_get_dac_buffer/count/reset, applique l'intégrateur DC-offset
// en JS et mélange dans pushWasmAudio — sans toucher au stream MAME.
#define DAC_BUF_MAX 4096
static int g_dac_buf[2][DAC_BUF_MAX];
static int g_dac_n[2] = {0, 0};

static INT16 g_audio_ring_buffer[C_AUDIO_BUFFER_MAX];
static int g_audio_write_idx = 0;
static int g_audio_read_idx = 0; 
static INT16 g_linear_audio_buffer[C_AUDIO_BUFFER_MAX];

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

extern "C" void emscripten_sleep(unsigned int ms);

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
// 🌟 1. LE PONT MATÉRIEL YAMAHA AVEC FLUSH SYNCHRONE 🌟
// =========================================================================
extern "C" {
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
        for(int i = 0; i < 4; i++) { stream_update(i, 0); }
        YM2151WriteReg(0, g_gts80b_sound_reg_latch, data);
    }
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
    void* driver_0 = nullptr;
    
    struct Samplesinterface samples_interface;

    int pdrawgfx_shadow_lowpri = 0; 

    struct mame_bitmap *priority_bitmap = (struct mame_bitmap *)g_dummy_buffer; 
    char* rompath_extra = (char*)"/roms";

    cycles_t osd_cycles(void) {
        static auto start_time = std::chrono::steady_clock::now();
        auto current_time = std::chrono::steady_clock::now();
        return (cycles_t)std::chrono::duration_cast<std::chrono::nanoseconds>(current_time - start_time).count();
    }
    cycles_t osd_cycles_per_second(void) { return (cycles_t)1000000000; }
    
    int osd_init(void) { return 0; }
    void osd_exit(void) {
        // Do NOT use emscripten_sleep here: if init_machine fails, ASYNCIFY would
        // save state here, then rewind through memory_init again causing abort.
        EM_ASM({ if (window.postWasmLog) window.postWasmLog("osd_exit called"); });
        EM_ASM({ throw new Error("PinMAME: emulation stopped"); });
    }
    void osd_pause(int paused) {}
    int osd_skip_this_frame(void) { return 0; }
    int osd_init_video(void) { return 0; }
    int osd_init_sound(void) { return 0; }
    int osd_init_input(void) { return 0; }

    int osd_create_display(const struct osd_create_params *params, UINT32 *rgb_components) { return 0; }
    void osd_close_display(void) {}
    int osd_allocate_colors(unsigned int totalcolors, const UINT8 *palette, UINT32 *pens, int resettable) { return 0; }
    void osd_modify_pen(int pen, int red, int green, int blue) {}
    void osd_free_colors(void) {}
    int osd_display_loading_rom_message(const char *name, struct rom_load_data *romdata) { return 0; }
    
    int osd_start_audio_stream(int stereo) { return SAMPLES_PER_FRAME; }

    int osd_update_audio_stream(INT16 *buffer) {
        int shorts_to_copy = SAMPLES_PER_FRAME * 2;
        for (int i = 0; i < shorts_to_copy; i++) {
            g_audio_ring_buffer[g_audio_write_idx] = buffer[i];
            g_audio_write_idx = (g_audio_write_idx + 1) % C_AUDIO_BUFFER_MAX;
        }
        return SAMPLES_PER_FRAME;
    }

    void osd_stop_audio_stream(void) {}
    void osd_sound_enable(int enable) {}

    struct GfxElement *builduifont(void) { return (struct GfxElement *)g_font_security_anchor; }
    struct osd_bitmap* artwork_get_ui_bitmap(void) { return (struct osd_bitmap*)g_dummy_buffer; }
    void init_user_interface(void) {} 

    void pic8259_0_config(int p1, int p2) {}
    int sem_timedwait(void* sem, const void* abs_timeout) { return 0; }
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
    
    const struct KeyboardInfo *osd_get_key_list(void) { return nullptr; }
    const struct JoystickInfo *osd_get_joy_list(void) { return nullptr; }
    
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
    void proc_mechsounds(int p1, int p2) {} 
    void throttle_speed_part(int p1, int p2) {}

    int YM2203_sh_start(const struct MachineSound *msound) { return 0; }
    void YM2203_sh_stop(void) {}
    void YM2203_sh_reset(void) {}
    
    int OKIM6295_sh_start(const struct MachineSound *msound) { return 0; }
    void OKIM6295_sh_stop(void) {}
    void OKIM6295_sh_update(void) {}

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

    void artwork_update_video_and_audio(struct mame_display *display) {
        static uint16_t prev_segments[40] = {};
        static uint8_t  prev_lamps[12]    = {};
        static uint32_t prev_solenoids    = 0xFFFFFFFF;

        uint16_t* vfd_export = (uint16_t*)g_shared_corridor;
        for (int i = 0; i < 20; i++) {
            vfd_export[i]      = coreGlobals.segments[i].w & 0xFFFF;
            vfd_export[20 + i] = coreGlobals.segments[20 + i].w & 0xFFFF;
        }
        if (memcmp(prev_segments, vfd_export, 40 * sizeof(uint16_t)) != 0) {
            memcpy(prev_segments, vfd_export, 40 * sizeof(uint16_t));
            EM_ASM({ if (window.pushWasmDisplay) window.pushWasmDisplay($0); },
                   (uint32_t)g_shared_corridor);
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
            EM_ASM({ if (window.pushWasmLamps) window.pushWasmLamps($0); },
                   (uint32_t)(g_shared_corridor + 300));
        }

        uint32_t solenoids_state = coreGlobals.solenoids;
        if (solenoids_state != prev_solenoids) {
            prev_solenoids = solenoids_state;
            EM_ASM({ if (window.pushWasmSolens) window.pushWasmSolens($0); },
                   solenoids_state);
        }

        uint8_t sound_user_cmd = g_shared_corridor[1060];
        if (sound_user_cmd > 0) {
            g_shared_corridor[1060] = 0; 
            sndbrd_0_data_w(0, sound_user_cmd);
            EM_ASM({ if (window.postWasmLog) { window.postWasmLog($0); } }, sound_user_cmd);
        }

        int pending_samples = (g_audio_write_idx - g_audio_read_idx + C_AUDIO_BUFFER_MAX) % C_AUDIO_BUFFER_MAX;
        if (pending_samples > 0) {
            if (pending_samples > 4096) pending_samples = 4096;
            for (int i = 0; i < pending_samples; i++) {
                g_linear_audio_buffer[i] = g_audio_ring_buffer[g_audio_read_idx];
                g_audio_read_idx = (g_audio_read_idx + 1) % C_AUDIO_BUFFER_MAX;
            }
            EM_ASM({
                if (window.pushWasmAudio) { window.pushWasmAudio($0, $1); }
            }, (uint32_t)g_linear_audio_buffer, pending_samples);
        }

        uint32_t js_buffer_dist = 0;
        memcpy(&js_buffer_dist, &g_shared_corridor[1070], 4);
        if (js_buffer_dist > 8192) emscripten_sleep(12);
        else if (js_buffer_dist > 4096) emscripten_sleep(6);
        else if (js_buffer_dist > 1600) emscripten_sleep(2);
        else emscripten_sleep(1);
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
        options.samplerate = 44100;
        options.gui_host = 1;
        bailing = 0;
        run_game(game_index);
    }

    // ── Exports DAC push buffer ───────────────────────────────────────────────
    EMSCRIPTEN_KEEPALIVE
    int api_get_dac_count(int chip) { return (unsigned)chip < 2 ? g_dac_n[chip] : 0; }

    EMSCRIPTEN_KEEPALIVE
    int* api_get_dac_buffer(int chip) { return (unsigned)chip < 2 ? g_dac_buf[chip] : nullptr; }

    EMSCRIPTEN_KEEPALIVE
    void api_reset_dac_buffer(int chip) { if ((unsigned)chip < 2) g_dac_n[chip] = 0; }
}

// ── Wrapper --wrap=DAC_DC_offset_correction_data_16_w ────────────────────────
extern "C" void __real_DAC_DC_offset_correction_data_16_w(int num, int data);
extern "C" void __wrap_DAC_DC_offset_correction_data_16_w(int num, int data) {
    if ((unsigned)num < 2 && g_dac_n[num] < DAC_BUF_MAX)
        g_dac_buf[num][g_dac_n[num]++] = data;
    // __real_ NON appelé : le stream DAC MAME reste à 0.
    // JS reconstruit l'audio DAC dans pushWasmAudio via api_get_dac_buffer.
}

