#!/bin/bash
set -e

# =========================================================================
# ⚙️ INFRASTRUCTURE PINMAME WASM - SCRIPT COMPILATION LIB STATIQUE
# 🏷️ VERSION : WASM-GTS80B-STRICT-SEQUENTIAL-V112.21 (PRODUCTION CORES)
# =========================================================================

echo "=================================================="
echo "⚙️ COMPILATION PURIFIÉE PINMAME WASM - VERSION V112.21"
echo "=================================================="

EMSDK_DIR="/home/julien/emsdk"
if [ -f "$EMSDK_DIR/emsdk_env.sh" ]; then
    source "$EMSDK_DIR/emsdk_env.sh" > /dev/null 2>&1
    export PATH="$EMSDK_DIR/upstream/emscripten:$PATH"
elif [ -f "/etc/profile.d/emscripten.sh" ]; then
    source /etc/profile.d/emscripten.sh
fi

if ! command -v emcc &> /dev/null; then
    echo "❌ [V112.21] Erreur : emcc est introuvable."
    exit 1
fi

BASE_DIR=$(pwd)
NATIVE_WORKSPACE="$BASE_DIR/pinmame_workspace/pinmame_stock"
WASM_TEMP_OBJ_DIR="$BASE_DIR/pinmame_workspace_wasm_objs"

rm -f "libpinmame_wasm.a"
rm -rf "$WASM_TEMP_OBJ_DIR"
mkdir -p "$WASM_TEMP_OBJ_DIR/include"

# GÉNÉRATION DU HEADER SYSTÈME
cat << 'EOF' > "$WASM_TEMP_OBJ_DIR/include/osd_cpu.h"
#ifndef OSD_CPU_H_V112
#define OSD_CPU_H_V112

#include <stdint.h>
#include <stdlib.h>

typedef uint8_t UINT8;
typedef int8_t INT8;
typedef uint16_t UINT16;
typedef int16_t INT16;
typedef uint32_t UINT32;
typedef int32_t INT32;
typedef uint64_t UINT64;
typedef int64_t INT64;

#define LSB_FIRST 1

typedef union {
    struct { UINT8 l, h, h2, h3; } b;
    struct { UINT16 l, h; } w;
    UINT32 d;
} PAIR;

typedef union {
    struct { UINT32 l, h; } d;
    UINT64 q;
} PAIR64;

#endif
EOF

# GÉNÉRATION DES MACROS MATÉRIELLES (INJECTION ALIGNÉE)
cat << 'EOF' > "$WASM_TEMP_OBJ_DIR/emscripten_macros.h"
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

#define PINMAME_NO_WPC 1
#define PINMAME_NO_WILLIAMS 1
#define PINMAME_NO_STERN 1
#define PINMAME_NO_BALLY 1
#define PINMAME_NO_SEGA 1
#define PINMAME_NO_DATAEAST 1

#define SOUND_YM2203 999

#ifndef __rolq
#define __rolq(x,c) (((uint64_t)(x) << (c)) | ((uint64_t)(x) >> (64 - (c))))
#endif
#ifndef __rorq
#define __rorq(x,c) (((uint64_t)(x) >> (c)) | ((uint64_t)(x) << (64 - (c))))
#endif

#ifdef __cplusplus
extern "C" {
#endif
void OPMUpdateOne(int num, int16_t **buffer, int length);
int OPMInit(int num, int clock, int rate, void (*timer_handler)(int, int, int, double), void (*irq_handler)(int, int));
void OPMShutdown(void);
void OPMResetChip(int num);
#ifdef __cplusplus
}
#endif

#endif
EOF

EMCC_FLAGS=(
    "-O3"
    "-include" "$WASM_TEMP_OBJ_DIR/emscripten_macros.h"
    "-DHAS_YM2151=1"
    "-DBUILD_YM2151=1"
    "-DBUILD_OPM=1"
    "-I$WASM_TEMP_OBJ_DIR/include"
    "-I$NATIVE_WORKSPACE/src"
    "-I$NATIVE_WORKSPACE/src/wpc"
    "-I$NATIVE_WORKSPACE/src/machine"
    "-I$NATIVE_WORKSPACE/src/unix"
    "-I$NATIVE_WORKSPACE/src/cores"
    "-I$NATIVE_WORKSPACE/src/cpu"
    "-I$NATIVE_WORKSPACE/src/sound"
    "-DINLINE=static inline"
    "-Wno-implicit-function-declaration"
    "-Wno-static-in-inline"
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

if [ -f "$NATIVE_WORKSPACE/src/mame.c" ]; then
    echo "[*] [V112.21] Application du court-circuit de sécurité sur video_init()..."
    sed -i 's/int old_video_init_disabled(void)/int video_init(void)/' "$NATIVE_WORKSPACE/src/mame.c"
    sed -i 's/int video_init[[:space:]]*(void)/int video_init(void) { return 0; } int old_video_init_disabled(void)/' "$NATIVE_WORKSPACE/src/mame.c"
fi

echo "[*] [V112.21] Compilation STRICTE du cœur de l'émulateur..."
for f in "${COEUR_PILES[@]}"; do
    if [ -f "$NATIVE_WORKSPACE/$f" ]; then
        dir_obj="$WASM_TEMP_OBJ_DIR/$(dirname "$f")"
        mkdir -p "$dir_obj"
        b=$(basename "$f" .c)
        echo "   -> [V112.21] Compilation de $f..."
        emcc "${EMCC_FLAGS[@]}" -c "$NATIVE_WORKSPACE/$f" -o "$dir_obj/$b.o"
    else
        echo "❌ [V112.21] Erreur fatale : Le fichier $NATIVE_WORKSPACE/$f est introuvable !"
        exit 1
    fi
done

echo "[*] [V112.21] Compilation de la Zlib interne..."
if [ -d "$NATIVE_WORKSPACE/src/zlib" ]; then
    mkdir -p "$WASM_TEMP_OBJ_DIR/zlib"
    for f in "$NATIVE_WORKSPACE/src/zlib"/*.c; do
        if [ -f "$f" ]; then
            b=$(basename "$f" .c)
            emcc "${EMCC_FLAGS[@]}" -c "$f" -o "$WASM_TEMP_OBJ_DIR/zlib/$b.o"
        fi
    done
fi

echo "[*] [V112.21] Compilation du module d'E/S fileio..."
if [ -f "$NATIVE_WORKSPACE/src/unix/fileio.c" ]; then
    mkdir -p "$WASM_TEMP_OBJ_DIR/src/unix"
    emcc "${EMCC_FLAGS[@]}" -Dosd_display_loading_rom_message=native_broken_osd_msg -c "$NATIVE_WORKSPACE/src/unix/fileio.c" -o "$WASM_TEMP_OBJ_DIR/src/unix/fileio.o"
fi

echo "[*] [V112.21] Assemblage final de l'archive statique..."
find "$WASM_TEMP_OBJ_DIR" -name "*.o" | xargs emar rcs "libpinmame_wasm.a"

FILE_SIZE=$(du -sh "libpinmame_wasm.a" | cut -f1)
echo "=================================================="
echo "🟢 [V112.21] libpinmame_wasm.a généré avec succès ! ($FILE_SIZE)"
echo "=================================================="