== Build ==

    git clone https://github.com/Julien-Arlandis/pinmame_native.git
    cd pinmame_native/engine && make all

Génère engine/web/tilt_web (navigateur) et engine/node/tilt_node (Node.js).


== Environnement web ==

    cd engine/web && python3 -m http.server 8080

Ouvrir http://localhost:8080 dans le navigateur.
ROMs : engine/web/roms/


== Environnement Node (BLE + WebSocket) ==

    node engine/node/tilt_node [--rom=<nom>] [--port=<n>]

Lance l'émulateur sur le port WebSocket 8765.
ROMs : engine/node/roms/


== Firmware ESP32 ==

Voir engine/esp32/README.txt
