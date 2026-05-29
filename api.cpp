// =========================================================================
// 🔌 INFRASTRUCTURE PINMAME WASM - PONT DE CONTROLE API C++
// 🏷️ VERSION : API-CORE-GATEWAY-V173.1 (SOUND REGISTERS STUBBED)
// =========================================================================

#include <iostream>
#include <cstdio>
#include <stdint.h>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <cstdarg> 
#include <emscripten.h> 

#define __rolq(x,c) (((unsigned long long)(x) << (c)) | ((unsigned long long)(x) >> (64 - (c))))
#define __rorq(x,c) (((unsigned long long)(x) >> (c)) | ((unsigned long long)(x) << (64 - (c))))

typedef uint8_t BMTYPE; 

extern "C" {
#include "driver.h"
#include "core.h"
#include "usrintrf.h"
}

static uint8_t g_dummy_buffer[4096] = {0};
static char g_display_text[100] = "Analyseur Global Actif";
static uint32_t g_font_security_anchor[100] = {0}; 

static int g_selected_game_index = 0;

extern "C" void emscripten_sleep(unsigned int ms);

extern "C" void libpinmame_log_error(const char* format, ...) {
    va_list args;
    va_start(args, format);
    vfprintf(stderr, format, args);
    va_end(args);
    std::cerr << std::endl;
}

