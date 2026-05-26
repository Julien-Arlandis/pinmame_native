#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdint>
#include <emscripten.h>

struct core_tGlobals {
    struct { unsigned short w; } segments[40];
};

extern "C" {
    extern struct core_tGlobals coreGlobals;
    int run_game(int game_index);
    
    // Remplacement par la fonction de mise à jour stable de la boucle principale de PinMAME
    void core_gameUpdate(void); 
}

static char display_buffer[41]; 

// Tampons statiques alimentés par le JS
static uint8_t gprom_data[8192];
static uint8_t dsprom_data[8192];
static int gprom_size = 0;
static int dsprom_size = 0;

struct VirtualFile {
    const uint8_t* data;
    int size;
    int offset;
};

extern "C" {

EMSCRIPTEN_KEEPALIVE const char* pinmame_get_version() { return "2.8.0-CORE-UPDATE-ACTIVE"; }

EMSCRIPTEN_KEEPALIVE const char* pinmame_get_display() {
    memset(display_buffer, ' ', 40);
    display_buffer[40] = '\0';
    for (int i = 0; i < 40; i++) {
        char c = (char)(coreGlobals.segments[i].w & 0x7F); 
        display_buffer[i] = (c >= 32 && c <= 126) ? c : ' ';
    }
    return display_buffer;
}

EMSCRIPTEN_KEEPALIVE uint8_t* pinmame_get_gprom_ptr() { return gprom_data; }
EMSCRIPTEN_KEEPALIVE uint8_t* pinmame_get_dsprom_ptr() { return dsprom_data; }

EMSCRIPTEN_KEEPALIVE void pinmame_web_tick(int cycles) {
    // Fait avancer les cycles d'émulation de la machine
    core_gameUpdate();
}

EMSCRIPTEN_KEEPALIVE int pinmame_web_entry(int cpu_sz, int dsp_sz) {
    gprom_size = cpu_sz;
    dsprom_size = dsp_sz;

    printf("[⚙ C++] Virtual Hook Loaded: CPU=%d bytes, DSP=%d bytes\n", gprom_size, dsprom_size);

    for(int i = 0; i < 40; i++) coreGlobals.segments[i].w = 0;

    return run_game(0);
}

// 🌟 LE HOOK FORCE : Surchargé et marqué attribut "used" pour le Linker
__attribute__((used)) void* osd_fopen(const char *gamename, const char *filename, int filetype, int openmode) {
    if (filename != nullptr && (strcmp(filename, "gprom.bin") == 0 || strstr(filename, "prom1") != NULL)) {
        VirtualFile* vfile = (VirtualFile*)malloc(sizeof(VirtualFile));
        vfile->data = gprom_data;
        vfile->size = gprom_size;
        vfile->offset = 0;
        return (void*)vfile;
    }
    
    if (filename != nullptr && (strcmp(filename, "dsprommz.bin") == 0 || strstr(filename, "prom2") != NULL)) {
        VirtualFile* vfile = (VirtualFile*)malloc(sizeof(VirtualFile));
        vfile->data = dsprom_data;
        vfile->size = dsprom_size;
        vfile->offset = 0;
        return (void*)vfile;
    }
    return nullptr; 
}

int osd_fread(void *file, void *buffer, int length) {
    if (!file) return 0;
    VirtualFile* vfile = (VirtualFile*)file;
    int available = vfile->size - vfile->offset;
    if (length > available) length = available;
    if (length > 0) {
        memcpy(buffer, vfile->data + vfile->offset, length);
        vfile->offset += length;
    }
    return length;
}

void osd_fclose(void *file) {
    if (file) free(file);
}

int osd_fseek(void *file, int64_t offset, int whence) { return 0; }
int osd_display_loading_rom_message(const char *name, int current) { return 0; }
void osd_update_video_and_audio(int forced) {}
#define HARD_STUB(name) EMSCRIPTEN_KEEPALIVE void name(void* g) {}
HARD_STUB(construct_gts3_1as) HARD_STUB(construct_gts3_21) HARD_STUB(construct_GP1) HARD_STUB(construct_GTS1C)
}