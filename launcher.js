const fs = require('fs');
const zlib = require('zlib');
const createPinMAME = require('./pinmame_web.js');

console.log("==================================================");
console.log("[🚀] Amorce du moteur officiel PinMAME Headless...");
console.log("==================================================");

function extractExactFile(zipBuffer, targetPath) {
    let offset = 0;
    while (offset < zipBuffer.length) {
        const signature = zipBuffer.readUInt32LE(offset);
        if (signature !== 0x04034b50) break;
        const fileNameLength = zipBuffer.readUInt16LE(offset + 26);
        const extraFieldLength = zipBuffer.readUInt16LE(offset + 28);
        const compressionMethod = zipBuffer.readUInt16LE(offset + 8);
        const compressedSize = zipBuffer.readUInt32LE(offset + 18);
        const currentFilename = zipBuffer.toString('utf8', offset + 30, offset + 30 + fileNameLength);
        const dataOffset = offset + 30 + fileNameLength + extraFieldLength;

        if (currentFilename.toLowerCase() === targetPath.toLowerCase() || 
            currentFilename.toLowerCase().endsWith(targetPath.toLowerCase())) {
            const compressedData = zipBuffer.slice(dataOffset, dataOffset + compressedSize);
            if (compressionMethod === 0) return compressedData;
            if (compressionMethod === 8) return zlib.inflateRawSync(compressedData);
        }
        offset = dataOffset + compressedSize;
    }
    return null;
}

createPinMAME().then((Module) => {
    console.log("[✅] Module WebAssembly chargé.");

    // 1. Déclaration des passerelles Cwrap
    const pinmameWebEntry   = Module.cwrap('pinmame_web_entry', null, ['number', 'number']);
    const pinmameWebBoot    = Module.cwrap('pinmame_web_boot', null, []);
    const pinmameGetDisplay = Module.cwrap('pinmame_get_display', 'string', []);

    // Allocation initiale du pont
    pinmameWebEntry(8192, 4096);

    try {
        const zipBuffer = fs.readFileSync('./roms/bonebstr.zip');
        
        // Extraction des puces CPU requises par run_game()
        const prom1Buf = extractExactFile(zipBuffer, 'prom1.cpu');
        const prom2Buf = extractExactFile(zipBuffer, 'prom2.cpu');

        if (prom1Buf && prom2Buf) {
            // Écriture forcée à la racine du VFS virtuel d'Emscripten
            Module.FS.writeFile('prom1.cpu', prom1Buf);
            Module.FS.writeFile('prom2.cpu', prom2Buf);
            console.log("  -> [📦 VFS] Puces prom1.cpu et prom2.cpu montées avec succès.");
        } else {
            console.error("[❌ HÔTE] Fichiers ROM corrompus ou manquants.");
            process.exit(1);
        }

    } catch(err) {
        console.error("[❌ HÔTE] Échec du montage VFS :", err.message);
        process.exit(1);
    }

    console.log("==================================================");
    console.log("[🎰 BOOT] Allumage électrique de run_game(0)...");
    console.log("==================================================");

    // 2. 🌟 L'APPEL CRITIQUE ASYNCHRONE : On lance le moteur MAME
    // Grâce au flag -sASYNCIFY, cette fonction va s'élancer sans bloquer Node.js
    try {
        pinmameWebBoot();
    } catch (bootError) {
        console.error("[❌ HÔTE] Crash immédiat au boot :", bootError);
    }

    // 3. Boucle de monitoring passive à 60Hz
    setInterval(() => {
        try {
            const displayStr = pinmameGetDisplay();
            if (displayStr) {
                console.log(`[📺 ÉCRAN] ${displayStr}`);
            }
        } catch (e) {
            // Ignorer les latences de rafraîchissement
        }
    }, 1000 / 60);
});