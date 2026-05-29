// =========================================================================
// 🔌 INFRASTRUCTURE PINMAME WASM - PONT DE CONTROLE API C++
// 🏷️ VERSION : API-CORE-GATEWAY-V173.40 (MMACULATE ASCII PRODUCTION)
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

// COULOIRS DE MÉMOIRE ISOLÉS
static uint8_t g_dummy_buffer[1024 * 1024] = {0}; 
static uint8_t g_shared_corridor[4096] = {0};      

static char g_display_text[100] = "Analyseur Global Actif";
static uint32_t g_font_security_anchor[10000] = {0}; 

static int g_selected_game_index = 0;

// FILE AUDIO CIRCULAIRE
#define C_AUDIO_BUFFER_MAX 131072
static INT16 g_audio_ring_buffer[C_AUDIO_BUFFER_MAX];
static int g_audio_write_idx = 0;
static int g_audio_read_idx = 0; 
static INT16 g_linear_audio_buffer[C_AUDIO_BUFFER_MAX];

#define SAMPLES_PER_FRAME 735 

// VARIABLES DU SYNTHÉTISEUR POLYPHONIQUE HLE YM2151
static uint8_t g_ym_registers[256] = {0};
static uint8_t g_current_register = 0;

struct VirtualVoice {
    bool active = false;
    float frequency = 0.0f;
    float phase = 0.0f;
    float amplitude = 0.0f;
};
static VirtualVoice g_ym_voices[8];

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

    char build_version[] = "PinMAME-WASM-V173.40";
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
    void osd_exit(void) { while(1) { emscripten_sleep(1000); } }
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
    int osd_start_audio_stream(int stereo) { return SAMPLES_PER_FRAME; }
    int osd_update_audio_stream(INT16 *buffer) { return SAMPLES_PER_FRAME; }
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

    int YM2203_sh_start(void* msound) { return 0; }
    void YM2203_sh_stop(void) {}
    void YM2203_sh_reset(void) {}
    int OKIM6295_sh_start(void* msound) { return 0; }
    void OKIM6295_sh_stop(void) {}
    void OKIM6295_sh_update(void) {}

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

    #define SAFESTUB __attribute__((weak))
    SAFESTUB int OPMInit(int num, int clock, int rate, void* p4, void* p5) { return 0; }
    SAFESTUB void OPMShutdown(void) {}
    SAFESTUB void OPMResetChip(int num) {}
    SAFESTUB int OPMSetPortHander(int num, int handler) { return 0; }
    SAFESTUB int YM2151TimerOver(int c, int ch) { return 0; }
    SAFESTUB void OPMUpdateOne(int num, INT16 **buffer, int length) {}

    void YM2151_register_port_0_w(int offset, int data) { 
        g_current_register = data & 0xFF; 
    }

    void YM2151_data_port_0_w(int offset, int data) {
        uint8_t reg = g_current_register;
        uint8_t val = data & 0xFF;
        g_ym_registers[reg] = val;

        if (reg == 0x08) {
            uint8_t chan = val & 0x07;
            uint8_t slots = (val >> 3) & 0x0F;
            if (slots > 0) {
                uint8_t note_val = g_ym_registers[0x28 + chan];
                int octave = (note_val >> 4) & 0x07;
                int note_idx = note_val & 0x0F;
                if (note_idx > 11) note_idx = 11;

                float octave_4[12] = {
                    261.63f, 277.18f, 293.66f, 311.13f, 329.63f, 349.23f,
                    369.99f, 392.00f, 415.30f, 440.00f, 466.16f, 493.88f
                };
                float freq = octave_4[note_idx];
                if (octave < 4) freq /= (1 << (4 - octave));
                if (octave > 4) freq *= (1 << (octave - 4));

                if (freq > 30.0f && freq < 4000.0f) {
                    g_ym_voices[chan].frequency = freq;
                    g_ym_voices[chan].active = true;
                    g_ym_voices[chan].amplitude = 1.0f;
                    g_shared_corridor[1064] = note_val > 0 ? note_val : 1;
                }
            } else {
                g_ym_voices[chan].active = false;
            }
        }
    }

    void YM2151_word_0_w(int offset, int data) {
        if (offset & 1) YM2151_data_port_0_w(offset, data & 0xFF);
        else YM2151_register_port_0_w(offset, data & 0xFF);
    }

    void artwork_update_video_and_audio(void* display) {
        uint16_t* vfd_export = (uint16_t*)g_shared_corridor;
        for (int i = 0; i < 20; i++) {
            vfd_export[i]      = coreGlobals.segments[i].w & 0xFFFF;
            vfd_export[20 + i] = coreGlobals.segments[20 + i].w & 0xFFFF;
        }
        for (int sw = 0; sw < 80; sw++) { core_setSw(sw, g_shared_corridor[100 + sw]); }
        for (int b = 0; b < 10; b++) { g_shared_corridor[200 + b] = coreGlobals.swMatrix[b]; }
        for (int l = 0; l < 12; l++) { g_shared_corridor[300 + l] = coreGlobals.lampMatrix[l]; }
        uint32_t solenoids_state = coreGlobals.solenoids;
        memcpy(&g_shared_corridor[320], &solenoids_state, 4);

        uint8_t sound_user_cmd = g_shared_corridor[1060];
        if (sound_user_cmd > 0) {
            g_shared_corridor[1060] = 0; 
            g_shared_corridor[1064] = sound_user_cmd; 
            g_ym_voices[7].frequency = 180.0f + (sound_user_cmd * 14.0f);
            g_ym_voices[7].active = true;
            g_ym_voices[7].amplitude = 1.0f;
        }

        for (int s = 0; s < SAMPLES_PER_FRAME; s++) {
            float mixed = 0.0f;
            int active_count = 0;
            for (int v = 0; v < 8; v++) {
                if (g_ym_voices[v].amplitude > 0.001f) {
                    float wave = (g_ym_voices[v].phase < 0.5f) ? 1.0f : -1.0f;
                    mixed += wave * 2500.0f * g_ym_voices[v].amplitude;
                    active_count++;

                    g_ym_voices[v].phase += g_ym_voices[v].frequency / 44100.0f;
                    if (g_ym_voices[v].phase >= 1.0f) g_ym_voices[v].phase -= 1.0f;

                    if (!g_ym_voices[v].active) g_ym_voices[v].amplitude *= 0.94f;
                    else g_ym_voices[v].amplitude *= 0.9992f;
                }
            }
            INT16 final_sample = (INT16)mixed;
            if (active_count > 1) final_sample /= (active_count * 0.75f);

            g_audio_ring_buffer[g_audio_write_idx] = final_sample;
            g_audio_write_idx = (g_audio_write_idx + 1) % C_AUDIO_BUFFER_MAX;
            g_audio_ring_buffer[g_audio_write_idx] = final_sample;
            g_audio_write_idx = (g_audio_write_idx + 1) % C_AUDIO_BUFFER_MAX;
        }

        uint32_t js_consumed = 0;
        memcpy(&js_consumed, &g_shared_corridor[1050], 4);
        int pending_samples = (g_audio_write_idx - g_audio_read_idx + C_AUDIO_BUFFER_MAX) % C_AUDIO_BUFFER_MAX;

        if (js_consumed == 0 && pending_samples > 0) {
            if (pending_samples > 4096) pending_samples = 4096;
            for (int i = 0; i < pending_samples; i++) {
                g_linear_audio_buffer[i] = g_audio_ring_buffer[g_audio_read_idx];
                g_audio_read_idx = (g_audio_read_idx + 1) % C_AUDIO_BUFFER_MAX;
            }
            memcpy(&g_shared_corridor[1050], &pending_samples, 4);
            uint32_t buffer_address = (uint32_t)g_linear_audio_buffer;
            memcpy(&g_shared_corridor[1054], &buffer_address, 4);
        }

        uint32_t js_buffer_dist = 0;
        memcpy(&js_buffer_dist, &g_shared_corridor[1070], 4);
        if (js_buffer_dist > 8192) emscripten_sleep(12);
        else if (js_buffer_dist > 4096) emscripten_sleep(6);
        else if (js_buffer_dist > 1600) emscripten_sleep(2);
        else emscripten_sleep(1);
    }

    uint8_t* pinmame_get_gprom_ptr() { return g_shared_corridor; }
    uint8_t* pinmame_get_dsprom_ptr() { return g_shared_corridor; } 
    const char* pinmame_get_display() { return g_display_text; }
    const char* pinmame_get_version() { return "PinMAME HLE Polyphonic Gate V173.39"; }
    void pinmame_web_entry(int gprom_size, int dsprom_size) {}
    void pinmame_web_tick(int cycles) {}

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

    struct GameDriver *drivers[] = {
        &driver_bonebstr, &driver_badgirls, &driver_genesis, &driver_txsector,
        &driver_victory,  &driver_arena,    &driver_raven,    &driver_rock,
        &driver_bighouse, &driver_bountyh,  &driver_tagteam,   &driver_excalibr,
        &driver_diamond,
        nullptr
    };

    extern GameOptions options;

    void pinmame_web_boot() {
        options.samplerate = 44100;
        const char* rom_name = (const char*)&g_shared_corridor[1000];
        int i = 0; bool found = false;
        while (drivers[i] != nullptr) {
            if (strcmp(drivers[i]->name, rom_name) == 0) {
                g_selected_game_index = i; found = true; break;
            }
            i++;
        }
        if (!found) g_selected_game_index = 0;
        bailing = 0;
        run_game(g_selected_game_index); 
    }
}