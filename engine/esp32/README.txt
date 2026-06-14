== ESP32-S3 — PinMAME firmware ==

Cible : ESP32-S3 N16R8 (16MB flash, 8MB PSRAM octal)
Prérequis : ESP-IDF 5.4 installé dans ~/esp/v5.4/esp-idf/


== Compiler et flasher le firmware ==

    ./engine/esp32/flash.sh

Détecte automatiquement le port /dev/cu.usbmodem*, compile si nécessaire
puis flashe l'app. Ne touche pas la partition SPIFFS (ROMs conservées).


== Flasher les ROMs sur SPIFFS ==

    ./engine/esp32/flash_roms.sh

Présente la liste des ROMs disponibles dans roms/ et demande lesquelles
flasher. Génère une image SPIFFS et la flashe à l'offset 0x410000.
À faire au moins une fois, ou après ajout/suppression de ROMs.


== Monitor série (logs temps réel) ==

    ./engine/esp32/listen.sh

Quitter : Ctrl+]


== Compiler sans flasher ==

    cd engine && make esp32


== Architecture flash ==

  0x000000 – 0x010000  bootloader + table des partitions
  0x010000 – 0x410000  app (4MB) — firmware PinMAME
  0x410000 – 0xFFFFFF  SPIFFS (12MB) — ROMs ZIP


== Changer de ROM à chaud ==

Depuis l'interface web ou via BLE, envoyer la commande :

    @rom:name=<nom>

L'ESP32 sauvegarde le nom en NVS et redémarre sur la nouvelle ROM.
