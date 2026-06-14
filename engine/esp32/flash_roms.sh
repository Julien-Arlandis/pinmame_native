#!/bin/zsh
# Flash les ROMs choisies sur la partition SPIFFS de l'ESP32-S3
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ROMS_DIR="$PROJECT_ROOT/roms"
SPIFFS_OFFSET="0x410000"
SPIFFS_SIZE="0xBF0000"
SPIFFSGEN="$HOME/esp/v5.4/esp-idf/components/spiffs/spiffsgen.py"
TMP_DIR="$(mktemp -d)"
TMP_IMAGE="$TMP_DIR/spiffs.bin"

source ~/esp/v5.4/esp-idf/export.sh

PORT=$(ls /dev/cu.usbmodem* 2>/dev/null | head -1)
if [[ -z "$PORT" ]]; then
    echo "❌ Aucun ESP32 détecté sur /dev/cu.usbmodem*"
    exit 1
fi
echo "→ Port : $PORT"

# Lister les ROMs disponibles (zsh : tableaux indexés à partir de 1)
ROMS=("$ROMS_DIR"/*.zip)
if [[ ${#ROMS[@]} -eq 0 ]]; then
    echo "❌ Aucune ROM trouvée dans $ROMS_DIR"
    exit 1
fi

echo ""
echo "ROMs disponibles :"
for i in {1..${#ROMS[@]}}; do
    name=$(basename "${ROMS[$i]}" .zip)
    size=$(du -h "${ROMS[$i]}" | awk '{print $1}')
    echo "  $i) $name  ($size)"
done
echo "  a) Toutes"
echo ""
echo -n "Choix (ex: 1 3 ou a) : "
read CHOICE

mkdir -p "$TMP_DIR/roms"

if [[ "$CHOICE" == "a" ]]; then
    cp "$ROMS_DIR"/*.zip "$TMP_DIR/roms/"
else
    for n in ${=CHOICE}; do
        if [[ $n -ge 1 && $n -le ${#ROMS[@]} ]]; then
            cp "${ROMS[$n]}" "$TMP_DIR/roms/"
            echo "→ Sélectionné : $(basename ${ROMS[$n]})"
        else
            echo "⚠️  Numéro invalide : $n"
        fi
    done
fi

echo ""
echo "[*] Génération image SPIFFS..."
python3 "$SPIFFSGEN" --page-size 256 --obj-name-len 64 \
    "$SPIFFS_SIZE" "$TMP_DIR" "$TMP_IMAGE"

echo "[*] Flash SPIFFS à l'offset $SPIFFS_OFFSET..."
lsof "$PORT" 2>/dev/null | awk 'NR>1 {print $2}' | xargs kill 2>/dev/null || true
sleep 0.5

python3 "$HOME/esp/v5.4/esp-idf/components/esptool_py/esptool/esptool.py" \
    --chip esp32s3 -p "$PORT" -b 460800 write_flash "$SPIFFS_OFFSET" "$TMP_IMAGE"

rm -rf "$TMP_DIR"
echo ""
echo "✅ ROMs flashées sur SPIFFS."
