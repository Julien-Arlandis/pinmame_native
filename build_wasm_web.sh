#!/bin/bash
set -e

# =========================================================================
# 🕸️ INFRASTRUCTURE PINMAME WASM - SCRIPT D'ASSEMBLAGE WEB FINAL
# 🏷️ VERSION : WEBLINK-V93.0 (ZLIB & 64MB RAM FIX)
# =========================================================================

echo "=================================================="
echo "🕵️ MODE DIAGNOSTIC STRICT : MULTIPLEXEUR MAME V93.0"
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
    echo "❌ [V93.0] ERREUR CRITIQUE : Compilateur 'emcc' introuvable."
    exit 1
fi

BASE_DIR=$(pwd)
NATIVE_WORKSPACE="$BASE_DIR/pinmame_workspace/pinmame_stock"
WASM_TEMP_OBJ_DIR="$BASE_DIR/pinmame_workspace_wasm_objs"

# Vérification de l'archive statique
if [ ! -f "libpinmame_wasm.a" ]; then
    echo "❌ [V93.0] ERREUR : libpinmame_wasm.a est introuvable."
    exit 1
fi

echo "[*] [V93.0] Génération du binaire avec cartographie complète des symboles (-g)..."

# =========================================================================
# ⚙️ COMPILATION DU PONT C++ (API.CPP)
# =========================================================================
API_FLAGS=(
    "-O0"
    "-g"
    "-include" "$WASM_TEMP_OBJ_DIR/emscripten_macros.h"
    "-I$WASM_TEMP_OBJ_DIR/include"
    "-I$NATIVE_WORKSPACE/src"
    "-I$NATIVE_WORKSPACE/src/wpc"
    "-I$NATIVE_WORKSPACE/src/unix"
    "-I$NATIVE_WORKSPACE/src/cores"
    "-I$NATIVE_WORKSPACE/src/cpu"
    "-I$NATIVE_WORKSPACE/src/sound"
    "-DINLINE=static inline"
    "-Wno-implicit-function-declaration"
)

# On compile le pont 
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
    
    # 🌟 CORRECTION 1 : ON DONNE 64 Mo DE RAM AU DÉMARRAGE 🌟
    "-s" "ALLOW_MEMORY_GROWTH=1"
    "-s" "INITIAL_MEMORY=64MB"
    "-s" "MAXIMUM_MEMORY=2GB"
    
    "-s" "NO_EXIT_RUNTIME=1"
    "-s" "FORCE_FILESYSTEM=1"
    "-s" "ASYNCIFY"
    "-s" "ASSERTIONS=1"
    
    # 🌟 CORRECTION 2 : ON ACTIVE LA LIBRAIRIE ZIP INTERNE D'EMSCRIPTEN 🌟
    "-s" "USE_ZLIB=1"
    
    "-s" "EXPORTED_RUNTIME_METHODS=['FS', 'HEAP8', 'HEAPU8', 'HEAP16']"
    "-s" "EXPORTED_FUNCTIONS=['_pinmame_get_version', '_pinmame_get_gprom_ptr', '_pinmame_get_dsprom_ptr', '_pinmame_get_display', '_pinmame_web_entry', '_pinmame_web_boot', '_pinmame_web_tick', '_malloc', '_free']"
)

# Fusion de l'API et du Cœur
emcc "$WASM_TEMP_OBJ_DIR/api.o" "libpinmame_wasm.a" -o pinmame_web.js "${LINK_FLAGS[@]}"

# Nettoyage
rm -f "$WASM_TEMP_OBJ_DIR/api.o"

echo "=================================================="
echo "🟢 [V93.0] ARCHITECTURE WEB ASSEMBLÉE AVEC SUCCÈS !"
echo "=================================================="