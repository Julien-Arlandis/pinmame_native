#!/bin/zsh
# Flash le firmware PinMAME sur l'ESP32-S3
set -e

source ~/esp/v5.4/esp-idf/export.sh

cd "$(dirname "$0")/esp_project"
idf.py build

cd build

echo ""
echo "══════════════════════════════════════════════"
echo "  BOOT → RESET → relâche BOOT"
echo "  (le script détecte le port automatiquement)"
echo "══════════════════════════════════════════════"

for attempt in 1 2 3; do
    echo ""
    echo "👉 [Tentative $attempt/3] Fais BOOT+RESET puis attends..."

    # Attendre que le port apparaisse (30 secondes max)
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
        0x0 bootloader/bootloader.bin \
        0x8000 partition_table/partition-table.bin \
        0x10000 pinmame_esp32.bin && break

    echo "❌ Flash échoué, réessaie BOOT+RESET..."
done
