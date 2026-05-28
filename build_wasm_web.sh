#!/bin/bash
set -e

# =========================================================================
# 🔗 INFRASTRUCTURE PINMAME WASM - SCRIPT DE LIAISON DIAGNOSTIC CRITIQUE
# 🏷️ VERSION : WASM-WEB-BINDING-V91.0
# =========================================================================

echo "=================================================="
echo "🕵️ MODE DIAGNOSTIC STRICT : MULTIPLEXEUR MAME V91.0"
echo "=================================================="

EMSDK_DIR="/home/julien/emsdk"
if [ -f "$EMSDK_DIR/emsdk_env.sh" ]; then
    source "$EMSDK_DIR/emsdk_env.sh" > /dev/null 2>&1
    export PATH="$EMSDK_DIR/upstream/emscripten:$PATH"
fi

SRC_DIR=$(pwd)
LIB_WASM_A="$SRC_DIR/libpinmame_wasm.a"
NATIVE_WORKSPACE="$SRC_DIR/pinmame_workspace/pinmame_stock"
OUTPUT_DIR="$SRC_DIR"

rm -f "$OUTPUT_DIR/pinmame_web.js" "$OUTPUT_DIR/pinmame_web.wasm"

INCLUDES="-I$SRC_DIR/pinmame_workspace_wasm_objs/include -I$NATIVE_WORKSPACE/src -I$NATIVE_WORKSPACE/src/wpc -I$NATIVE_WORKSPACE/src/unix -I$NATIVE_WORKSPACE/src/cores -I$NATIVE_WORKSPACE/src/cpu -I$NATIVE_WORKSPACE/src/sound"
EXPORT_FUNCS='["_pinmame_get_version","_pinmame_get_gprom_ptr","_pinmame_get_dsprom_ptr","_pinmame_get_display","_pinmame_web_entry","_pinmame_web_boot","_pinmame_web_tick"]'
EXPORT_METHODS='["FS", "cwrap", "ccall", "HEAPU8"]'

echo "[*] [V91.0] Génération du binaire avec cartographie complète des symboles (-g)..."

emcc "$SRC_DIR/api.cpp" "$LIB_WASM_A" $INCLUDES \
  -DINLINE="static inline" \
  -O0 \
  -g \
  -s WASM=1 \
  -s USE_ZLIB=1 \
  -s ASYNCIFY=1 \
  -s ASYNCIFY_STACK_SIZE=131072 \
  -s MODULARIZE=1 \
  -s EXPORT_NAME="createPinMAME" \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s EXPORTED_FUNCTIONS="$EXPORT_FUNCS" \
  -s EXPORTED_RUNTIME_METHODS="$EXPORT_METHODS" \
  -s ERROR_ON_UNDEFINED_SYMBOLS=1 \
  -s ASSERTIONS=2 \
  -o "$OUTPUT_DIR/pinmame_web.js"

echo "=================================================="
echo "🟢 [V91.0] Binaire de diagnostic généré !"
echo "=================================================="