extern "C" {
    int run_game(int game_num);
    unsigned int cpunum_get_reg(int cpunum, int regnum);
    
    extern int bailing;
    extern struct osd_bitmap *scrbitmap;

    char build_version[] = "PinMAME-WASM-V173.1";
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
    void* samples_interface = nullptr;
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
    void osd_exit(void) { exit(1); }
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
    void osd_update_video_and_audio(struct mame_display *display) {}
    int osd_start_audio_stream(int stereo) { return 1000; }
    int osd_update_audio_stream(INT16 *buffer) { return 1000; }
    void osd_stop_audio_stream(void) {}
    void osd_sound_enable(int enable) {}

    struct GfxElement *builduifont(void) { return (struct GfxElement *)g_font_security_anchor; }
    struct osd_bitmap* artwork_get_ui_bitmap(void) { return (struct osd_bitmap*)g_dummy_buffer; }
    void init_user_interface(void) {} 

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
    
    void hard_disk_close_all(void) {}
    void hard_disk_set_interface(void *interface) {}
    int hard_disk_open(int p1, int p2, int p3) { return 0; }
    int hard_disk_get_header(int p1) { return 0; }
    int hard_disk_create(int p1, int p2) { return 0; }
    
    void hs_init(void) {}
    void hs_open(int p1) {}
    void hs_close(void) {}
    void hs_update(void) {} 

    void set_vh_global_attribute(int attrib, int value) {}
    int tilemap_init(void) { return 0; }
    void artwork_enable(int enable) {}
    void InitCheat(void) {}
    void StopCheat(void) {}
    void tilemap_close(void) {}
    int artwork_create_display(int p1, int p2, int p3) { return 0; }
    void freegfx(struct GfxElement *gfx) {}
    
    struct GfxElement *decodegfx(const unsigned char *src, const struct GfxLayout *gl) { return (struct GfxElement *)g_font_security_anchor; }
    
    int showcopyright(struct mame_bitmap *bitmap) { return 0; }
    int showgamewarnings(struct mame_bitmap *bitmap) { return 0; }
    int showgameinfo(struct mame_bitmap *bitmap) { return 0; }

    void fillbitmap(struct mame_bitmap *dest, UINT32 pen, const struct rectangle *clip) {}
    void drawgfx(struct mame_bitmap *dest, const struct GfxElement *gfx, unsigned int code, unsigned int color, int flipx, int flipy, int destx, int desty, const struct rectangle *clip, int transparency, int transparent_color) {}
    void set_pixel_functions(struct mame_bitmap *bitmap) {}
    int handle_user_interface(struct mame_bitmap *bitmap) { return 0; }
    int artwork_load_artwork_file(void) { return 0; }
    
    void pic8259_0_issue_irq(int p1) {}
    void proc_mechsounds(int p1, int p2) {} 
    void throttle_speed_part(int p1, int p2) {}
    float bulb_heat_up_factor(int p1, float p2, float p3, float p4) { return 0.0f; }
    float bulb_filament_temperature_to_emission(int p1, float p2) { return 0.0f; }
    void bulb_init(void) {}

    int OPMInit(int num, double clock, double rate, int param4, int param5) { return 0; }
    int OPMResetChip(int num) { return 0; } 
    int OPMShutdown(void) { return 0; }
    int OPMSetPortHander(int num, void* handler) { return 0; }
    int YM2151TimerOver(int c, int ch) { return 0; }
    void OPMUpdateOne(int num, INT16 **buffer, int length) {}
    void YM2151_data_port_0_w(int offset, int data) {}
    void YM2151_register_port_0_w(int offset, int data) {}

    int AY8910_sh_start(void* msound) { return 0; }
    int VOTRAXSC01_sh_start(void* msound) { return 0; }
    int sp0250_sh_start(void* msound) { return 0; }
    int samples_sh_start(void* msound) { return 0; }
    int OKIM6295_sh_start(void* msound) { return 0; }
    void AY8910_sh_reset(void) {}
    void AY8910_sh_stop(void) {}
    void VOTRAXSC01_sh_stop(void) {}
    void sp0250_sh_stop(void) {}
    void samples_sh_stop(void) {}
    void OKIM6295_sh_stop(void) {}
    void OKIM6295_sh_update(void) {}
    void pic8259_0_config(int p1, int p2) {}
    int votraxsc01_status_r(int p1) { return 0; }
    int sem_timedwait(void* sem, const void* abs_timeout) { return 0; }

    // 🌟 RE-INJECTION DES POINTEURS DE CONTROLE AUDIO RECLAMÉS PAR GTS80S.O
    void AY8910_control_port_0_w(int offset, int data) {}
    void AY8910_write_port_0_w(int offset, int data) {}
    void AY8910_control_port_1_w(int offset, int data) {}
    void AY8910_write_port_1_w(int offset, int data) {}
    void sp0250_w(int offset, int data) {}

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

    void artwork_update_video_and_audio(void* display) {
        uint16_t* vfd_export = (uint16_t*)g_dummy_buffer;
        for (int i = 0; i < 20; i++) {
            vfd_export[i]      = coreGlobals.segments[i].w & 0xFFFF;
            vfd_export[20 + i] = coreGlobals.segments[20 + i].w & 0xFFFF;
        }
        for (int sw = 0; sw < 80; sw++) {
            core_setSw(sw, g_dummy_buffer[100 + sw]);
        }
        for (int b = 0; b < 10; b++) {
            g_dummy_buffer[200 + b] = coreGlobals.swMatrix[b];
        }
        for (int l = 0; l < 12; l++) {
            g_dummy_buffer[300 + l] = coreGlobals.lampMatrix[l];
        }
        uint32_t solenoids_state = coreGlobals.solenoids;
        memcpy(&g_dummy_buffer[320], &solenoids_state, 4);
        emscripten_sleep(1);
    }

    uint8_t* pinmame_get_gprom_ptr() { return g_dummy_buffer; }
    uint8_t* pinmame_get_dsprom_ptr() { return g_dummy_buffer; } 
    const char* pinmame_get_display() { return g_display_text; }
    const char* pinmame_get_version() { return "PinMAME Analyzer Gate V173.1"; }
    void pinmame_web_entry(int gprom_size, int dsprom_size) {}
    void pinmame_web_tick(int cycles) {}

    // Déclarations fortes des drivers validés présents dans libpinmame_wasm.a
    extern struct GameDriver driver_bonebstr;
    extern struct GameDriver driver_badgirls;
    extern struct GameDriver driver_genesis;
    extern struct GameDriver driver_txsector;
    extern struct GameDriver driver_victory;
    extern struct GameDriver driver_arena;
    extern struct GameDriver driver_raven;
    extern struct GameDriver driver_rock;
    extern struct GameDriver driver_bighouse;
    extern struct GameDriver driver_bountyh;
    extern struct GameDriver driver_tagteam;
    extern struct GameDriver driver_excalibr;
    extern struct GameDriver driver_diamond;

    // Tableau officiel épuré des deux éléments absents
    struct GameDriver *drivers[] = {
        &driver_bonebstr, &driver_badgirls, &driver_genesis, &driver_txsector,
        &driver_victory,  &driver_arena,    &driver_raven,    &driver_rock,
        &driver_bighouse, &driver_bountyh,  &driver_tagteam,   &driver_excalibr,
        &driver_diamond,
        nullptr
    };

    EMSCRIPTEN_KEEPALIVE int pinmame_set_driver_by_name(const char* name) {
        int i = 0;
        while (drivers[i] != nullptr) {
            if (strcmp(drivers[i]->name, name) == 0) {
                g_selected_game_index = i;
                std::cout << "🎯 Match trouve dans libpinmame ! Index : " << i 
                          << " -> [ " << drivers[i]->description << " ]" << std::endl;
                return 1; 
            }
            i++;
        }
        std::cerr << "🔴 Erreur critique : Le driver \"" << name << "\" n'est pas disponible dans api.cpp !" << std::endl;
        return 0; 
    }

    void pinmame_web_boot() {
        std::cout << "🚀 Demarrage du processeur d'arcade sur l'index materiel : " << g_selected_game_index << std::endl;
        bailing = 0;
        run_game(g_selected_game_index); 
    }
}