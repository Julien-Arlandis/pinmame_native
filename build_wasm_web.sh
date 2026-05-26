#!/bin/bash
set -e

SCRIPT_VERSION="WASM-WEB-LINKER-v5.2-NO-MAIN"

echo "=================================================="
echo "🔗 LIAISON GLOBALE : VERSION $SCRIPT_VERSION"
echo "=================================================="

# 1. Chargement de l'environnement Emscripten
EMSDK_DIR="/home/julien/emsdk"
if [ -f "$EMSDK_DIR/emsdk_env.sh" ]; then
    source "$EMSDK_DIR/emsdk_env.sh" > /dev/null 2>&1
    export PATH="$EMSDK_DIR/upstream/emscripten:$PATH"
elif [ -f "/etc/profile.d/emscripten.sh" ]; then
    source /etc/profile.d/emscripten.sh
fi

SRC_DIR=$(pwd)
LIB_WASM_A="$SRC_DIR/libpinmame_wasm.a"
NATIVE_WORKSPACE="$SRC_DIR/pinmame_workspace/pinmame_stock"
OUTPUT_DIR="$SRC_DIR"

if [ ! -f "$LIB_WASM_A" ]; then
    echo "💥 Erreur : La bibliothèque statique $LIB_WASM_A est introuvable !"
    exit 1
fi

echo "[*] Liaison chirurgicale avec ré-injection des chemins d'inclusion MAME..."

INCLUDES="-I$NATIVE_WORKSPACE/src -I$NATIVE_WORKSPACE/src/wpc -I$NATIVE_WORKSPACE/src/unix -I$NATIVE_WORKSPACE/src/cores -I$NATIVE_WORKSPACE/src/cpu -I$NATIVE_WORKSPACE/src/sound"

# 🌟 NETTOYAGE : On retire définitivement "_main" de la liste des fonctions exportées
EXPORT_FUNCS='["_pinmame_get_version","_pinmame_get_gprom_ptr","_pinmame_get_dsprom_ptr","_pinmame_get_display","_pinmame_web_entry","_pinmame_web_boot","_pinmame_web_tick"]'
EXPORT_METHODS='["FS", "cwrap", "ccall", "HEAPU8"]'

# Exécution de la compilation croisée
emcc "$SRC_DIR/api.cpp" $INCLUDES \
  -Wl,--whole-archive "$LIB_WASM_A" -Wl,--no-whole-archive \
  -O2 \
  -g \
  -s WASM=1 \
  -s ASYNCIFY=1 \
  -s ASYNCIFY_STACK_SIZE=131072 \
  -s MODULARIZE=1 \
  -s EXPORT_NAME="createPinMAME" \
  -s WARN_ON_UNDEFINED_SYMBOLS=0 \
  -s ERROR_ON_UNDEFINED_SYMBOLS=0 \
  -Wl,--allow-undefined \
  -Wl,--unresolved-symbols=ignore-all \
  -Wl,--allow-multiple-definition \
  -s EXPORTED_FUNCTIONS="$EXPORT_FUNCS" \
  -s EXPORTED_RUNTIME_METHODS="$EXPORT_METHODS" \
  -o "$OUTPUT_DIR/pinmame_web.js"

echo "=================================================="
echo "🟢 Module WebAssembly binarisé avec succès !"
ls -lh "$OUTPUT_DIR/pinmame_web.js" "$OUTPUT_DIR/pinmame_web.wasm"
echo "=================================================="