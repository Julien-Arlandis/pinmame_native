#!/bin/bash
set -e

# =========================================================================
# BUILD NATIF PINMAME — Mac/Linux
# Produit : ./tilt_esp32 <rom>
# 🏷️ VERSION : NATIVE-V1.0
# Usage  : ./tilt_esp32 bonebstr 2>/dev/null | aplay -f S16_LE -r 44100 -c 2
# macOS  : ./tilt_esp32 bonebstr 2>/dev/null | ffplay -f s16le -ar 44100 -ac 2 -i pipe:0
# =========================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENGINE_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_ROOT="$(dirname "$ENGINE_DIR")"
OBJ_DIR="$SCRIPT_DIR/tilt_esp32_objs"
OUTPUT="$SCRIPT_DIR/tilt_esp32"

if [ -d "$PROJECT_ROOT/pinmame_stripped/src" ]; then
    BUILD_WORKSPACE="$PROJECT_ROOT/pinmame_stripped"
elif [ -d "$ENGINE_DIR/workspace/pinmame_stock/src" ]; then
    BUILD_WORKSPACE="$ENGINE_DIR/workspace/pinmame_stock"
else
    echo "❌ [NATIVE-V1.0] ni pinmame_stripped ni workspace/pinmame_stock introuvable."
    exit 1
fi

# Détection du compilateur
if [[ "$(uname)" == "Darwin" ]]; then
    CC=clang; CXX=clang++
else
    CC=gcc; CXX=g++
fi

echo "=================================================="
echo "🔨 BUILD NATIF PINMAME V1.0 — $(uname -m)"
echo "=================================================="

rm -rf "$OBJ_DIR"
mkdir -p "$OBJ_DIR/include"

# --- osd_cpu.h (types de base MAME) ---
cat << 'HEOF' > "$OBJ_DIR/include/osd_cpu.h"
#ifndef OSD_CPU_H_V112
#define OSD_CPU_H_V112
#include <stdint.h>
#include <stdlib.h>
typedef uint8_t UINT8; typedef int8_t INT8;
typedef uint16_t UINT16; typedef int16_t INT16;
typedef uint32_t UINT32; typedef int32_t INT32;
typedef uint64_t UINT64; typedef int64_t INT64;
#define LSB_FIRST 1
typedef union { struct { UINT8 l,h,h2,h3; } b; struct { UINT16 l,h; } w; UINT32 d; } PAIR;
typedef union { struct { UINT32 l,h; } d; UINT64 q; } PAIR64;
#endif
HEOF

# --- native_macros.h (équivalent de emscripten_macros.h) ---
cat << 'HEOF' > "$OBJ_DIR/native_macros.h"
#ifndef NATIVE_MACROS_H_V1
#define NATIVE_MACROS_H_V1
#include <stdint.h>
#define PINMAME 1
#define NAME "pinmame"
#define XMAMEROOT "./roms"
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
#endif
HEOF

if [[ "${DEBUG:-0}" == "1" ]]; then
    OPT_FLAGS=("-O0" "-g" "-fsanitize=address")
    LDFLAGS=("-fsanitize=address")
else
    OPT_FLAGS=("-O2")
    LDFLAGS=()
fi

FLAGS=(
    "${OPT_FLAGS[@]}"
    "-include" "$OBJ_DIR/native_macros.h"
    "-I$OBJ_DIR/include"
    "-I$BUILD_WORKSPACE/src"
    "-I$BUILD_WORKSPACE/src/wpc"
    "-I$BUILD_WORKSPACE/src/machine"
    "-I$BUILD_WORKSPACE/src/unix"
    "-I$BUILD_WORKSPACE/src/cores"
    "-I$BUILD_WORKSPACE/src/cpu"
    "-I$BUILD_WORKSPACE/src/sound"
    "-DINLINE=static inline"
    "-Wno-implicit-function-declaration"
    "-D_FORTIFY_SOURCE=0"
)

