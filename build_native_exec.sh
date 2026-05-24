#!/bin/bash

# Arrête le script immédiatement si une commande échoue
set -e


# 🚀 Version corrigée pour s'exécuter de zéro en dossier vide sans bug de dossier
SCRIPT_VERSION="27.0.1-STEP1-FIXED"
REPO_URL="https://github.com/vpinball/pinmame.git"

BASE_DIR=$(pwd)
TARGET_BASE_DIR="$BASE_DIR/pinmame_workspace"
ROM_SOURCE="$BASE_DIR/roms/bonebstr.zip"

echo "=================================================="
echo "▶️ ÉTAPE 1 : COMPILATION NATIVE (CORRECTION -J)"
echo "🆔 Version du Script : $SCRIPT_VERSION"
echo "=================================================="
echo ""

# ==================================================
# 🛠️ ÉTAPE 1.1 : Dépendances Système (X11 + ALSA + Zlib)
# ==================================================
echo "=== [1/4] Vérification et installation des dépendances ==="
if command -v apt-get &> /dev/null; then
    if [ "$(id -u)" -eq 0 ]; then
        apt-get update && apt-get install -y zlib1g-dev build-essential libasound2-dev libx11-dev libxext-dev
    else
        sudo apt-get update && sudo apt-get install -y zlib1g-dev build-essential libasound2-dev libx11-dev libxext-dev
    fi
fi
echo ""

# ==================================================
# 📂 ÉTAPE 1.2 : Nettoyage radical et Clonage à neuf
# ==================================================
echo "=== [2/4] Nettoyage et initialisation du dépôt d'origine ==="
rm -rf "$TARGET_BASE_DIR"
mkdir -p "$TARGET_BASE_DIR"
cd "$TARGET_BASE_DIR"

echo "[*] Clonage propre depuis GitHub..."
git clone --recursive $REPO_URL pinmame_stock
PINMAME_DIR="$TARGET_BASE_DIR/pinmame_stock"
echo ""

# ==================================================
# 🗂️ ÉTAPE 1.2.5 : SÉCURISATION CRITIQUE DES RÉPERTOIRES (Le Fix)
# ==================================================
echo "=== [3/4] Pré-génération de l'arborescence des objets ==="
cd "$PINMAME_DIR"
mkdir -p xpinmame.obj

# Cette commande analyse le dossier source et crée TOUTES les ramifications
# de dossiers possibles dans xpinmame.obj avant que la compilation ne démarre.
find src -type d -exec mkdir -p "xpinmame.obj/{}" \;
find src -type d -exec mkdir -p "xpinmame.obj/$(echo {} | sed 's/^src\///')" \; 2>/dev/null || true
echo "[✅] Structure de répertoires sécurisée pour la compilation en parallèle."
echo ""

# ==================================================
# 🏗️ ÉTAPE 1.3 : Compilation via Makefile Unix Officiel + FLAGS DEBUG INJECTÉS
# ==================================================
echo "=== [4/4] Compilation avec Makefile.unix en mode DEBUG ==="

if [ ! -f "makefile.unix" ]; then
    echo "❌ Erreur critique : Le fichier 'makefile.unix' est introuvable."
    exit 1
fi

echo "[🎯] Injection furtive des flags de Debug via la variable ARCH..."
# On nettoie l'environnement pour être sûr de ne pas polluer les sous-makefiles
unset CFLAGS
unset CXXFLAGS
unset CC
unset CXX

echo "[*] Lancement du Make industriel avec injection non-destructive..."
# En passant nos drapeaux dans ARCH, ils s'ajoutent à la fin de TOUTES les lignes 
# de compilation sans casser les mécanismes internes de détection du Makefile.
make -f makefile.unix ARCH="-g -O0 -fno-inline -fno-omit-frame-pointer" -j$(nproc)





# Préparation du dossier d'extraction propre sur le Bureau
OUTPUT_DIR="$BASE_DIR/test_native_exec"
mkdir -p "$OUTPUT_DIR"

echo ""
echo "[*] Recherche de l'exécutable généré..."
if [ -f "xpinmame.x11" ]; then
    cp xpinmame.x11 "$OUTPUT_DIR/"
    echo "[✅] Exécutable copié avec succès !"
elif [ -f "xpinmame" ]; then
    cp xpinmame "$OUTPUT_DIR/xpinmame.x11"
    echo "[✅] Exécutable copié et renommé en xpinmame.x11 avec succès !"
else
    XPIN_PATH=$(find . -maxdepth 3 -type f -executable \( -name "xpinmame*" -o -name "pinmame*" \) | head -n 1)
    if [ -n "$XPIN_PATH" ]; then
        cp "$XPIN_PATH" "$OUTPUT_DIR/xpinmame.x11"
        echo "[✅] Exécutable trouvé dans les sous-dossiers et copié !"
    else
        echo "❌ Erreur : La compilation semble s'être terminée mais le binaire est introuvable."
        exit 1
    fi
fi


echo "=== Copie de sécurité de la ROM ==="
mkdir -p "$OUTPUT_DIR/roms"
if [ -f "$ROM_SOURCE" ]; then
    cp "$ROM_SOURCE" "$OUTPUT_DIR/roms/"
    echo "[✅] Fichier bonebstr.zip copié dans $OUTPUT_DIR/roms/"
else
    echo "⚠️ Attention : Impossible de trouver la ROM dans $ROM_SOURCE"
fi
echo ""

echo ""
echo "=================================================="
echo "🎉 ÉTAPE 1 RÉUSSIE : ÉMULATEUR COMPILÉ SANS ERREUR COUPLAGE !"
echo "👉 Retrouve ton binaire ici : $OUTPUT_DIR/xpinmame.x11"
echo "=================================================="