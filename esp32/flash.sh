#!/bin/zsh
# Flash le firmware PinMAME sur l'ESP32-S3
set -e

source ~/esp/v5.4/esp-idf/export.sh

# Détecte automatiquement le port USB (usbmodem*)
PORT=$(ls /dev/cu.usbmodem* 2>/dev/null | head -1)
if [[ -z "$PORT" ]]; then
    echo "❌ Aucun ESP32 détecté sur /dev/cu.usbmodem*"
    exit 1
fi
echo "→ Port : $PORT"

# Tue tout processus qui bloque le port
lsof "$PORT" 2>/dev/null | awk 'NR>1 {print $2}' | xargs kill 2>/dev/null || true
sleep 0.5

cd "$(dirname "$0")/esp_project"
idf.py -p "$PORT" build flash