COEUR_PILES=(
    "src/mame.c" "src/common.c" "src/cpuintrf.c" "src/memory.c"
    "src/timer.c" "src/palette.c" "src/state.c"
    "src/cpuexec.c" "src/sndintrf.c" "src/fileio.c" "src/inptport.c" "src/hash.c"
    "src/cpuint.c" "src/unzip.c" "src/md5.c" "src/sha1.c" "src/config.c" "src/input.c"
    "src/cpu/m6502/m6502.c"
    "src/wpc/gts80.c" "src/wpc/gts80s.c" "src/wpc/gts80games.c" "src/wpc/core.c"
    "src/wpc/sim.c" "src/wpc/sndbrd.c" "src/wpc/snd_cmd.c" "src/wpc/mech.c"
    "src/machine/6532riot.c" "src/machine/6530riot.c"
    "src/sound/dac.c" "src/sound/ym2151.c" "src/sound/2151intf.c" "src/sound/fm.c"
    "src/sound/streams.c" "src/sound/mixer.c" "src/sound/filter.c"
    "src/sound/ay8910.c" "src/sound/sp0250.c" "src/sound/samples.c"
    "src/sound/votrax.c"
)

echo "[*] Compilation du cœur PinMAME..."
ALL_OBJS=()
for f in "${COEUR_PILES[@]}"; do
    src="$BUILD_WORKSPACE/$f"
    if [ ! -f "$src" ]; then
        echo "❌ Fichier manquant : $src"; exit 1
    fi
    dir_obj="$OBJ_DIR/$(dirname "$f")"
    mkdir -p "$dir_obj"
    b=$(basename "$f" .c)
    obj="$dir_obj/$b.o"
    $CC "${FLAGS[@]}" -c "$src" -o "$obj"
    ALL_OBJS+=("$obj")
done

echo "[*] Compilation de la zlib interne..."
if [ -d "$BUILD_WORKSPACE/src/zlib" ]; then
    mkdir -p "$OBJ_DIR/zlib"
    for f in "$BUILD_WORKSPACE/src/zlib"/*.c; do
        [ -f "$f" ] || continue
        b=$(basename "$f" .c)
        obj="$OBJ_DIR/zlib/$b.o"
        $CC "${FLAGS[@]}" -c "$f" -o "$obj"
        ALL_OBJS+=("$obj")
    done
fi

echo "[*] Compilation de fileio Unix..."
if [ -f "$BUILD_WORKSPACE/src/unix/fileio.c" ]; then
    mkdir -p "$OBJ_DIR/src/unix"
    obj="$OBJ_DIR/src/unix/fileio.o"
    $CC "${FLAGS[@]}" -Dosd_display_loading_rom_message=native_broken_osd_msg \
        -c "$BUILD_WORKSPACE/src/unix/fileio.c" -o "$obj"
    ALL_OBJS+=("$obj")
fi

echo "[*] Compilation de api.cpp + hal_native.cpp + main_native.cpp + stubs..."
# -DMAME_DEBUG : force osdepend.h à déclarer logerror (pas de static inline no-op)
# ce qui permet à api.cpp de définir sa propre version
$CXX "${FLAGS[@]}" "-I$ENGINE_DIR" -DMAME_DEBUG -std=c++17 -c "$ENGINE_DIR/api.cpp"  -o "$OBJ_DIR/api.o"
$CXX "${FLAGS[@]}" "-I$ENGINE_DIR" -std=c++17 -c hal_native.cpp  -o "$OBJ_DIR/hal_native.o"
$CXX "${FLAGS[@]}" "-I$ENGINE_DIR" -std=c++17 -c main_native.cpp -o "$OBJ_DIR/main_native.o"
$CC  "${FLAGS[@]}"               -c stubs_native.c             -o "$OBJ_DIR/stubs_native.o"
$CC  "${FLAGS[@]}"               -c driver0_native.c           -o "$OBJ_DIR/driver0_native.o"
ALL_OBJS+=("$OBJ_DIR/api.o" "$OBJ_DIR/hal_native.o" "$OBJ_DIR/main_native.o" "$OBJ_DIR/stubs_native.o" "$OBJ_DIR/driver0_native.o")

echo "[*] Édition des liens → $OUTPUT"
$CXX "${ALL_OBJS[@]}" "${LDFLAGS[@]}" -o "$OUTPUT" -lm -lpthread -lz

SIZE=$(ls -lh "$OUTPUT" | awk '{print $5}')
echo "=================================================="
echo "✅ [NATIVE-V1.0] $OUTPUT généré ($SIZE)"
echo "=================================================="
echo "Usage:"
echo "  ./tilt_esp32 bonebstr 2>/dev/null | ffplay -f s16le -ar 44100 -ac 2 -i pipe:0"
echo "  ./tilt_esp32 bonebstr 2>/dev/null | aplay -f S16_LE -r 44100 -c 2"
echo "=================================================="
