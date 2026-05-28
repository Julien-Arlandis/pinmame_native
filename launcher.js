// =========================================================================
// 🚀 INFRASTRUCTURE PINMAME WASM - RUNTIME ENGINE LANCIER NODE.JS
// 🏷️ VERSION : LAUNCHER-NODE-HEADLESS-V57.0
// =========================================================================

const fs = require('fs');
const path = require('path');
const createPinMAME = require('./pinmame_web.js');

const VERSION_HOTE = "V57.0";

function readStringFromWasm(instance, pointer) {
    if (!pointer) return "";
    let result = "";
    let offset = pointer;
    while (instance.HEAPU8[offset] !== 0) {
        result += String.fromCharCode(instance.HEAPU8[offset]);
        offset++;
    }
    return result;
}

const outputModule = {
    print: function(text) {
        console.log(`[🎰 PINMAME-CORE V${VERSION_HOTE}] ${text}`);
    },
    printErr: function(text) {
        console.error(`[🚨 PINMAME-WARN V${VERSION_HOTE}] ${text}`);
    },
    onAbort: function(what) {
        console.error("==================================================");
        console.error(`[💥 CRASH INTERCEPTÉ V${VERSION_HOTE}] Le moteur WebAssembly a avorté !`);
        console.error(`Raison : ${what}`);
        console.error("==================================================");
    }
};

async function main() {
    console.log("==================================================");
    console.log(`[🚀] Amorce du moteur officiel PinMAME Headless - VERSION ${VERSION_HOTE}`);
    console.log("==================================================");

    try {
        const instance = await createPinMAME(outputModule);
        console.log(`[✅] Module WebAssembly chargé avec succès (Runtime ${VERSION_HOTE}).`);

        const vfsRomDir = '/roms';
        const hostZipPath = path.join(__dirname, 'roms', 'bonebstr.zip');

        if (!fs.existsSync(hostZipPath)) {
            console.error(`[❌ HÔTE V${VERSION_HOTE}] Fichier de ROM introuvable sur le disque : ${hostZipPath}`);
            process.exit(1);
        }

        try {
            instance.FS.mkdir(vfsRomDir);
        } catch (e) {}

        const zipData = fs.readFileSync(hostZipPath);
        instance.FS.writeFile(`${vfsRomDir}/bonebstr.zip`, new Uint8Array(zipData));
        console.log(`[📦 VFS V${VERSION_HOTE}] Fichier bonebstr.zip injecté avec succès dans ${vfsRomDir}/`);

        console.log("==================================================");
        console.log(`[🎰 BOOT V${VERSION_HOTE}] Allumage électrique de run_game(0)...`);
        console.log("==================================================");

        instance._pinmame_web_boot();

        console.log("==================================================");
        console.log(`[🎰 RUNNING V${VERSION_HOTE}] Boucle d'horloge asynchrone active (60Hz)`);
        console.log("==================================================");

        setInterval(() => {
            instance._pinmame_web_tick(33333);
            const displayPointer = instance._pinmame_get_display();
            const displayOutput = readStringFromWasm(instance, displayPointer);
            if (displayOutput) {
                console.log(`[📺 ÉCRAN V${VERSION_HOTE}] ${displayOutput}`);
            }
        }, 1000 / 60);

    } catch (err) {
        console.error("==================================================");
        console.error(`[❌ HÔTE V${VERSION_HOTE}] Fatal crash lors de l'exécution :`);
        console.error(err);
        console.error("==================================================");
        process.exit(1);
    }
}

main();