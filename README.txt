Installation et compilation :

    git clone https://github.com/Julien-Arlandis/pinmame_native.git
    cd pinmame_native/engine && make all

make all clone automatiquement la source PinMAME, installe les dépendances
Node, compile le WASM et génère l'exécutable tilt à la racine du projet.

Pour le build natif Mac/Linux :

    make native

------------------

Lancer l'émulateur Node (BLE + WebSocket) :

    ./tilt bonebstr

Depuis le navigateur (interface web workbench) :
    https://julien-arlandis.github.io/pinmame_native/
