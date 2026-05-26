#!/bin/bash
set -e

SCRIPT_VERSION="WASM-WEB-LINKER-v3.3-STABLE"

# 🌟 DÉTECTION DYNAMIQUE ET PORTABLE DU RÉPERTOIRE RACINE
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

# Pointage sur l'unique source de vérité pour les headers (.h)
PINMAME_STOCK="$SRC_DIR/pinmame_workspace/pinmame_stock"
OUTPUT_DIR="$SRC_DIR"
LIB_WASM_A="$SRC_DIR/libpinmame_wasm.a"

echo "=================================================="
echo "🔗 LIAISON GLOBALE ULTRA-PROPRE : VERSION $SCRIPT_VERSION"
echo "=================================================="

# 1. CHARGEMENT ET EXPORTATION STRICTE DE L'ENVIRONNEMENT EMSCRIPTEN
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

# Sécurité : On s'assure que la bibliothèque WASM existe bien
if [ ! -f "$LIB_WASM_A" ]; then
    echo "💥 Erreur : L'archive globale $LIB_WASM_A est introuvable !"
    echo "▶️ Veuillez exécuter ./build_wasm_lib.sh au préalable."
    exit 1
fi

# Blindage : Création propre du dossier de sortie
mkdir -p "$OUTPUT_DIR"
rm -f "$OUTPUT_DIR/pinmame_web.js" "$OUTPUT_DIR/pinmame_web.wasm"

echo "[*] Liaison chirurgicale de api.cpp avec l'archive de muscles unifiée WASM..."

# 🌟 MAGIE DE L'ALIGNEMENT : emcc prend api.cpp et aspire le nécessaire dans libpinmame_wasm.a
emcc "$SRC_DIR/api.cpp" "$LIB_WASM_A" \
    -O2 \
    -g \
    -I"$SRC_DIR" \
    -I"$PINMAME_STOCK/src" \
    -I"$PINMAME_STOCK/src/wpc" \
    -I"$PINMAME_STOCK/src/unix" \
    -I"$PINMAME_STOCK/src/cores" \
    -I"$PINMAME_STOCK/src/cpu" \
    -DINLINE="static inline" \
    -DUNIX \
    -D__inline__=inline \
    -DBMTYPE=UINT16 \
    -sWASM=1 \
    -sASYNCIFY=1 \
    -sMODULARIZE=1 \
    -sEXPORT_NAME="createPinMAME" \
    -sFORCE_FILESYSTEM=1 \
    -sUSE_ZLIB=1 \
    -sWARN_ON_UNDEFINED_SYMBOLS=0 \
    -sERROR_ON_UNDEFINED_SYMBOLS=0 \
    -sEMULATE_FUNCTION_POINTER_CASTS=1 \
    -Wl,--allow-undefined \
    -Wl,--unresolved-symbols=ignore-all \
    -Wl,--allow-multiple-definition \
    -sEXPORTED_FUNCTIONS='["_pinmame_get_version", "_pinmame_get_gprom_ptr", "_pinmame_get_dsprom_ptr", "_pinmame_get_display", "_pinmame_web_entry", "_pinmame_web_tick"]' \
    -sEXPORTED_RUNTIME_METHODS='["FS", "cwrap", "ccall", "HEAPU8"]' \
    -o "$OUTPUT_DIR/pinmame_web.js"

if [ $? -eq 0 ]; then
    echo "=================================================="
    echo "🎉 FUSION TERMINÉE : LE PACK BUNDLE JS/WASM EST PRÊT !"
    ls -lh "$OUTPUT_DIR"/pinmame_web.*
    echo "node launcher.js"
    echo "=================================================="
else
    echo "💥 Échec de la compilation."
    exit 1
fi