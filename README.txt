== Architecture ==

    web/flip-g80       Bundle universel : WASM + runtime JS (navigateur Worker et Node.js)
    web/index.html     Interface web (PinMAME Workbench)
    node/main.js       Point d'entrée Node.js (BLE + WebSocket)
    api.cpp            Pont C++ entre PinMAME et le runtime JS/WASM
    workspace/         Sources PinMAME — NE PAS MODIFIER


== Build WASM ==

Prérequis : Emscripten installé dans ~/emsdk/

    # Compiler la lib statique PinMAME (à faire une seule fois ou après maj workspace/)
    bash node/wasm_lib.sh

    # Compiler api.cpp et assembler web/flip-g80
    bash node/wasm.sh

web/flip-g80 contient le WASM et le runtime embarqués en un seul fichier.


== Environnement web ==

    https://julien-arlandis.github.io/pinmame_native/

Ou en local :

    cd web && python3 -m http.server 8080

Ouvrir http://localhost:8080 dans le navigateur.
ROMs : web/roms/


== Environnement Node (BLE + WebSocket) ==

    node node/main.js [--rom=<nom>] [--port=<n>]

Lance l'émulateur sur le port WebSocket 8765.
ROMs : node/roms/


== Firmware ESP32 ==

Voir esp32/README.txt
