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

TMP_DIR="$(mktemp -d)"
TMP_SPIFFS="/tmp/pinmame_spiffs_$$.bin"
NVS_CSV="/tmp/pinmame_nvs_$$.csv"
NVS_IMAGE="/tmp/pinmame_nvs_new_$$.bin"

source ~/esp/v5.4/esp-idf/export.sh

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

# Générer l'image SPIFFS
mkdir -p "$TMP_DIR/roms"
cp "$ROM" "$TMP_DIR/roms/"
echo "[*] Génération image SPIFFS ($NAME)..."
python3 "$SPIFFSGEN" --page-size 256 --obj-name-len 32 \
    "$SPIFFS_SIZE" "$TMP_DIR" "$TMP_SPIFFS"

# Générer l'image NVS
echo "[*] Génération image NVS (rom=$NAME)..."
cat > "$NVS_CSV" << CSV
key,type,encoding,value
pinmame,namespace,,
rom,data,string,$NAME
CSV
python3 -m esp_idf_nvs_partition_gen generate "$NVS_CSV" "$NVS_IMAGE" "$NVS_SIZE"

echo ""
echo "══════════════════════════════════════════════"
echo "  BOOT → RESET → relâche BOOT"
echo "  (le script détecte le port automatiquement)"
echo "══════════════════════════════════════════════"

for attempt in 1 2 3; do
    echo ""
    echo "👉 [Tentative $attempt/3] Fais BOOT+RESET puis attends..."

    PORT=""
    for i in $(seq 1 60); do
        PORT=$(ls /dev/cu.usbmodem* 2>/dev/null | head -1)
        [[ -n "$PORT" ]] && break
        sleep 0.5
    done

    if [[ -z "$PORT" ]]; then
        echo "❌ Port non détecté — refais BOOT+RESET"
        continue
    fi

    echo "→ Port détecté : $PORT"
    lsof "$PORT" 2>/dev/null | awk 'NR>1 {print $2}' | xargs kill 2>/dev/null || true
    sleep 0.5

    /opt/homebrew/bin/python3.12 -m esptool --chip esp32s3 -p "$PORT" -b 460800 \
        --before no_reset --after hard_reset \
        write_flash --flash_mode dio --flash_freq 80m --flash_size 16MB \
        "$SPIFFS_OFFSET" "$TMP_SPIFFS" \
        "$NVS_OFFSET" "$NVS_IMAGE" && break

    echo "❌ Flash échoué, réessaie BOOT+RESET..."
done

rm -rf "$TMP_DIR" "$TMP_SPIFFS" "$NVS_CSV" "$NVS_IMAGE"

echo ""
echo "✅ $NAME flashée (SPIFFS + NVS)."
