// 🌟 1. BLINDAGE DES ROTATIONS (Placé tout en haut pour devancer common.h)
#ifndef __rolq
#define __rolq(x,c) (((unsigned long long)(x) << (c)) | ((unsigned long long)(x) >> (64 - (c))))
#endif
#ifndef __rorq
#define __rorq(x,c) (((unsigned long long)(x) >> (c)) | ((unsigned long long)(x) << (64 - (c))))
#endif

#ifndef INLINE
#define INLINE static inline
#endif
#ifndef inline
#define inline __inline__
#endif

#include <iostream>
#include <cstdio>
#include <stdint.h>

extern "C" {
    int run_game(int game_num);
    unsigned int cpunum_get_reg(int cpunum, int regnum);
    uint8_t cpu_readmem16(int offset);
}

#define DISPLAY_BUFFER_SIZE 100
static char g_display_text[DISPLAY_BUFFER_SIZE] = {0};
static uint8_t g_dummy_buffer[1024] = {0};

// =========================================================================
// 🌟 IMPLÉMENTATION ALIGNÉE DES COUCHES OSD (SIGNATURES CORRIGÉES)
// =========================================================================
extern "C" {
    // Signature validée par le linker : (int) -> void
    void osd_update_video_and_audio(int force) {
        unsigned int current_pc = 0;
        char buff_gottlieb[17];
        
        try {
            current_pc = cpunum_get_reg(0, 1); // REG_PC du 6502
            
            for (int i = 0; i < 16; i++) {
                uint8_t val = cpu_readmem16(0x3C00 + i); // Registres d'affichage Gottlieb
                buff_gottlieb[i] = (val >= 32 && val <= 126) ? (char)val : '.';
            }
            buff_gottlieb[16] = '\0';
        } catch(...) {
            std::snprintf(buff_gottlieb, 17, "BOOTING SYSTEM..");
        }

        if (current_pc != 0) {
            std::snprintf(g_display_text, DISPLAY_BUFFER_SIZE, "PC: 0x%04X | DISPLAY: [%s]", current_pc, buff_gottlieb);
            std::cout << "[📺 MAME OSD FRAME] " << g_display_text << std::endl;
        }
    }

    // Signature validée par le linker : (int, int) -> int
    int osd_display_loading_rom_message(int current, int total) {
        std::cout << "[📦 MAME VFS LOAD] Progression : " << current << " / " << total << std::endl;
        return 0; // 0 indique à MAME de poursuivre l'opération sans interruption
    }
}

// =========================================================================
// INTERFACE DE LIAISON HÔTE JAVASCRIPT
// =========================================================================
extern "C" {
    uint8_t* pinmame_get_gprom_ptr() { return g_dummy_buffer; }
    uint8_t* pinmame_get_dsprom_ptr() { return g_dummy_buffer; }
    const char* pinmame_get_display() { return g_display_text; }
    const char* pinmame_get_version() { return "PinMAME WASM Headless OSD-Driven v36.2"; }

    void pinmame_web_entry(int gprom_size, int dsprom_size) {
        std::cout << "[⚙️ C++] Enregistrement des hooks d'affichage..." << std::endl;
        std::snprintf(g_display_text, DISPLAY_BUFFER_SIZE, "OSD READY");
    }

    void pinmame_web_boot() {
        std::cout << "[⚡ C++] run_game(0) synchronisé démarré." << std::endl;
        try {
            run_game(0); 
            std::cout << "[✅ C++] Arrêt normal." << std::endl;
        } catch(...) {
            std::cerr << "[❌ C++] Exception levée par la boucle d'exécution." << std::endl;
        }
    }

    void pinmame_web_tick(int cycles) {
        // Géré en interne de manière autonome
    }
}