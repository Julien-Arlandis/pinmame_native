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


== Architecture flash (16MB) ==

La flash de l'ESP32 est découpée en zones (partitions), chacune avec un rôle précis.
Les adresses sont en hexadécimal.

  0x000000 – 0x009000  Bootloader (36KB)
                        Premier code exécuté au démarrage. Charge l'app.
                        Écrasé par flash.sh.

  0x009000 – 0x00F000  NVS — Non-Volatile Storage (24KB)
                        Stockage clé/valeur persistant (survit aux reboot).
                        Contient le nom de la ROM active (@rom:name=...).
                        Jamais écrasé automatiquement.

  0x00F000 – 0x010000  phy_init (4KB)
                        Données de calibration radio pour le BLE.
                        Écrasé par flash.sh.

  0x010000 – 0x410000  App — firmware PinMAME (4MB)
                        Le code compilé qui tourne sur l'ESP32.
                        Écrasé par flash.sh à chaque compilation.

  0x410000 – 0xFFFFFF  SPIFFS — filesystem (12MB)
                        Système de fichiers qui contient les ROMs ZIP.
                        Monté au démarrage sous /spiffs.
                        PinMAME cherche ses ROMs dans /spiffs/roms/.
                        Écrasé uniquement par flash_roms.sh.

  flash.sh      → écrase bootloader + phy_init + app  (SPIFFS intact)
  flash_roms.sh → écrase uniquement SPIFFS            (firmware intact)


== Changer de ROM à chaud ==

Depuis l'interface web ou via BLE, envoyer la commande :

    @rom:name=<nom>

L'ESP32 sauvegarde le nom en NVS et redémarre sur la nouvelle ROM.
