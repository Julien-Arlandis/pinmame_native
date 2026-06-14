#ifndef PINMAME_ESP32_CONFIG_H
#define PINMAME_ESP32_CONFIG_H

/* =========================================================================
 * pinmame_config.h — configuration de compilation PinMAME pour ESP32-S3
 * Équivalent de native_macros.h du build natif Mac/Linux.
 * Inclus via -include dans les COMPILE_OPTIONS du CMakeLists.txt.
 * ========================================================================= */

#include <stdint.h>
#include <stdlib.h>

/* Les types de base (UINT8, INT32, PAIR...) sont dans osd_cpu.h
 * qui est trouvé en premier via main/ dans les INCLUDE_DIRS.           */

/* --- Defines de build MAME/PinMAME --------------------------------------- */
#define PINMAME          1
#define NAME             "pinmame"
#define XMAMEROOT        "/spiffs/roms"

#define HAS_M6502        1
#define PINMAME_GTS80    1
#define CPU_I86          0
#define CPU_TMS7000      0

#ifndef PI
#define PI 3.14159265358979323846
#endif

#define HAS_CUSTOM       1
#define BUILD_CUSTOM     1
#define HAS_SAMPLES      1
#define BUILD_SAMPLES    1
#define HAS_VOTRAXSC01   1
#define BUILD_VOTRAXSC01 1
#define HAS_DAC          1
#define BUILD_DAC        1
#define HAS_AY8910       1
#define BUILD_AY8910     1
#define HAS_SP0250       1
#define BUILD_SP0250     1
#define HAS_OKIM6295     1
#define BUILD_OKIM6295   1
#define HAS_YM2151       1
#define HAS_YM2151_ALT   0
#define BUILD_YM2151     1
#define BUILD_OPM        1

#define SOUND_YM2203     999

#define PINMAME_NO_WPC      1
#define PINMAME_NO_STERN    1
#define PINMAME_NO_BALLY    1
#define PINMAME_NO_SEGA     1
#define PINMAME_NO_DATAEAST 1

#ifndef __rolq
#define __rolq(x,c) (((uint64_t)(x) << (c)) | ((uint64_t)(x) >> (64 - (c))))
#endif
#ifndef __rorq
#define __rorq(x,c) (((uint64_t)(x) >> (c)) | ((uint64_t)(x) << (64 - (c))))
#endif

/* --- OPM/YM2151 stubs déclarés en C ------------------------------------- */
#ifdef __cplusplus
extern "C" {
#endif
void OPMUpdateOne(int num, short **buffer, int length);
int  OPMInit(int num, int clock, int rate, void (*timer_handler)(int,int,int,double), void (*irq_handler)(int,int));
void OPMResetChip(int num);
void OPMShutdown(void);
void OPMSetPortHander(int num, void (*PortWrite)(unsigned int offset, unsigned char data));
#ifdef __cplusplus
}
#endif

/* --- Attribut PSRAM pour les gros buffers BSS --------------------------- */
/* Nécessite CONFIG_SPIRAM_ALLOW_BSS_SEG_EXTERNAL_MEMORY=y dans sdkconfig  */
#define PSRAM_BSS_ATTR __attribute__((section(".ext_ram.bss")))

#endif /* PINMAME_ESP32_CONFIG_H */
