== Build ==

    git clone https://github.com/Julien-Arlandis/pinmame_native.git
    cd pinmame_native && make all

Génère web/tilt_web (navigateur) et node/tilt_node (Node.js).


== Environnement web ==

    cd web && python3 -m http.server 8080

Ouvrir http://localhost:8080 dans le navigateur.
ROMs : web/roms/


== Environnement Node (BLE + WebSocket) ==

    node node/tilt_node [--rom=<nom>] [--port=<n>]

Lance l'émulateur sur le port WebSocket 8765.
ROMs : node/roms/


== Firmware ESP32 ==

Voir esp32/README.txt
