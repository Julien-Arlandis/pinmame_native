#!/bin/zsh
# Ouvre le monitor série de l'ESP32-S3
# Quitter : Ctrl+]

source ~/esp/v5.4/esp-idf/export.sh

PORT=$(ls /dev/cu.usbmodem* 2>/dev/null | head -1)
if [[ -z "$PORT" ]]; then
    echo "❌ Aucun ESP32 détecté sur /dev/cu.usbmodem*"
    exit 1
fi
echo "→ Monitor sur $PORT  (quitter : Ctrl+])"

cd "$(dirname "$0")/esp_project"
idf.py -p "$PORT" monitor
