// =========================================================================
// 🤖 THREAD DE CALCUL - PINMAME WORKER (flipper-worker.js)
// 🏷️ VERSION : V200.04 - ÉVÉNEMENTIEL DISPLAY FIX
// =========================================================================

self.window = self;
var window = self;

importScripts('pinmame_web.js');

let pinmameInstance = null;
let vfdMemoryPointer = 0;
let finalRomName = "bonebstr";
let ancienMasqueEcran = new Uint16Array(40); // Pour détecter les changements

var Module = {
    print: function(text) { self.postMessage({ type: 'LOG', data: text }); },
    printErr: function(err) { self.postMessage({ type: 'LOG', data: "ERR: " + err }); },
    locateFile: function(path, prefix) { 
        return path.endsWith('.wasm') ? 'pinmame_web.wasm' : prefix + path; 
    }
};

self.onmessage = async function(event) {
    const { type, payload } = event.data;
    switch (type) {
        case 'INIT_ENGINE':
            await initialiserMoteur(payload.customRomBytes, payload.customRomName);
            break;
        case 'INJECT_INPUT':
            if (pinmameInstance && vfdMemoryPointer) {
                pinmameInstance.HEAPU8[vfdMemoryPointer + 100 + payload.id] = payload.state;
            }
            break;
        case 'UPDATE_DIPS':
            if (pinmameInstance && vfdMemoryPointer) {
                for (let i = 0; i < 32; i++) pinmameInstance.HEAPU8[vfdMemoryPointer + 400 + i] = payload.dips[i] ? 1 : 0;
            }
            break;
        case 'TRIGGER_SOUND_CMD':
            if (pinmameInstance && vfdMemoryPointer) pinmameInstance.HEAPU8[vfdMemoryPointer + 1060] = payload.cmdId;
            break;
        case 'UPDATE_AUDIO_DISTANCE':
            if (pinmameInstance && vfdMemoryPointer) {
                pinmameInstance.HEAPU8[vfdMemoryPointer + 1070] = payload.distance & 0xFF;
                pinmameInstance.HEAPU8[vfdMemoryPointer + 1071] = (payload.distance >> 8) & 0xFF;
                pinmameInstance.HEAPU8[vfdMemoryPointer + 1072] = (payload.distance >> 16) & 0xFF;
                pinmameInstance.HEAPU8[vfdMemoryPointer + 1073] = (payload.distance >> 24) & 0xFF;
            }
            break;
    }
};

async function initialiserMoteur(customRomBytes, customRomName) {
    try {
        self.postMessage({ type: 'STATUS', data: "🟡 Chargement du moteur WebAssembly..." });
        const instance = await createPinMAME(Module);
        pinmameInstance = instance;

        let romBuffer;
        if (customRomBytes && customRomName) {
            finalRomName = customRomName.replace('.zip', '').toLowerCase();
            const binaryStr = atob(customRomBytes);
            const bytes = new Uint8Array(binaryStr.length);
            for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
            romBuffer = bytes.buffer;
        } else {
            const urlRom = "roms/" + finalRomName + ".zip";
            const response = await fetch(urlRom);
            if (!response.ok) throw new Error("Pack introuvable (" + response.status + ")");
            romBuffer = await response.arrayBuffer();
        }

        instance.FS.mkdir('/roms');
        instance.FS.writeFile('/roms/' + finalRomName + '.zip', new Uint8Array(romBuffer));
        vfdMemoryPointer = instance._pinmame_get_dsprom_ptr();

        const stringAddress = vfdMemoryPointer + 1000;
        for (let i = 0; i < finalRomName.length; i++) instance.HEAPU8[stringAddress + i] = finalRomName.charCodeAt(i);
        instance.HEAPU8[stringAddress + finalRomName.length] = 0;

        self.postMessage({ 
            type: 'ENGINE_READY', 
            payload: { vfdMemoryPointer: vfdMemoryPointer, romName: finalRomName } 
        });

        // Démarrage du CPU émulé
        setTimeout(() => { 
            instance._pinmame_web_boot(); 
            // Lancement du scanner d'affichage synchronisé sur la boucle du Worker
            sychroniserAffichageVFD();
        }, 100);

    } catch (err) {
        self.postMessage({ type: 'STATUS', data: "🔴 ERREUR WORKER : " + err.message });
    }
}

// 📺 SCANNER ÉVÉNEMENTIEL DE L'AFFICHEUR
function sychroniserAffichageVFD() {
    setInterval(() => {
        if (!pinmameInstance || !vfdMemoryPointer) return;

        let changementDetecte = false;
        let masquesActuels = new Uint16Array(40);

        // On extrait l'état des segments (2 octets par caractère pour 40 caractères)
        for (let i = 0; i < 40; i++) {
            let bas = pinmameInstance.HEAPU8[vfdMemoryPointer + (i * 2)];
            let haut = pinmameInstance.HEAPU8[vfdMemoryPointer + (i * 2) + 1];
            let masque16bits = bas | (haut << 8);
            
            masquesActuels[i] = masque16bits;

            if (masque16bits !==  ancienMasqueEcran[i]) {
                changementDetecte = true;
            }
        }

        // 🚀 Si l'afficheur a bougé, on envoie le nouveau calque à l'IHM
        if (changementDetecte) {
            self.postMessage({
                type: 'VFD_UPDATE',
                payload: { masques: masquesActuels }
            });
            ancienMasqueEcran = masquesActuels;
        }
    }, 16); // Vérification à ~60 Hz à l'intérieur du Worker
}

self.pushWasmAudio = function(ptr, count) {
    if (!pinmameInstance) return;
    const ptr16 = ptr >> 1;
    const leftBuffer = new Float32Array(count / 2);
    const rightBuffer = new Float32Array(count / 2);
    let idx = 0;
    for (let i = 0; i < count; i += 2) {
        leftBuffer[idx] = pinmameInstance.HEAP16[ptr16 + i] / 32768.0;
        rightBuffer[idx] = pinmameInstance.HEAP16[ptr16 + i + 1] / 32768.0;
        idx++;
    }
    self.postMessage({
        type: 'AUDIO_DATA',
        payload: { left: leftBuffer, right: rightBuffer, count: count }
    }, [leftBuffer.buffer, rightBuffer.buffer]);
};

self.postWasmLog = function(cmdId) {
    self.postMessage({ type: 'AUDIO_CMD_LOG', payload: { cmdId: cmdId } });
};