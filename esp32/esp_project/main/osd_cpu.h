#pragma once
/* osd_cpu.h — remplace pinmame_workspace/src/unix/osd_cpu.h pour ESP32-S3
 * Ce fichier est trouvé en premier (main/ est en tête des INCLUDE_DIRS),
 * ce qui empêche l'inclusion du osd_cpu.h unix incompatible. */

#include <stdint.h>
#include <stdlib.h>

typedef uint8_t  UINT8;  typedef int8_t  INT8;
typedef uint16_t UINT16; typedef int16_t INT16;
typedef uint32_t UINT32; typedef int32_t INT32;
typedef uint64_t UINT64; typedef int64_t INT64;

#define LSB_FIRST 1

typedef union { struct { UINT8 l,h,h2,h3; } b; struct { UINT16 l,h; } w; UINT32 d; } PAIR;
typedef union { struct { UINT32 l,h; } d; UINT64 q; } PAIR64;
