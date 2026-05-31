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

/* 🌟 LE RECENTRAGE NATIF ABSOLU 🌟 */
/* On active YM2151 ET le moteur natif OPM de MAME */
#define HAS_YM2151 1
#define HAS_YM2151_ALT 0
#define BUILD_YM2151 1
#define BUILD_OPM 1

#define SOUND_YM2203 999

#define PINMAME_NO_WPC 1
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

/* 🛡️ LE BOUCLIER POUR LA LIGNE 156 (Résout l'erreur undeclared identifier) 🛡️ */
#ifdef __cplusplus
extern "C" {
#endif
void OPMUpdateOne(int num, short **buffer, int length);
int OPMInit(int num, int clock, int rate, void (*timer_handler)(int, int, int, double), void (*irq_handler)(int, int));
void OPMResetChip(int num);
void OPMShutdown(void);
void OPMSetPortHander(int num, void (*PortWrite)(unsigned int offset, unsigned char data));
#ifdef __cplusplus
}
#endif

#endif
