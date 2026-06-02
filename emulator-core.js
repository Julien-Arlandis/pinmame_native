// emulator-core.js
// Shared emulator logic for browser workers and Node.js.

const isWorker = typeof importScripts === 'function' && typeof self !== 'undefined' && typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope;
const isNode = typeof process !== 'undefined' && process.versions?.node && !(typeof window !== 'undefined');

let createPinMAMEFactory = null;

if (isWorker) {
    globalThis.window = globalThis;
    importScripts('pinmame_web.js');
    createPinMAMEFactory = globalThis.createPinMAME;
} else if (isNode) {
    globalThis.window = globalThis;
    createPinMAMEFactory = require('./pinmame_web.js');
} else {
    throw new Error('Unsupported environment for emulator-core');
}

function makeMessage(type, payload = {}) {
    return { type, payload };
}

function postMessageFromCore(message) {
    if (isWorker) {
        self.postMessage(message);
    } else if (isNode && typeof globalThis.onEmulatorMessage === 'function') {
        globalThis.onEmulatorMessage(message);
    }
}

function readU32(heap, base) {
    return (heap[base] | (heap[base + 1] << 8) | (heap[base + 2] << 16) | (heap[base + 3] << 24)) >>> 0;
}

function writeU32(heap, base, value) {
    heap[base] = value & 0xFF;
    heap[base + 1] = (value >> 8) & 0xFF;
    heap[base + 2] = (value >> 16) & 0xFF;
    heap[base + 3] = (value >> 24) & 0xFF;
}

function b64ToArrayBuffer(base64) {
    const binaryStr = typeof atob === 'function' ? atob(base64) : Buffer.from(base64, 'base64').toString('binary');
    const len = binaryStr.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binaryStr.charCodeAt(i);
    return bytes.buffer;
}

function normalizeRomBytes(customRomBytes) {
    if (!customRomBytes) return null;
    if (customRomBytes instanceof ArrayBuffer) return customRomBytes;
    if (customRomBytes instanceof Uint8Array) return customRomBytes.buffer;
    if (typeof customRomBytes === 'string') return b64ToArrayBuffer(customRomBytes);
    throw new Error('Unsupported customRomBytes format');
}

