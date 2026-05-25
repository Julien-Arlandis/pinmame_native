#!/bin/bash
set -e
SCRIPT_VERSION="18.8.0-RELEASE-LIB-ONLY"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_DIR="$SCRIPT_DIR"
TARGET_BASE_DIR="$BASE_DIR/pinmame_workspace"

echo "=================================================="
echo "▶️ ÉTAPE 1 : PACKAGING DE L'ARCHIVE GLOBALE"
echo "=================================================="

OBJ_DIR="$TARGET_BASE_DIR/pinmame_stock/xpinmame.obj"
if [ ! -d "$OBJ_DIR" ]; then
    echo "❌ Erreur : Dossier d'objets introuvable. Lance d'abord ./build_native_exec.sh"
    exit 1
fi

cd "$OBJ_DIR"
echo "[*] Empaquetage du cœur logique dans libpinmame_native.a..."
rm -f "$BASE_DIR/libpinmame_native.a"

# On prend TOUT sauf les outils tiers et aucun main.o pour éviter le conflit d'index
find . -name "*.o" ! -name "main.o" ! -name "snprintf.o" ! -name "xmameload.o" ! -name "alsa.o" ! -name "dirty.o" ! -name "zacproto.o" | xargs ar rcs "$BASE_DIR/libpinmame_native.a"

echo "[✅] Archive pure générée avec succès !"
ls -lh "$BASE_DIR/libpinmame_native.a"