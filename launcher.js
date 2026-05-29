/**
 * 🚀 PINMAME WASM - HEADLESS DYNAMIC ARGV LAUNCHER (ZERO-MALLOC ONSITE)
 * 🏷️ VERSION : LAUNCHER-NODE-ARGV-V171.1
 */

const fs = require('fs');
const path = require('path');

process.on('uncaughtException', (err) => {
    console.error(`💥 [CRASH NODE] Erreur : ${err.message}`);
    process.exit(1);
});

// Capture le nom de la rom passé en argument (ex: node launcher.js badgirls)
const romTarget = process.argv[2] || 'bonebstr';
const createPinMAME = require('./pinmame_web.js');

async function bootstrapHeadless() {
    console.log("⚡ Initialisation du moteur PinMAME headless sous Node.js...");
    console.log(`🎯 Traitement de la cible : [ ${romTarget} ]`);

    try {
        const instance = await createPinMAME({
            print: function(text) { console.log(`[CORE] ${text}`); },
            printErr: function(err) { console.error(`[C++ ERR] ${err}`); },
            locateFile: function(fileName) { return path.join(__dirname, fileName); }
        });

        instance.FS.mkdir('/roms');

        const localRomPath = path.join(__dirname, 'roms', `${romTarget}.zip`);
        if (!fs.existsSync(localRomPath)) {
            console.error(`\n🔴 ERREUR : Le fichier ROM est introuvable : ${localRomPath}`);
            process.exit(1);
        }

        const romBuffer = fs.readFileSync(localRomPath);
        
        // Écriture du zip sous sa véritable identité
        instance.FS.writeFile(`/roms/${romTarget}.zip`, new Uint8Array(romBuffer));
        console.log(`🟢 Fichier "/roms/${romTarget}.zip" provisionné.`);

        // 🌟 EXTRACTION DU POINTEUR DE RAM PARTAGÉE EXISTANT
        const memPtr = instance._pinmame_get_dsprom_ptr();
        console.log(`📌 Mémoire partagée mappée à l'adresse : 0x${memPtr.toString(16)}`);

        // 🌟 ZONE TAMPON SANS MALLOC : On écrit la chaîne à l'offset 1000 de notre mémoire commune
        const strOffset = 1000;
        const stringAddress = memPtr + strOffset;
        const romNameBuffer = Buffer.from(romTarget + '\0', 'ascii');
        
        // Injection directe des octets de la chaîne dans le HEAP JavaScript
        instance.HEAPU8.set(romNameBuffer, stringAddress);

        // Appel de la recherche textuelle dynamique en lui donnant l'adresse de notre zone tampon
        const matchFound = instance._pinmame_set_driver_by_name(stringAddress);

        if (!matchFound) {
            console.error("🔴 Annulation du boot : Identité ROM rejetée par le dictionnaire.");
            process.exit(1);
        }

        // Shunt sécurité Slam Tilt automatique
        instance.HEAPU8[memPtr + 100 + 1] = 1; 

        console.log(`🎮 Lancement de l'émulation...`);
        instance._pinmame_web_boot();

        let cycles = 0;
        setInterval(() => {
            cycles++;
            const b0 = instance.HEAPU8[memPtr + 320];
            const b1 = instance.HEAPU8[memPtr + 321];
            const b2 = instance.HEAPU8[memPtr + 322];
            const b3 = instance.HEAPU8[memPtr + 323];
            const solWord = (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
            
            if (solWord > 0 && cycles % 10 === 0) {
                console.log(`[MONITOR] Solénoïdes actifs détectés : 0x${solWord.toString(16)}`);
            }
        }, 16);

    } catch (error) {
        console.error(`🔴 Erreur fatale : ${error.message}`);
    }
}

bootstrapHeadless();