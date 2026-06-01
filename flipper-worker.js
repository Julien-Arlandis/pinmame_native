// =========================================================================
// 🤖 THREAD DE CALCUL - PINMAME WORKER (flipper-worker.js)
// 🏷️ VERSION : V200.06 - WEB TERMINAL ROUTING INTEGRATION
// =========================================================================

self.window = self;
var window = self;

importScripts('pinmame_web.js');

let pinmameInstance = null;
let vfdMemoryPointer = 0;
let finalRomName = "bonebstr";

let ancienMasqueVFD = new Uint16Array(40);
let anciennesLampes = new Uint8Array(12);
let anciennesBobines = 0;

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

        setTimeout(() => { 
            instance._pinmame_web_boot(); 
            lancerSurveillanceEvenementielle();
        }, 100);

    } catch (err) {
        self.postMessage({ type: 'STATUS', data: "🔴 ERREUR WORKER : " + err.message });
    }
}

function lancerSurveillanceEvenementielle() {
    function loop() {
        if (pinmameInstance && vfdMemoryPointer) {
            
            // 1. SURVEILLANCE VFD
            let vfdChange = false;
            let masquesActuels = new Uint16Array(40);
            for (let i = 0; i < 40; i++) {
                let m = pinmameInstance.HEAPU8[vfdMemoryPointer + (i * 2)] | (pinmameInstance.HEAPU8[vfdMemoryPointer + (i * 2) + 1] << 8);
                masquesActuels[i] = m;
                if (m !== ancienMasqueVFD[i]) vfdChange = true;
            }
            if (vfdChange) {
                self.postMessage({ type: 'VFD_UPDATE', payload: { masques: masquesActuels } });
                ancienMasqueVFD = masquesActuels;
            }

            // 2. SURVEILLANCE LAMPES
            let lampChange = false;
            let lampesActuelles = new Uint8Array(12);
            for (let c = 0; c < 12; c++) {
                let b = pinmameInstance.HEAPU8[vfdMemoryPointer + 300 + c];
                lampesActuelles[c] = b;
                if (b !== anciennesLampes[c]) lampChange = true;
            }
            if (lampChange) {
                self.postMessage({ type: 'LAMPS_UPDATE', payload: { bytes: lampesActuelles } });
                anciennesLampes = lampesActuelles;
            }

            // 3. SURVEILLANCE BOBINES
            let solActuels = (pinmameInstance.HEAPU8[vfdMemoryPointer + 320] | 
                              (pinmameInstance.HEAPU8[vfdMemoryPointer + 321] << 8) | 
                              (pinmameInstance.HEAPU8[vfdMemoryPointer + 322] << 16) | 
                              (pinmameInstance.HEAPU8[vfdMemoryPointer + 323] << 24)) >>> 0;
            
            if (solActuels !== anciennesBobines) {
                for (let s = 0; s < 32; s++) {
                    let ancienEtat = (anciennesBobines >> s) & 1;
                    let nouvelEtat = (solActuels >> s) & 1;
                    if (nouvelEtat !== ancienEtat) {
                        self.postMessage({ type: 'DRIVER_ORDER', payload: { id: s, state: nouvelEtat } });
                    }
                }
                anciennesBobines = solActuels;
            }
        }
        setTimeout(loop, 2); 
    }
    loop();
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