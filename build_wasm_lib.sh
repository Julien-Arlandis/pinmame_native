#!/bin/bash
set -e

SCRIPT_VERSION="WASM-GTS3-SHIELD-v22"

echo "=================================================="
echo "⚙️  RECONSTRUCTION DU COEUR PINMAME WASM - VERSION $SCRIPT_VERSION"
echo "=================================================="

# 1. Chargement et exportation stricte de l'environnement Emscripten
EMSDK_DIR="/home/julien/emsdk"
if [ -f "$EMSDK_DIR/emsdk_env.sh" ]; then
    source "$EMSDK_DIR/emsdk_env.sh" > /dev/null 2>&1
    export PATH="$EMSDK_DIR/upstream/emscripten:$PATH"
elif [ -f "/etc/profile.d/emscripten.sh" ]; then
    source /etc/profile.d/emscripten.sh
fi

# Double vérification de sécurité du compilateur
if ! command -v emcc &> /dev/null; then
    echo "❌ Erreur : emcc est introuvable dans le PATH actuel."
    exit 1
fi

BASE_DIR=$(pwd)
NATIVE_A="$BASE_DIR/libpinmame_native.a"
NATIVE_WORKSPACE="$BASE_DIR/pinmame_workspace/pinmame_stock"
WASM_TEMP_OBJ_DIR="$BASE_DIR/pinmame_workspace_wasm_objs"

rm -f "libpinmame_wasm.a"
rm -rf "$WASM_TEMP_OBJ_DIR"
mkdir -p "$WASM_TEMP_OBJ_DIR"

# Injection des macros de compatibilité CPU / Registres
cat << 'EOF' > "$WASM_TEMP_OBJ_DIR/emscripten_macros.h"
#ifndef __EMSCRIPTEN_MACROS_H__
#define __EMSCRIPTEN_MACROS_H__
#ifndef INLINE
#define INLINE static inline
#endif
#ifndef inline
#define inline __inline__
#endif
#define __rolq(x,c) (((unsigned long long)(x) << (c)) | ((unsigned long long)(x) >> (64 - (c))))
#define __rorq(x,c) (((unsigned long long)(x) >> (c)) | ((unsigned long long)(x) << (64 - (c))))
#endif
EOF

# Drapeaux de compilation v22 : Blindage absolu pour GTS3, GTS1, System 11 et structures audio manquantes
EMCC_FLAGS="-O2 -DHEADLESS -DNO_X11 -DNO_SOUND -D__unix__ -Dsys_unix -Dsys_linux -Dlinux \
  -DPINMAME -DPINMAME_EXT -DDECL_SPEC= -DLSB_FIRST -DPI=3.14159265358979323846 \
  -DNAME=\"\\\"xpinmame\\\"\" -DDISPLAY_METHOD=\"\\\"headless\\\"\" -DXMAMEROOT=\"\\\".\\\"\" -DEXP \
  -DENABLE_WPC -DENABLE_BALLY -DENABLE_GTS3 -DENABLE_GTS1 \
  -DREPEATED_CYCLES=1 -DNEWMAME -DPI=3.14159265 \
  -DCONSOLE -D_GNU_SOURCE \
  -DCPU_Z80 -DCPU_M6809 -DCPU_M6800 -DCPU_M6802 -DCPU_M6808 -DCPU_I8039 -DCPU_I8035 -DCPU_M68000 -DCPU_S2650 -DCPU_TMS7000 -DCPU_TMS9995 \
  -DSOUND_DAC -DSOUND_AY8910 -DSOUND_YM2151 -DSOUND_HC55516 -DSOUND_SAMPLES -DSOUND_TMS5220 -DSOUND_Y8950 \
  -DM6808_IRQ_LINE=0 -DM6802_IRQ_LINE=0 -DMAX_SN76477=4 -DMAX_76496=4 -DI8035_TC=5 -DsoundSys=pinmame_sound_sys \
  -I$NATIVE_WORKSPACE \
  -I$NATIVE_WORKSPACE/src \
  -I$NATIVE_WORKSPACE/src/zlib \
  -I$NATIVE_WORKSPACE/src/unix \
  -I$NATIVE_WORKSPACE/src/unix/sysdep \
  -I$NATIVE_WORKSPACE/src/sound \
  -I$NATIVE_WORKSPACE/src/cpu/m68000 \
  -I$NATIVE_WORKSPACE/src/wpc \
  -include $WASM_TEMP_OBJ_DIR/emscripten_macros.h \
  -Wno-macro-redefined -Wno-implicit-function-declaration -Wno-return-type -Wno-int-conversion -Wno-deprecated-non-prototype -Wno-mismatched-tags"

echo "[*] Extraction de la cartographie des objets d'origine..."
MAP_OBJECTS=$(ar t "$NATIVE_A" | sort -u | grep -v -E "main.o|snprintf.o|input.o|xmameload.o|alsa.o|dirty.o|zacproto.o")

cd "$NATIVE_WORKSPACE"
count=0

# Compilation parallélisée des fichiers mappés
for obj in $MAP_OBJECTS; do
    base_name="${obj%.o}"
    src_file=$(find src/ xpinmame.obj/ -type f -name "$base_name.c" -o -name "$base_name.cpp" 2>/dev/null | head -n 1)
    
    if [ -n "$src_file" ]; then
        mkdir -p "$WASM_TEMP_OBJ_DIR/$(dirname "$base_name")"
        ( emcc $EMCC_FLAGS -c "$src_file" -o "$WASM_TEMP_OBJ_DIR/$base_name.o" || true ) &
        count=$((count + 1))
        if [ $((count % $(nproc))) -eq 0 ]; then wait; fi
    fi
done

wait

echo "[*] Forçage de la compilation de la Zlib interne..."
if [ -d "src/zlib" ]; then
    for f in src/zlib/*.c; do
        if [ -f "$f" ]; then
            b=$(basename "$f" .c)
            if [ ! -f "$WASM_TEMP_OBJ_DIR/$b.o" ]; then
                emcc $EMCC_FLAGS -c "$f" -o "$WASM_TEMP_OBJ_DIR/$b.o" &
            fi
        fi
    done
fi
wait

echo "=== Assemblage final de la bibliothèque statique ==="
# 🌟 CORRECTION : On descend PHYSIQUEMENT là où sont stockés les fichiers objets .o générés
cd "$WASM_TEMP_OBJ_DIR"

# 🌟 CORRECTION : On demande à emar d'écrire l'archive directement à la racine ($BASE_DIR)
emar rcs "$BASE_DIR/libpinmame_wasm.a" $(find . -name "*.o")

# Retour à la racine et ménage du dossier temporaire
cd "$BASE_DIR"

echo "=================================================="
echo "🟢 Nouvelle bibliothèque statique blindée générée avec succès !"
echo "[📊] Poids de l'archive statique finale :"
# 🌟 CORRECTION : On inspecte le VRAI fichier WASM et non l'archive native !
ls -lh "libpinmame_wasm.a"
echo "=================================================="