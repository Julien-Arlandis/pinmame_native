== Build ==

    git clone https://github.com/Julien-Arlandis/pinmame_native.git
    cd pinmame_native/engine && make all

make all clone la source PinMAME, installe les dépendances Node,
compile le WASM et génère le fichier tilt à la racine du projet.


== Émulateur Node (BLE + WebSocket) ==

    node engine/node/main.js <rom>

Exemple :
    node engine/node/main.js bonebstr

Lance l'émulateur sur le port WebSocket 8765.
Se connecte via BLE ou WebSocket depuis l'interface web.


== Interface web ==

    https://julien-arlandis.github.io/pinmame_native/


== Firmware ESP32 ==

Voir engine/esp32/README.txt
