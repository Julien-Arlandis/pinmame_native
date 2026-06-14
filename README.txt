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

Compiler et flasher (ESP32-S3 branché en USB) :

    engine/esp32/flash.sh

Détecte automatiquement le port /dev/cu.usbmodem*, compile si nécessaire,
puis flashe. Requiert ESP-IDF 5.4 installé dans ~/esp/v5.4/esp-idf/.

Monitor série (logs temps réel, quitter : Ctrl+]) :

    engine/esp32/listen.sh

Compiler sans flasher :

    cd engine && make esp32
