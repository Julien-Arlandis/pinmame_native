import createPinMAME from './pinmame_web.js';
import fsNative from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// 🌟 DÉTECTION DYNAMIQUE DE L'EMPLACEMENT DU SCRIPT (ES MODULES)
// Calcule automatiquement le chemin absolu du dossier contenant CE fichier launcher.js
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log("==================================================");
console.log("[🚀] Amorce de la Sandbox Directe Stabilisée Portable...");
console.log("==================================================");

try {
    const Module = await createPinMAME();
    console.log("[✅] Module WebAssembly chargé.");

    // 🌟 CHEMINS 100% RELATIFS
    // Construit le chemin vers le dossier 'roms' qui se trouve au même endroit que launcher.js
    const baseRomPath = path.join(__dirname, 'roms', 'bonebstr');
    const cpuPath = path.join(baseRomPath, 'prom1.cpu');
    const dspPath = path.join(baseRomPath, 'prom2.cpu');

    if (!fsNative.existsSync(cpuPath) || !fsNative.existsSync(dspPath)) {
        throw new Error(`Fichiers requis introuvables sur le disque à l'emplacement : ${baseRomPath}`);
    }

    const cpuData = fsNative.readFileSync(cpuPath);
    const dspData = fsNative.readFileSync(dspPath);

    // Injection via le HEAPU8 sur les pointeurs isolés
    const cpuPtr = Module._pinmame_get_gprom_ptr();
    Module.HEAPU8.set(cpuData, cpuPtr);

    const dspPtr = Module._pinmame_get_dsprom_ptr();
    Module.HEAPU8.set(dspData, dspPtr);

    console.log(`[📥 RAM] Mappage dynamique des binaires de puces effectué.`);

    // Boot du cœur PinMAME 5.8Mo
    Module._pinmame_web_entry(cpuData.length, dspData.length);

    console.log("==================================================");
    console.log("[🎰 RUNNING] Mode d'écoute actif (60Hz)");
    console.log("==================================================");

    let lastDisplay = "";

    setInterval(() => {
        Module._pinmame_web_tick(0); 
        const displayStr = Module.ccall('pinmame_get_display', 'string', []);
        
        if (displayStr && displayStr !== lastDisplay) {
            process.stdout.write(`\r[🎰 ÉCRAN FLIPPER] [ ${displayStr.substring(0, 20)} ] [ ${displayStr.substring(20, 40)} ]\x1b[K`);
            lastDisplay = displayStr;
        }
    }, 16);

} catch (err) {
    console.error("[💥] Erreur fatale :", err);
}