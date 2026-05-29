#ifndef EMSCRIPTEN_MACROS_H_V112
#define EMSCRIPTEN_MACROS_H_V112

#include <stdint.h>

#define PINMAME 1
#define NAME "pinmame"
#define XMAMEROOT "/roms"

#define HAS_M6502 1
#define PINMAME_GTS80 1
#define CPU_I86 0
#define CPU_TMS7000 0

#ifndef PI
#define PI 3.14159265358979323846
#endif

#define HAS_CUSTOM 1
#define BUILD_CUSTOM 1
#define HAS_SAMPLES 1
#define BUILD_SAMPLES 1
#define HAS_VOTRAXSC01 1
#define BUILD_VOTRAXSC01 1
#define HAS_DAC 1
#define BUILD_DAC 1
#define HAS_AY8910 1
#define BUILD_AY8910 1
#define HAS_SP0250 1
#define BUILD_SP0250 1
#define HAS_OKIM6295 1   
#define BUILD_OKIM6295 1 

#define HAS_YM2151 1
#define BUILD_YM2151 1
#define BUILD_OPM 1      
#define HAS_YM2203 1     
#define BUILD_YM2203 1
#define BUILD_OPN 1      

#define PINMAME_NO_WPC 1
#define PINMAME_NO_WILLIAMS 1
#define PINMAME_NO_STERN 1
#define PINMAME_NO_BALLY 1
#define PINMAME_NO_SEGA 1
#define PINMAME_NO_DATAEAST 1

#ifndef __rolq
#define __rolq(x,c) (((uint64_t)(x) << (c)) | ((uint64_t)(x) >> (64 - (c))))
#endif
#ifndef __rorq
#define __rorq(x,c) (((uint64_t)(x) >> (c)) | ((uint64_t)(x) << (64 - (c))))
#endif

// 🌟 INJECTION DOUBLE-BLINDÉE DES PROTOTYPES NATIFS DE LA PUCE YM2151
// Utilisation de la syntaxe C-parentheses vides () pour accepter n'importe quel pointeur de fonction
#ifdef __cplusplus
extern "C" {
#endif
int OPMInit(int num, int clock, int rate, void (*timer_handler)(), void (*irq_handler)());
void OPMShutdown(void);
void OPMResetChip(int num);
void OPMUpdateOne(int num, short **buffer, int length);
#ifdef __cplusplus
}
#endif

#endif
