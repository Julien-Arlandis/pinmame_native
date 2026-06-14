#!/bin/zsh
# Flash la ROM sur la partition SPIFFS de l'ESP32-S3
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROMS_DIR="$SCRIPT_DIR/../node/roms"
SPIFFS_OFFSET="0x410000"
SPIFFS_SIZE="0x200000"
SPIFFSGEN="$HOME/esp/v5.4/esp-idf/components/spiffs/spiffsgen.py"
LAST_ROM_FILE="$SCRIPT_DIR/.last_rom"
TMP_DIR="$(mktemp -d)"
TMP_IMAGE="$TMP_DIR/spiffs.bin"

source ~/esp/v5.4/esp-idf/export.sh

PORT=$(ls /dev/cu.usbmodem* 2>/dev/null | head -1)
if [[ -z "$PORT" ]]; then
    echo "❌ Aucun ESP32 détecté sur /dev/cu.usbmodem*"
    exit 1
fi
echo "→ Port : $PORT"

ROMS=("$ROMS_DIR"/*.zip)
if [[ ${#ROMS[@]} -eq 0 ]]; then
    echo "❌ Aucune ROM trouvée dans $ROMS_DIR"
    exit 1
fi

ROM="${ROMS[1]}"
NAME=$(basename "$ROM" .zip)
[[ -f "$LAST_ROM_FILE" ]] && echo "→ ROM actuelle : $(cat $LAST_ROM_FILE)"
echo -n "→ Flash $NAME ? [Entrée pour confirmer / Ctrl+C pour annuler] "
read

mkdir -p "$TMP_DIR/roms"
cp "$ROM" "$TMP_DIR/roms/"

echo "[*] Génération image SPIFFS..."
python3 "$SPIFFSGEN" --page-size 256 --obj-name-len 32 \
    "$SPIFFS_SIZE" "$TMP_DIR" "$TMP_IMAGE"

echo "[*] Flash SPIFFS à l'offset $SPIFFS_OFFSET..."
lsof "$PORT" 2>/dev/null | awk 'NR>1 {print $2}' | xargs kill 2>/dev/null || true
sleep 0.5

python3 "$HOME/esp/v5.4/esp-idf/components/esptool_py/esptool/esptool.py" \
    --chip esp32s3 -p "$PORT" -b 460800 write_flash "$SPIFFS_OFFSET" "$TMP_IMAGE"

rm -rf "$TMP_DIR"
echo "$NAME" > "$LAST_ROM_FILE"
echo ""
echo "✅ $NAME flashée sur SPIFFS."