function createEmulator() {
    let pinmameInstance = null;
    let vfdMemoryPointer = 0;
    let lastVfdCounter = 0;
    let lastLampCounter = 0;
    let lastSolCounter = 0;
    let lastSolState = 0;

    const Module = {
        locateFile: function(path) {
            if (path.endsWith('.wasm')) {
                if (isNode) {
                    const pathModule = require('node:path');
                    return pathModule.join(__dirname, path);
                }
                return 'pinmame_web.wasm';
            }
            return path;
        }
    };

    globalThis.pushWasmAudio = function(ptr, count) {
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
        postMessageFromCore(makeMessage('AUDIO_DATA', { left: leftBuffer, right: rightBuffer, count: count }));
    };

    globalThis.postWasmLog = function(cmdId) {
        postMessageFromCore(makeMessage('AUDIO_CMD_LOG', { cmdId: cmdId }));
    };

    async function initialiserMoteur(customRomBytes, customRomName) {
        postMessageFromCore(makeMessage('STATUS', { }, `🟡 Chargement du moteur WebAssembly...`));
        if (isNode) {
            globalThis.window = globalThis;
        }
        const instance = await createPinMAMEFactory(Module);
        pinmameInstance = instance;

        let romBuffer;
        if (customRomBytes && customRomName) {
            romBuffer = normalizeRomBytes(customRomBytes);
        } else {
            const romName = customRomName || 'bonebstr';
            const fs = isNode ? require('node:fs') : null;
            if (isNode) {
                const pathModule = require('node:path');
                const candidates = [
                    pathModule.join(process.cwd(), 'roms', `${romName}.zip`),
                    pathModule.join(__dirname, 'roms', `${romName}.zip`),
                    pathModule.join(process.cwd(), `${romName}.zip`)
                ];
                const romPath = candidates.find(p => fs.existsSync(p));
                if (!romPath) {
                    throw new Error(`Pack introuvable: ${candidates.join(', ')}`);
                }
                romBuffer = fs.readFileSync(romPath).buffer;
            } else {
                const response = await fetch(`roms/${romName}.zip`);
                if (!response.ok) throw new Error('Pack introuvable (' + response.status + ')');
                romBuffer = await response.arrayBuffer();
            }
        }

        try {
            pinmameInstance.FS.lookupPath('/roms', { parents: true });
        } catch (e) {
            try { pinmameInstance.FS.mkdir('/roms'); } catch (err) {}
        }

        const targetRomName = (customRomName || 'bonebstr').replace('.zip', '').toLowerCase();
        pinmameInstance.FS.writeFile('/roms/' + targetRomName + '.zip', new Uint8Array(romBuffer));

        vfdMemoryPointer = pinmameInstance._pinmame_get_dsprom_ptr();
        const stringAddress = vfdMemoryPointer + 1000;
        for (let i = 0; i < targetRomName.length; i++) pinmameInstance.HEAPU8[stringAddress + i] = targetRomName.charCodeAt(i);
        pinmameInstance.HEAPU8[stringAddress + targetRomName.length] = 0;

        postMessageFromCore(makeMessage('ENGINE_READY', { vfdMemoryPointer: vfdMemoryPointer, romName: targetRomName }));

        setTimeout(() => {
            pinmameInstance._pinmame_web_boot();
            lancerSurveillanceEvenementielle();
        }, 100);
    }

    function lancerSurveillanceEvenementielle() {
        function loop() {
            if (pinmameInstance && vfdMemoryPointer) {
                const vfdCounter = readU32(pinmameInstance.HEAPU8, vfdMemoryPointer + 1080);
                if (vfdCounter !== lastVfdCounter) {
                    lastVfdCounter = vfdCounter;
                    const masquesActuels = new Uint16Array(40);
                    for (let i = 0; i < 40; i++) {
                        let offset = vfdMemoryPointer + (i * 2);
                        masquesActuels[i] = pinmameInstance.HEAPU8[offset] | (pinmameInstance.HEAPU8[offset + 1] << 8);
                    }
                    postMessageFromCore(makeMessage('VFD_UPDATE', { masques: masquesActuels }));
                }

                const lampCounter = readU32(pinmameInstance.HEAPU8, vfdMemoryPointer + 1084);
                if (lampCounter !== lastLampCounter) {
                    lastLampCounter = lampCounter;
                    const lampesActuelles = new Uint8Array(12);
                    for (let c = 0; c < 12; c++) {
                        lampesActuelles[c] = pinmameInstance.HEAPU8[vfdMemoryPointer + 300 + c];
                    }
                    postMessageFromCore(makeMessage('LAMPS_UPDATE', { bytes: lampesActuelles }));
                }

                const solCounter = readU32(pinmameInstance.HEAPU8, vfdMemoryPointer + 1088);
                if (solCounter !== lastSolCounter) {
                    lastSolCounter = solCounter;
                    const solActuels = (pinmameInstance.HEAPU8[vfdMemoryPointer + 320] |
                                         (pinmameInstance.HEAPU8[vfdMemoryPointer + 321] << 8) |
                                         (pinmameInstance.HEAPU8[vfdMemoryPointer + 322] << 16) |
                                         (pinmameInstance.HEAPU8[vfdMemoryPointer + 323] << 24)) >>> 0;
                    for (let s = 0; s < 32; s++) {
                        const ancienEtat = (lastSolState >> s) & 1;
                        const nouvelEtat = (solActuels >> s) & 1;
                        if (nouvelEtat !== ancienEtat) {
                            postMessageFromCore(makeMessage('DRIVER_ORDER', { id: s, state: nouvelEtat }));
                        }
                    }
                    lastSolState = solActuels;
                }
            }
            setTimeout(loop, 16);
        }
        loop();
    }

    function handleMessage(type, payload) {
        switch (type) {
            case 'INIT_ENGINE':
                return initialiserMoteur(payload.customRomBytes, payload.customRomName);
            case 'INJECT_INPUT':
                if (pinmameInstance && vfdMemoryPointer) {
                    pinmameInstance.HEAPU8[vfdMemoryPointer + 100 + payload.id] = payload.state;
                }
                break;
            case 'UPDATE_DIPS':
                if (pinmameInstance && vfdMemoryPointer) {
                    for (let i = 0; i < 32; i++) {
                        pinmameInstance.HEAPU8[vfdMemoryPointer + 400 + i] = payload.dips[i] ? 1 : 0;
                    }
                }
                break;
            case 'TRIGGER_SOUND_CMD':
                if (pinmameInstance && vfdMemoryPointer) {
                    pinmameInstance.HEAPU8[vfdMemoryPointer + 1060] = payload.cmdId;
                }
                break;
            case 'UPDATE_AUDIO_DISTANCE':
                if (pinmameInstance && vfdMemoryPointer) {
                    writeU32(pinmameInstance.HEAPU8, vfdMemoryPointer + 1070, payload.distance);
                }
                break;
        }
    }

    return { sendMessage: handleMessage };
}

if (isWorker) {
    const emulator = createEmulator();
    self.onmessage = function(event) {
        const { type, payload } = event.data;
        emulator.sendMessage(type, payload);
    };
}

if (isNode) {
    module.exports = { createEmulator };
}
