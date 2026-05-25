#!/bin/bash
set -e
SCRIPT_VERSION="1.3.5-LINK-EXTRACT-AND-ECHO"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_DIR="$SCRIPT_DIR"
TARGET_BASE_DIR="$BASE_DIR/pinmame_workspace"
LIB_NATIVE_A="$BASE_DIR/libpinmame_native.a"
ROM_SOURCE="$BASE_DIR/roms/bonebstr.zip"
OUTPUT_DIR="$BASE_DIR/test_pure_lib_exec"

echo "=================================================="
echo "▶️ ÉTAPE 2 : CONFIGURATION, LIAISON G++ ET ÉCHO"
echo "=================================================="

if [ ! -f "$LIB_NATIVE_A" ]; then
    echo "❌ Erreur : libpinmame_native.a introuvable. Lance ./build_native_lib.sh d'abord."
    exit 1
fi

# Nettoyage et initialisation du dossier de sortie
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR/roms"

echo "[*] Extraction chirurgicale du module d'amorçage OSD depuis le workspace..."
OBJ_DIR="$TARGET_BASE_DIR/pinmame_stock/xpinmame.obj"
VRAI_MAIN=$(find "$OBJ_DIR" -path "*/unix.x11/main.o" -o -path "*/unix/main.o" | head -n 1)

if [ -n "$VRAI_MAIN" ] && [ -f "$VRAI_MAIN" ]; then
    cp "$VRAI_MAIN" "$OUTPUT_DIR/vrai_mame_main.o"
    echo "[✅] Module d'amorçage d'origine sécurisé."
else
    echo "❌ Erreur critique : Impossible de localiser le main.o d'affichage d'origine."
    exit 1
fi

# Génération dynamique des stubs de drivers manquants
cat << 'EOF' > "$OUTPUT_DIR/stubs.c"
struct GameDriver {
    const char *source_file;
    const struct GameDriver *clone_of;
    const char *name;
    const char *description;
    const char *year;
    const char *manufacturer;
};
struct GameDriver driver_strike = { "strike.c", 0, "strike", "Strike", "1000", "Bally" };
struct GameDriver driver_skijump = { "skijump.c", 0, "skijump", "Ski Jump", "1000", "Bally" };
struct GameDriver driver_spacecty = { "spacecty.c", 0, "spacecty", "Space City", "1000", "Zaccaria" };
EOF

# Déploiement de la ROM et de la Lib
cp "$ROM_SOURCE" "$OUTPUT_DIR/roms/bonebstr.zip"
cp "$LIB_NATIVE_A" "$OUTPUT_DIR/libpinmame_native.a"

cd "$OUTPUT_DIR"
echo "[*] Fusion binaire finale (g++)..."

# Liaison globale
g++ -O0 -g vrai_mame_main.o stubs.c ./libpinmame_native.a \
    -lasound \
    -lX11 \
    -lXext \
    -lXv \
    -lz \
    -ldl \
    -lpthread \
    -o test_pure_lib

# Nettoyage local des fichiers intermédiaires
rm -f ./libpinmame_native.a ./vrai_mame_main.o ./stubs.c
echo "[✅] Exécutable 'test_pure_lib' correctement assemblé !"

echo "--------------------------------------------------"
echo "📋 TOUT EST PRÊT ! POUR LANCER L'ÉMULATION :"
echo "--------------------------------------------------"
echo "export DISPLAY=:3 GDK_BACKEND=x11 QT_QPA_PLATFORM=xcb"
echo "$OUTPUT_DIR/test_pure_lib -rompath ./roms bonebstr"
echo "--------------------------------------------------"