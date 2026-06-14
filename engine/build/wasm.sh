#!/bin/bash
set -e

# =========================================================================
# 🕸️ INFRASTRUCTURE PINMAME WASM - SCRIPT D'ASSEMBLAGE WEB FINAL
# 🏷️ VERSION : WEBLINK-V94.0 (BUILD SIZE REPORTING)
# =========================================================================

echo "=================================================="
echo "🕵️ MODE DIAGNOSTIC STRICT : MULTIPLEXEUR MAME V94.0"
echo "=================================================="

# 1. Vérification de l'environnement Emscripten
EMSDK_DIR="/home/julien/emsdk"
if [ -f "$EMSDK_DIR/emsdk_env.sh" ]; then
    source "$EMSDK_DIR/emsdk_env.sh" > /dev/null 2>&1
    export PATH="$EMSDK_DIR/upstream/emscripten:$PATH"
elif [ -f "/etc/profile.d/emscripten.sh" ]; then
    source /etc/profile.d/emscripten.sh
fi

if ! command -v emcc &> /dev/null; then
    echo "❌ [V94.0] ERREUR CRITIQUE : Compilateur 'emcc' introuvable."
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_ROOT="$(dirname "$ENGINE_DIR")"

if [ -d "$PROJECT_ROOT/pinmame_stripped/src" ]; then
    NATIVE_WORKSPACE="$PROJECT_ROOT/pinmame_stripped"
else
    NATIVE_WORKSPACE="$ENGINE_DIR/workspace/pinmame_stock"
fi
WASM_TEMP_OBJ_DIR="$ENGINE_DIR/out/wasm_objs"

# Vérification de l'archive statique
if [ ! -f "$ENGINE_DIR/out/libpinmame_wasm.a" ]; then
    echo "❌ [V94.0] ERREUR : libpinmame_wasm.a introuvable. Compile d'abord la lib statique."
    exit 1
fi

mkdir -p "$WASM_TEMP_OBJ_DIR"

API_FLAGS=(
    "-O2"
    "-I$NATIVE_WORKSPACE/src"
    "-I$NATIVE_WORKSPACE/src/wpclib"
    "-I$NATIVE_WORKSPACE/src/wpc"
    "-I$NATIVE_WORKSPACE/src/sound"
    "-I$NATIVE_WORKSPACE/src/sdl"
    "-I$NATIVE_WORKSPACE/src/unix"
    "-I$NATIVE_WORKSPACE/src/win32"
    "-DINLINE=static inline"
    "-Wno-implicit-function-declaration"
)

echo "[*] [V94.0] Compilation du pont API C++..."
emcc "${API_FLAGS[@]}" -c "$ENGINE_DIR/api.cpp" -o "$WASM_TEMP_OBJ_DIR/api.o"

# =========================================================================
# 🔗 ÉDITION DES LIENS ET GÉNÉRATION WEBASSEMBLY
# =========================================================================
LINK_FLAGS=(
    "-O2"
    "-s" "WASM=1"
    "-s" "MODULARIZE=1"
    "-s" "EXPORT_NAME='createPinMAME'"
    "-s" "ALLOW_MEMORY_GROWTH=1"
    "-s" "INITIAL_MEMORY=64MB"
    "-s" "MAXIMUM_MEMORY=2GB"
    "-s" "NO_EXIT_RUNTIME=1"
    "-s" "FORCE_FILESYSTEM=1"
    "-s" "ASYNCIFY"
    "-s" "ASSERTIONS=1"
    "-s" "USE_ZLIB=1"
    
    # 🎯 CORRECTION : On retire '_main' qui n'existe pas dans notre API
    "-s" "EXPORTED_RUNTIME_METHODS=['FS','HEAP8','HEAPU8','HEAP16','HEAP32','ccall','cwrap']"
    "-s" "EXPORTED_FUNCTIONS=['_pinmame_get_version','_pinmame_get_gprom_ptr','_pinmame_get_dsprom_ptr','_pinmame_get_display','_pinmame_web_entry','_pinmame_web_boot','_pinmame_web_tick','_api_pop_ascii_event','_api_hook_gottlieb_display_write','_api_get_dac_count','_api_get_dac_buffer','_api_reset_dac_buffer']"
)

echo "[*] [V94.0] Liaison des archives et injection des symboles modulaire..."
OUT_DIR="$ENGINE_DIR/out"
emcc "$WASM_TEMP_OBJ_DIR/api.o" "$ENGINE_DIR/out/libpinmame_wasm.a" "${LINK_FLAGS[@]}" \
    -Wl,--wrap=run_machine \
    -Wl,--wrap=DAC_DC_offset_correction_data_16_w \
    -o "$OUT_DIR/pinmame_web.js"

# 📊 RAPPORT DE BUILD : Afficher la taille des fichiers générés
if [ -f "$OUT_DIR/pinmame_web.js" ] && [ -f "$OUT_DIR/pinmame_web.wasm" ]; then
    JS_SIZE=$(ls -lh "$OUT_DIR/pinmame_web.js" | awk '{print $5}')
    WASM_SIZE=$(ls -lh "$OUT_DIR/pinmame_web.wasm" | awk '{print $5}')
    JS_SIZE_BYTES=$(ls -l "$OUT_DIR/pinmame_web.js" | awk '{print $5}')
    WASM_SIZE_BYTES=$(ls -l "$OUT_DIR/pinmame_web.wasm" | awk '{print $5}')
    TOTAL_BYTES=$((JS_SIZE_BYTES + WASM_SIZE_BYTES))

    echo ""
    echo "=================================================="
    echo "📊 RAPPORT DE BUILD V94.0"
    echo "=================================================="
    echo "✅ engine/out/pinmame_web.js   : $JS_SIZE ($JS_SIZE_BYTES bytes)"
    echo "✅ engine/out/pinmame_web.wasm : $WASM_SIZE ($WASM_SIZE_BYTES bytes)"
    echo "───────────────────────────────────────────────────"
    printf "📦 TOTAL WASM+JS   : "
    if [ $TOTAL_BYTES -lt 1048576 ]; then
        LC_ALL=C printf "%.2f KB\n" $(echo "scale=2; $TOTAL_BYTES / 1024" | bc)
    else
        LC_ALL=C printf "%.2f MB\n" $(echo "scale=2; $TOTAL_BYTES / 1048576" | bc)
    fi
    echo "=================================================="

    echo "[*] Assemblage du bundle universel → tilt"
    node "$SCRIPT_DIR/bundle.js"
    echo "=================================================="
else
    echo "⚠️  [V94.0] Certains fichiers n'ont pas été générés correctement."
    exit 1
fi