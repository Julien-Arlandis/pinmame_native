// =========================================================================
// 🌐 INFRASTRUCTURE PINMAME WASM - FIL PILOTE WEB WORKER ASYNCHRONE
// =========================================================================

self.importScripts('pinmame_web.js');

let pinmameInstance = null;
let sharedCorridorPtr = 0;

self.onmessage = async function(e) {
    const data = e.data;

    if (data.cmd === 'START') {
        createPinMAME({
            print: function(text) { self.postMessage({ type: 'LOG', msg: "[CORE] " + text }); },
            printErr: function(err) { self.postMessage({ type: 'ERR', msg: "[ERR] " + err }); },
            locateFile: function(path) { return path; }
        }).then(async (instance) => {
            pinmameInstance = instance;
            sharedCorridorPtr = instance._pinmame_get_dsprom_ptr();

            try { instance.FS.mkdir('/roms'); } catch(err) {}

            // Cas n°1 : Écriture de la ROM injectée en SessionStorage local
            if (data.customRomBytes && data.customRomName) {
                const binaryStr = atob(data.customRomBytes);
                const bytes = new Uint8Array(binaryStr.length);
                for (let i = 0; i < binaryStr.length; i++) {
                    bytes[i] = binaryStr.charCodeAt(i);
                }
                instance.FS.writeFile(`/roms/${data.customRomName}`, bytes);
                self.postMessage({ type: 'LOG', msg: "[WORKER] Écriture du conteneur de ROM local effectuée." });
            } 
            // Cas n°2 : Téléchargement asynchrone direct du pack de ROMs par défaut
            else {
                try {
                    const response = await fetch(`roms/${data.romName}.zip`);
                    if (!response.ok) throw new Error("Fichier introuvable sur le serveur.");
                    const arrayBuffer = await response.arrayBuffer();
                    instance.FS.writeFile(`/roms/${data.romName}.zip`, new Uint8Array(arrayBuffer));
                    self.postMessage({ type: 'LOG', msg: "[WORKER] Téléchargement et synchronisation du pack par défaut réussis." });
                } catch(fetchErr) {
                    self.postMessage({ type: 'ERR', msg: "[WORKER] Erreur critique d'approvisionnement : " + fetchErr.message });
                    return;
                }
            }

            const romName = data.romName;
            const strAddress = sharedCorridorPtr + 1000;
            for (let i = 0; i < romName.length; i++) {
                instance.HEAPU8[strAddress + i] = romName.charCodeAt(i);
            }
            instance.HEAPU8[strAddress + romName.length] = 0;

            self.postMessage({ type: 'READY' });
            instance._pinmame_web_boot();
        });
    }

    if (data.cmd === 'SYNC_INPUTS' && pinmameInstance && sharedCorridorPtr) {
        pinmameInstance.HEAPU8.set(data.switchBuffer, sharedCorridorPtr + 100);
        pinmameInstance.HEAPU8.set(data.dipBuffer, sharedCorridorPtr + 400);
        
        if (data.audioCmd > 0) {
            pinmameInstance.HEAPU8[sharedCorridorPtr + 1060] = data.audioCmd;
        }

        pinmameInstance.HEAPU8[sharedCorridorPtr + 1070] = data.audioDist & 0xFF;
        pinmameInstance.HEAPU8[sharedCorridorPtr + 1071] = (data.audioDist >> 8) & 0xFF;
        pinmameInstance.HEAPU8[sharedCorridorPtr + 1072] = (data.audioDist >> 16) & 0xFF;
        pinmameInstance.HEAPU8[sharedCorridorPtr + 1073] = (data.audioDist >> 24) & 0xFF;

        const vfdBuffer = new Uint8Array(pinmameInstance.HEAPU8.buffer, sharedCorridorPtr, 80);
        const lampBuffer = new Uint8Array(pinmameInstance.HEAPU8.buffer, sharedCorridorPtr + 300, 12);
        const solBuffer = new Uint8Array(pinmameInstance.HEAPU8.buffer, sharedCorridorPtr + 320, 4);

        let pcmData = null;
        const sampleCount = pinmameInstance.HEAPU8[sharedCorridorPtr + 1050] | (pinmameInstance.HEAPU8[sharedCorridorPtr + 1051] << 8) | (pinmameInstance.HEAPU8[sharedCorridorPtr + 1052] << 16) | (pinmameInstance.HEAPU8[sharedCorridorPtr + 1053] << 24);
        
        if (sampleCount > 0) {
            const bufferPtr = pinmameInstance.HEAPU8[sharedCorridorPtr + 1054] | (pinmameInstance.HEAPU8[sharedCorridorPtr + 1055] << 8) | (pinmameInstance.HEAPU8[sharedCorridorPtr + 1056] << 16) | (pinmameInstance.HEAPU8[sharedCorridorPtr + 1057] << 24);
            pcmData = new Int16Array(pinmameInstance.HEAPU8.buffer, bufferPtr, sampleCount).slice();
            
            pinmameInstance.HEAPU8[sharedCorridorPtr + 1050] = 0;
            pinmameInstance.HEAPU8[sharedCorridorPtr + 1051] = 0;
            pinmameInstance.HEAPU8[sharedCorridorPtr + 1052] = 0;
            pinmameInstance.HEAPU8[sharedCorridorPtr + 1053] = 0;
        }

        const soundLogCmd = pinmameInstance.HEAPU8[sharedCorridorPtr + 1064];
        if (soundLogCmd > 0) {
            pinmameInstance.HEAPU8[sharedCorridorPtr + 1064] = 0;
        }

        self.postMessage({
            type: 'FRAME_UPDATE',
            vfd: vfdBuffer.slice(),
            lamps: lampBuffer.slice(),
            solenoids: solBuffer.slice(),
            audioData: pcmData,
            soundLogCmd: soundLogCmd
        });
    }
};