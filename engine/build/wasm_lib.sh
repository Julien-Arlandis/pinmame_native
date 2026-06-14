#!/bin/bash
set -e

# =========================================================================
# ⚙️ INFRASTRUCTURE PINMAME WASM - SCRIPT COMPILATION LIB STATIQUE
# 🏷️ VERSION : WASM-GTS80B-STRICT-SEQUENTIAL-V116.00 (WHITELIST SOUND H + SUPPRESSION DMDDEVICE + NETTOYAGE CLANG-M)
# =========================================================================

echo "=================================================="
echo "⚙️ COMPILATION PURIFIÉE PINMAME WASM - VERSION V116.00"
echo "=================================================="

EMSDK_DIR="/home/julien/emsdk"
if [ -f "$EMSDK_DIR/emsdk_env.sh" ]; then
    source "$EMSDK_DIR/emsdk_env.sh" > /dev/null 2>&1
    export PATH="$EMSDK_DIR/upstream/emscripten:$PATH"
elif [ -f "/etc/profile.d/emscripten.sh" ]; then
    source /etc/profile.d/emscripten.sh
fi

if ! command -v emcc &> /dev/null; then
    echo "❌ [V116.00] Erreur : emcc est introuvable."
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_ROOT="$(dirname "$ENGINE_DIR")"
WASM_TEMP_OBJ_DIR="$PROJECT_ROOT/pinmame_workspace_wasm_objs"

# Cherche la source PinMAME : pinmame_stripped (si existant) ou pinmame_workspace/pinmame_stock
if [ -d "$PROJECT_ROOT/pinmame_stripped/src" ]; then
    BUILD_WORKSPACE="$PROJECT_ROOT/pinmame_stripped"
elif [ -d "$PROJECT_ROOT/pinmame_workspace/pinmame_stock/src" ]; then
    BUILD_WORKSPACE="$PROJECT_ROOT/pinmame_workspace/pinmame_stock"
else
    echo "❌ [V116.00] Erreur : ni pinmame_stripped ni pinmame_workspace/pinmame_stock introuvable."
    exit 1
fi

rm -f "$ENGINE_DIR/out/libpinmame_wasm.a"
rm -rf "$WASM_TEMP_OBJ_DIR"
mkdir -p "$WASM_TEMP_OBJ_DIR/include"

# Répertoires src/ inutiles
echo "[*] Workspace source : $(du -sh "$BUILD_WORKSPACE/src" | cut -f1)"

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
EOF

EMCC_FLAGS=(
    "-O3"
    "-include" "$WASM_TEMP_OBJ_DIR/emscripten_macros.h"
    "-I$WASM_TEMP_OBJ_DIR/include"
    "-I$BUILD_WORKSPACE/src"
    "-I$BUILD_WORKSPACE/src/wpc"
    "-I$BUILD_WORKSPACE/src/machine"
    "-I$BUILD_WORKSPACE/src/unix"
    "-I$BUILD_WORKSPACE/src/cores"
    "-I$BUILD_WORKSPACE/src/cpu"
    "-I$BUILD_WORKSPACE/src/sound"
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

echo "[*] [V116.00] Compilation STRICTE du cœur de l'émulateur..."
for f in "${COEUR_PILES[@]}"; do
    if [ -f "$BUILD_WORKSPACE/$f" ]; then
        dir_obj="$WASM_TEMP_OBJ_DIR/$(dirname "$f")"
        mkdir -p "$dir_obj"
        b=$(basename "$f" .c)
        echo "   -> [V116.00] Compilation de $f..."
        emcc "${EMCC_FLAGS[@]}" -c "$BUILD_WORKSPACE/$f" -o "$dir_obj/$b.o"
    else
        echo "❌ [V116.00] Erreur fatale : Le fichier $BUILD_WORKSPACE/$f est introuvable !"
        exit 1
    fi
done

echo "[*] [V116.00] Compilation de la Zlib interne..."
if [ -d "$BUILD_WORKSPACE/src/zlib" ]; then
    mkdir -p "$WASM_TEMP_OBJ_DIR/zlib"
    for f in "$BUILD_WORKSPACE/src/zlib"/*.c; do
        if [ -f "$f" ]; then
            b=$(basename "$f" .c)
            emcc "${EMCC_FLAGS[@]}" -c "$f" -o "$WASM_TEMP_OBJ_DIR/zlib/$b.o"
        fi
    done
fi

echo "[*] [V116.00] Compilation du module d'E/S fileio..."
if [ -f "$BUILD_WORKSPACE/src/unix/fileio.c" ]; then
    mkdir -p "$WASM_TEMP_OBJ_DIR/src/unix"
    emcc "${EMCC_FLAGS[@]}" -Dosd_display_loading_rom_message=native_broken_osd_msg -c "$BUILD_WORKSPACE/src/unix/fileio.c" -o "$WASM_TEMP_OBJ_DIR/src/unix/fileio.o"
fi

echo "[*] [V116.00] Assemblage final de l'archive statique..."
mkdir -p "$ENGINE_DIR/out"
find "$WASM_TEMP_OBJ_DIR" -name "*.o" | xargs emar rcs "$ENGINE_DIR/out/libpinmame_wasm.a"

FILE_SIZE=$(du -sh "$ENGINE_DIR/out/libpinmame_wasm.a" | cut -f1)
echo "=================================================="
echo "🟢 [V116.00] libpinmame_wasm.a généré avec succès ! ($FILE_SIZE)"
echo "=================================================="