#!/bin/bash
set -e

SCRIPT_VERSION="WASM-GTS80B-PURE-GOLD-V36"

echo "=================================================="
echo "⚙️  COMPILATION PURIFIÉE PINMAME WASM - VERSION $SCRIPT_VERSION"
echo "=================================================="

EMSDK_DIR="/home/julien/emsdk"
if [ -f "$EMSDK_DIR/emsdk_env.sh" ]; then
    source "$EMSDK_DIR/emsdk_env.sh" > /dev/null 2>&1
    export PATH="$EMSDK_DIR/upstream/emscripten:$PATH"
elif [ -f "/etc/profile.d/emscripten.sh" ]; then
    source /etc/profile.d/emscripten.sh
fi

if ! command -v emcc &> /dev/null; then
    echo "❌ Erreur : emcc est introuvable."
    exit 1
fi

BASE_DIR=$(pwd)
NATIVE_WORKSPACE="$BASE_DIR/pinmame_workspace/pinmame_stock"
WASM_TEMP_OBJ_DIR="$BASE_DIR/pinmame_workspace_wasm_objs"

rm -f "libpinmame_wasm.a"
rm -rf "$WASM_TEMP_OBJ_DIR"
mkdir -p "$WASM_TEMP_OBJ_DIR"

# 🌟 EN-TÊTE DE MAP COMPATIBILITÉ ET EXTINCTION DES PROCESSEURS PARASITES
cat << 'EOF' > "$WASM_TEMP_OBJ_DIR/emscripten_macros.h"
#ifndef EMSCRIPTEN_MACROS_H
#define EMSCRIPTEN_MACROS_H

#undef __rolq
#undef __rorq
#define __rolq(x,c) (((unsigned long long)(x) << (c)) | ((unsigned long long)(x) >> (64 - (c))))
#define __rorq(x,c) (((unsigned long long)(x) >> (c)) | ((unsigned long long)(x) << (64 - (c))))

#ifndef INLINE
#define INLINE static inline
#endif
#ifndef inline
#define inline __inline__
#endif

// Définitions de types de processeurs requises pour compiler gts80.c sans erreur
#define CPU_I86 0
#define CPU_M6800 0
#define CPU_M6802 0
#define CPU_M6803 0
#define CPU_M6808 0
#define CPU_M6809 0

// Matériel requis et activé pour Gottlieb System 80B et System 3
#define HAS_M6502 1
#define HAS_M65C02 1
#define HAS_TMS7000 1
#define HAS_VOTRAXSC01 1
#define HAS_DAC 1
#define HAS_SAMPLES 1
#define HAS_YM2151 1
#define HAS_OKIM6295 1
#define PINMAME_GTS80 1

#define XMAMEROOT "."
#define NAME "pinmame"

#endif
EOF

EMCC_FLAGS="-O2 -g \
    -I$NATIVE_WORKSPACE/src \
    -I$NATIVE_WORKSPACE/src/wpc \
    -I$NATIVE_WORKSPACE/src/unix \
    -I$NATIVE_WORKSPACE/src/cores \
    -I$NATIVE_WORKSPACE/src/cpu \
    -I$NATIVE_WORKSPACE/src/zlib \
    -I$NATIVE_WORKSPACE/src/vidhrdw \
    -I$NATIVE_WORKSPACE/src/sound \
    -DUNIX \
    -DPINMAME \
    -DDECL_SPEC= \
    -DBMTYPE=UINT16 \
    -include $WASM_TEMP_OBJ_DIR/emscripten_macros.h"

cd "$NATIVE_WORKSPACE"

# 🌟 LA MATRICE SÉCURISÉE DES FICHIERS MAÎTRES DE MAME & GOTTLIEB
# On ne prend QUE les briques de base de l'émulateur et la plomberie Gottlieb.
# Cela évite les erreurs sur les 150 autres fabricants inutiles.
COEUR_PILES=(
    "src/mame.c" "src/common.c" "src/driver.c" "src/cpuintrf.c" "src/sndintrf.c"
    "src/memory.c" "src/timer.c" "src/state.c" "src/audit.c" "src/version.c"
    "src/artwork.c" "src/drawgfx.c" "src/palette.c" "src/profiler.c"
    "src/wpc/core.c" "src/wpc/sndbrd.c" "src/wpc/mech.c" "src/wpc/vp9.c"
    "src/wpc/gts3.c" "src/wpc/gts3games.c"
    "src/wpc/gts80.c" "src/wpc/gts80games.c" "src/wpc/gts80s.c" "src/wpc/gts80ss.c"
    "src/cpu/m6502/m6502.c" "src/cpu/tms7000/tms7000.c"
    "src/sound/votrax.c" "src/sound/dac.c" "src/sound/samples.c" "src/sound/ym2151.c" "src/sound/2151intf.c"
    "src/sound/streams.c" "src/sound/mixer.c" "src/sound/oki6295.c"
)

echo "[*] Compilation contrôlée du cœur de l'émulateur..."
for f in "${COEUR_PILES[@]}"; do
    if [ -f "$f" ]; then
        dir_obj="$WASM_TEMP_OBJ_DIR/$(dirname "$f")"
        mkdir -p "$dir_obj"
        b=$(basename "$f" .c)
        emcc $EMCC_FLAGS -c "$f" -o "$dir_obj/$b.o" &
        count=$((count + 1))
        if [ $((count % $(nproc))) -eq 0 ]; then wait; fi
    fi
done
wait

echo "[*] Compilation de la Zlib interne..."
if [ -d "src/zlib" ]; then
    mkdir -p "$WASM_TEMP_OBJ_DIR/zlib"
    for f in src/zlib/*.c; do
        if [ -f "$f" ]; then
            b=$(basename "$f" .c)
            emcc $EMCC_FLAGS -c "$f" -o "$WASM_TEMP_OBJ_DIR/zlib/$b.o" &
        fi
    done
fi
wait

echo "[*] Compilation du module d'E/S fileio..."
FILEIO_SRC=""
if [ -f "src/unix/fileio.c" ]; then FILEIO_SRC="src/unix/fileio.c"; elif [ -f "src/fileio.c" ]; then FILEIO_SRC="src/fileio.c"; fi
if [ -n "$FILEIO_SRC" ]; then
    emcc $EMCC_FLAGS -c "$FILEIO_SRC" -o "$WASM_TEMP_OBJ_DIR/fileio.o"
fi

echo "=== Empaquetage final de libpinmame_wasm.a ==="
cd "$WASM_TEMP_OBJ_DIR"
emar rcs "$BASE_DIR/libpinmame_wasm.a" $(find . -name "*.o")

cd "$BASE_DIR"
rm -rf "$WASM_TEMP_OBJ_DIR"

echo "=================================================="
echo "🟢 Bibliothèque statique NATIVE INTÉGRALE GTS80B générée !"
ls -lh "libpinmame_wasm.a"
echo "=================================================="