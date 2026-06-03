#!/bin/bash
set -e

# =========================================================================
# 🕸️ INFRASTRUCTURE PINMAME WASM - SCRIPT D'ASSEMBLAGE WEB FINAL
# 🏷️ VERSION : WEBLINK-V93.4 (BUILD SIZE REPORTING)
# =========================================================================

echo "=================================================="
echo "🕵️ MODE DIAGNOSTIC STRICT : MULTIPLEXEUR MAME V93.4"
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
    echo "❌ [V93.4] ERREUR CRITIQUE : Compilateur 'emcc' introuvable."
    exit 1
fi

BASE_DIR=$(pwd)
NATIVE_WORKSPACE="$BASE_DIR/pinmame_workspace/pinmame_stock"
WASM_TEMP_OBJ_DIR="$BASE_DIR/pinmame_workspace_wasm_objs"

# Vérification de l'archive statique
if [ ! -f "libpinmame_wasm.a" ]; then
    echo "❌ [V93.4] ERREUR : libpinmame_wasm.a introuvable. Compile d'abord la lib statique."
    exit 1
fi

mkdir -p "$WASM_TEMP_OBJ_DIR"

API_FLAGS=(
    "-O0"
    "-g"
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

echo "[*] [V93.4] Compilation du pont API C++..."
emcc "${API_FLAGS[@]}" -c api.cpp -o "$WASM_TEMP_OBJ_DIR/api.o"

# =========================================================================
# 🔗 ÉDITION DES LIENS ET GÉNÉRATION WEBASSEMBLY
# =========================================================================
LINK_FLAGS=(
    "-O0"
    "-g"
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
    "-s" "EXPORTED_RUNTIME_METHODS=['FS','HEAP8','HEAPU8','HEAP16','ccall','cwrap']"
    "-s" "EXPORTED_FUNCTIONS=['_pinmame_get_version','_pinmame_get_gprom_ptr','_pinmame_get_dsprom_ptr','_pinmame_get_display','_pinmame_web_entry','_pinmame_web_boot','_pinmame_web_tick','_api_pop_ascii_event','_api_hook_gottlieb_display_write']"
)

echo "[*] [V93.4] Liaison des archives et injection des symboles modulaire..."
emcc "$WASM_TEMP_OBJ_DIR/api.o" libpinmame_wasm.a "${LINK_FLAGS[@]}" \
    -Wl,--wrap=run_machine \
    -o pinmame_web.js

# 📊 RAPPORT DE BUILD : Afficher la taille des fichiers générés
if [ -f "pinmame_web.js" ] && [ -f "pinmame_web.wasm" ]; then
    JS_SIZE=$(ls -lh pinmame_web.js | awk '{print $5}')
    WASM_SIZE=$(ls -lh pinmame_web.wasm | awk '{print $5}')
    JS_SIZE_BYTES=$(ls -l pinmame_web.js | awk '{print $5}')
    WASM_SIZE_BYTES=$(ls -l pinmame_web.wasm | awk '{print $5}')
    TOTAL_BYTES=$((JS_SIZE_BYTES + WASM_SIZE_BYTES))
    
    echo ""
    echo "=================================================="
    echo "📊 RAPPORT DE BUILD V93.4"
    echo "=================================================="
    echo "✅ pinmame_web.js  : $JS_SIZE ($JS_SIZE_BYTES bytes)"
    echo "✅ pinmame_web.wasm : $WASM_SIZE ($WASM_SIZE_BYTES bytes)"
    echo "───────────────────────────────────────────────────"
    printf "📦 TOTAL           : "
    if [ $TOTAL_BYTES -lt 1048576 ]; then
        printf "%.2f KB\n" $(echo "scale=2; $TOTAL_BYTES / 1024" | bc)
    else
        printf "%.2f MB\n" $(echo "scale=2; $TOTAL_BYTES / 1048576" | bc)
    fi
    echo "=================================================="
else
    echo "⚠️  [V93.4] Certains fichiers n'ont pas été générés correctement."
    exit 1
fi