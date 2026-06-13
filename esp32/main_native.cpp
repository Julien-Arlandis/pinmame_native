// =========================================================================
// main_native.cpp — point d'entrée natif Mac/Linux
// Équivalent du Worker Node.js de tilt
// Usage : ./tilt_esp32 <rom>   ex: ./tilt_esp32 bonebstr
// =========================================================================
#include <stdio.h>
#include <string.h>
#include <stdint.h>
#include <pthread.h>
#include <signal.h>
#include <execinfo.h>
#include <stdlib.h>
#include <unistd.h>

static void sigsegv_handler(int sig) {
    void* bt[32];
    int n = backtrace(bt, 32);
    fprintf(stderr, "\n[CRASH] signal %d\n", sig);
    backtrace_symbols_fd(bt, n, 2);
    _exit(139);
}
static void install_sighandler(void) {
    struct sigaction sa = {};
    sa.sa_handler = sigsegv_handler;
    sigaction(SIGSEGV, &sa, NULL);
    sigaction(SIGBUS,  &sa, NULL);
    sigaction(SIGABRT, &sa, NULL);
}

// API PinMAME (api.cpp)
extern "C" {
    uint8_t* pinmame_get_dsprom_ptr(void);
    void     pinmame_web_boot(void);
}

// Thread d'entrée clavier stdin (commandes @set: comme runtime.js)
static volatile int g_running = 1;

static void* stdin_thread(void* arg) {
    (void)arg;
    uint8_t* corridor = pinmame_get_dsprom_ptr();
    char line[128];
    while (g_running && fgets(line, sizeof(line), stdin)) {
        // Protocole identique à runtime.js : "@set:id=X&state=Y"
        if (strncmp(line, "@set:", 5) == 0) {
            int id = 0, state = 0;
            sscanf(line + 5, "id=%d&state=%d", &id, &state);
            if (id >= 0 && id < 80) {
                // g_shared_corridor[700 + id] = état du switch
                corridor[700 + id] = (uint8_t)state;
                fprintf(stderr, "[SW] %d=%d\n", id, state);
            }
        }
        // "@dip:mask=X" → dipswitch
        else if (strncmp(line, "@dip:", 5) == 0) {
            int mask = 0;
            sscanf(line + 5, "mask=%d", &mask);
            corridor[800] = (uint8_t)mask;
            fprintf(stderr, "[DIP] mask=0x%02X\n", mask);
        }
    }
    return nullptr;
}

int main(int argc, char* argv[]) {
    const char* rom = (argc > 1) ? argv[1] : "bonebstr";

    install_sighandler();
    fprintf(stderr, "PinMAME natif — ROM: %s\n", rom);
    fprintf(stderr, "Audio PCM s16le 44100Hz 2ch sur stdout\n");
    fprintf(stderr, "Affichage + logs sur stderr\n");
    fprintf(stderr, "Commandes stdin: @set:id=X&state=Y  @dip:mask=X\n");

    // Écrire le nom de la ROM dans le corridor partagé (offset 1000, comme runtime.js)
    uint8_t* corridor = pinmame_get_dsprom_ptr();
    strncpy((char*)(corridor + 1000), rom, 20);
    corridor[1000 + strnlen(rom, 20)] = '\0';

    // Thread stdin pour les commandes
    pthread_t tid;
    pthread_create(&tid, nullptr, stdin_thread, nullptr);
    pthread_detach(tid);

    // Lance l'émulation (bloquant jusqu'à osd_exit ou Ctrl-C)
    pinmame_web_boot();

    g_running = 0;
    return 0;
}
