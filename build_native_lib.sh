#!/bin/bash

# Arrête le script immédiatement si une commande échoue
set -e

SCRIPT_VERSION="18.2.0-RELEASE-DL-HOOK"

# Détermination dynamique du répertoire du script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

BASE_DIR="$SCRIPT_DIR"
TARGET_BASE_DIR="$BASE_DIR/pinmame_workspace"
OUTPUT_DIR="$BASE_DIR/test_native_lib"
ROM_SOURCE="$BASE_DIR/roms/bonebstr.zip"
CPP_SOURCE="$BASE_DIR/test_pure_lib.cpp"

echo "=================================================="
echo "▶️ COMPILATEUR GLOBAL - CONFIGURATION HOOK DYNAMIQUE"
echo "🆔 Version du Script : $SCRIPT_VERSION"
echo "=================================================="
echo ""

# ==================================================
# 🏗️ ÉTAPE 1 : Exécution conditionnelle du build brut
# ==================================================
if [ -d "$TARGET_BASE_DIR" ]; then
    echo "💡 INFO : Le workspace '$TARGET_BASE_DIR' existe déjà."
    echo "⏭️  Saut du build brut (Gain de temps)."
    echo ""
else
    echo "=== [1/3] Le workspace est absent. Lancement de build_native_exec.sh ==="
    cd "$BASE_DIR"
    if [ ! -f "./build_native_exec.sh" ]; then
        echo "❌ Erreur : './build_native_exec.sh' est introuvable."
        exit 1
    fi
    ./build_native_exec.sh
    echo ""
fi

# ==================================================
# 📦 ÉTAPE 2 : Nettoyage et Préparation de l'environnement
# ==================================================
echo "=== [2/3] Archivage et Nettoyage de l'environnement ==="
OBJ_DIR="$TARGET_BASE_DIR/pinmame_stock/xpinmame.obj"

if [ ! -d "$OBJ_DIR" ]; then
    echo "❌ Erreur critique : Le dossier '$OBJ_DIR' n'existe pas."
    exit 1
fi

# 1. On génère d'abord l'archive dans le dossier objet
cd "$OBJ_DIR"
echo "[*] Archivage de la TOTALITÉ absolue des fichiers objets..."
ar rcs "$BASE_DIR/libpinmame_native.tmp.a" $(find . -name "*.o" ! -name "*main.o")

# 2. GRAND NETTOYAGE CHIRURGICAL de OUTPUT_DIR
echo "[*] Nettoyage complet des anciens résidus graphiques et décompressions..."
if [ -d "$OUTPUT_DIR" ]; then
    # On supprime TOUT sauf le script lui-même s'il est dedans, pour repartir sur une base 100% saine
    find "$OUTPUT_DIR" -mindepth 1 -delete 2>/dev/null || true
else
    mkdir -p "$OUTPUT_DIR"
fi

# On déplace l'archive propre à sa place
mv "$BASE_DIR/libpinmame_native.tmp.a" "$OUTPUT_DIR/libpinmame_native.a"
echo "[✅] Archive libpinmame_native.a générée avec succès."

# 3. Déploiement unique de la ROM au format attendu par PinMAME (.zip)
mkdir -p "$OUTPUT_DIR/roms"
if [ -f "$ROM_SOURCE" ]; then
    cp "$ROM_SOURCE" "$OUTPUT_DIR/roms/bonebstr.zip"
    echo "[✅] Fichier bonebstr.zip cloné proprement dans roms/"
else
    echo "❌ ERREUR CRITIQUE : $ROM_SOURCE introuvable."
    exit 1
fi
echo ""

# ==================================================
# 🛠️ ÉTAPE 3 : Liaison Finale et Surcharge Dynamique
# ==================================================
echo "=== [3/3] Compilation de l'exécutable de test ==="

cd "$BASE_DIR"
if [ ! -f "$CPP_SOURCE" ]; then
    echo "❌ Erreur : Le fichier source '$CPP_SOURCE' est introuvable."
    exit 1
fi

cp "$CPP_SOURCE" "$OUTPUT_DIR/test_pure_lib.cpp"
cd "$OUTPUT_DIR"

echo "[*] Liaison finale via g++..."
g++ -O0 -g test_pure_lib.cpp ./libpinmame_native.a -lasound -lX11 -lXext -lXv -lz -ldl -Wl,--allow-multiple-definition -o test_pure_lib
echo "=================================================="
echo "🎉 ALIGNEMENT ET COMPILATION INDUSTRIALISÉS !"
echo "👉 Lance l'émulation :"
echo "   cd $OUTPUT_DIR"
echo "   ./test_pure_lib"
echo "=================================================="