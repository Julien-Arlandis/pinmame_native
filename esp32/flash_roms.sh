#!/bin/zsh
# Flash la ROM sur la partition SPIFFS de l'ESP32-S3 et met à jour l'NVS
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROMS_DIR="$SCRIPT_DIR/../node/roms"
SPIFFS_OFFSET="0x410000"
SPIFFS_SIZE="0x200000"
NVS_OFFSET="0x9000"
NVS_SIZE=24576   # 0x6000 en décimal
SPIFFSGEN="$HOME/esp/v5.4/esp-idf/components/spiffs/spiffsgen.py"
NVS_TOOL="$HOME/esp/v5.4/esp-idf/components/nvs_flash/nvs_partition_tool/nvs_tool.py"

TMP_DIR="$(mktemp -d)"
TMP_SPIFFS="/tmp/pinmame_spiffs_$$.bin"
NVS_DUMP="/tmp/pinmame_nvs_dump_$$.bin"
NVS_CSV="/tmp/pinmame_nvs_$$.csv"
NVS_IMAGE="/tmp/pinmame_nvs_new_$$.bin"

source ~/esp/v5.4/esp-idf/export.sh

ESPTOOL=(python3 "$HOME/esp/v5.4/esp-idf/components/esptool_py/esptool/esptool.py" --chip esp32s3 -b 460800)

PORT=$(ls /dev/cu.usbmodem* 2>/dev/null | head -1)
if [[ -z "$PORT" ]]; then
    echo "❌ Aucun ESP32 détecté sur /dev/cu.usbmodem*"
    exit 1
fi
echo "→ Port : $PORT"

# Tuer les processus qui bloquent le port
lsof "$PORT" 2>/dev/null | awk 'NR>1 {print $2}' | xargs kill 2>/dev/null || true
sleep 0.3

# Lire ROM actuelle depuis l'NVS de l'ESP32
echo "[*] Lecture NVS ESP32..."
$ESPTOOL -p "$PORT" read_flash "$NVS_OFFSET" "$NVS_SIZE" "$NVS_DUMP" 2>/dev/null || true
CURRENT_ROM=""
if [[ -f "$NVS_DUMP" ]]; then
    CURRENT_ROM=$(python3 "$NVS_TOOL" -d minimal --color never "$NVS_DUMP" 2>/dev/null | \
        grep 'pinmame:rom' | sed "s/.*= *b'\\(.*\\)'/\\1/" | sed "s/.*= *'\\(.*\\)'/\\1/" | sed 's/.*= *//' | tr -d '[:space:]' || true)
fi

echo ""
[[ -n "$CURRENT_ROM" ]] && echo "→ ROM actuelle dans l'ESP32 : $CURRENT_ROM" || echo "→ ROM actuelle : inconnue"

ROMS=("$ROMS_DIR"/*.zip)
if [[ ${#ROMS[@]} -eq 0 || ! -f "${ROMS[1]}" ]]; then
    echo "❌ Aucune ROM trouvée dans $ROMS_DIR"
    exit 1
fi

echo "ROMs disponibles :"
for i in {1..${#ROMS[@]}}; do
    name=$(basename "${ROMS[$i]}" .zip)
    size=$(du -h "${ROMS[$i]}" | awk '{print $1}')
    echo "  $i) $name  ($size)"
done
echo ""
echo -n "Choix : "
read CHOICE

if [[ $CHOICE -ge 1 && $CHOICE -le ${#ROMS[@]} ]]; then
    ROM="${ROMS[$CHOICE]}"
    NAME=$(basename "$ROM" .zip)
else
    echo "❌ Choix invalide"
    exit 1
fi

# Générer image SPIFFS (output hors du répertoire source pour ne pas l'inclure)
mkdir -p "$TMP_DIR/roms"
cp "$ROM" "$TMP_DIR/roms/"
echo "[*] Génération image SPIFFS ($NAME)..."
python3 "$SPIFFSGEN" --page-size 256 --obj-name-len 32 \
    "$SPIFFS_SIZE" "$TMP_DIR" "$TMP_SPIFFS"

# Flash SPIFFS
echo "[*] Flash SPIFFS à l'offset $SPIFFS_OFFSET..."
lsof "$PORT" 2>/dev/null | awk 'NR>1 {print $2}' | xargs kill 2>/dev/null || true
sleep 0.3
$ESPTOOL -p "$PORT" write_flash "$SPIFFS_OFFSET" "$TMP_SPIFFS"

# Générer et flasher NVS avec le nom de la ROM
echo "[*] Mise à jour NVS (rom=$NAME)..."
cat > "$NVS_CSV" << CSV
key,type,encoding,value
pinmame,namespace,,
rom,data,string,$NAME
CSV
python3 -m esp_idf_nvs_partition_gen generate "$NVS_CSV" "$NVS_IMAGE" "$NVS_SIZE"
lsof "$PORT" 2>/dev/null | awk 'NR>1 {print $2}' | xargs kill 2>/dev/null || true
sleep 0.3
$ESPTOOL -p "$PORT" write_flash "$NVS_OFFSET" "$NVS_IMAGE"

rm -rf "$TMP_DIR" "$TMP_SPIFFS" "$NVS_DUMP" "$NVS_CSV" "$NVS_IMAGE"

echo ""
echo "✅ $NAME flashée (SPIFFS + NVS)."
