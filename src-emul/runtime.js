// runtime.js
// Shared emulator core — browser Worker and Node.js
// Protocol: { channel, line } for all I/O except audio ({ channel:'audio', left, right })

const isWorker = typeof importScripts === 'function' && typeof self !== 'undefined' && typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope;
const isNode = typeof process !== 'undefined' && process.versions?.node && !(typeof window !== 'undefined');

let createPinMAMEFactory = null;
let _emulatorGeneration = 0;

const _bundled = typeof __PINMAME_WASM_BINARY__ !== 'undefined';

if (isWorker) {
    globalThis.window = globalThis;
    if (!_bundled) importScripts('pinmame_web.js');
    createPinMAMEFactory = globalThis.createPinMAME || createPinMAME;
} else if (isNode) {
    globalThis.window = globalThis;
    createPinMAMEFactory = _bundled ? createPinMAME : require('./pinmame_web.js');
} else {
    throw new Error('Unsupported environment for runtime.js');
}

// Chargement de audio.js pour les environnements non-bundlés
if (!_bundled) {
    if (isWorker) importScripts('runtime-audio.js');
    else if (isNode) require('./runtime-audio.js');
}

function readU32(heap, base) {
    return (heap[base] | (heap[base + 1] << 8) | (heap[base + 2] << 16) | (heap[base + 3] << 24)) >>> 0;
}

function writeU32(heap, base, value) {
    heap[base]     = value & 0xFF;
    heap[base + 1] = (value >> 8)  & 0xFF;
    heap[base + 2] = (value >> 16) & 0xFF;
    heap[base + 3] = (value >> 24) & 0xFF;
}

function b64ToArrayBuffer(base64) {
    const clean = base64.replace(/ /g, '+');
    const binaryStr = typeof atob === 'function' ? atob(clean) : Buffer.from(clean, 'base64').toString('binary');
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
    return bytes.buffer;
}

function normalizeRomBytes(customRomBytes) {
    if (!customRomBytes) return null;
    if (customRomBytes instanceof ArrayBuffer) return customRomBytes;
    if (customRomBytes instanceof Uint8Array) return customRomBytes.buffer;
    if (typeof customRomBytes === 'string') return b64ToArrayBuffer(customRomBytes);
    throw new Error('Unsupported customRomBytes format');
}

// sendLine(channel, line)  — envoie une ligne texte vers l'hôte
// sendAudio(left, right)   — envoie des frames Float32Array vers l'hôte
// loadRom(romName, baseUrl) → Promise<ArrayBuffer>
function createEmulator({ sendLine, sendAudio, sendCapture, sendScope, loadRom }) {
    const generation = ++_emulatorGeneration;
    let pinmameInstance = null;
    let vfdMemoryPointer = 0;
    let lastSolState = 0;

    const Module = {
        get wasmBinary() { return globalThis.__PINMAME_WASM_BINARY__; },
        locateFile(path) {
            if (path.endsWith('.wasm')) {
                if (_bundled) return path;
                if (isNode) return require('node:path').join(__dirname, path);
                return 'pinmame_web.wasm';
            }
            return path;
        },
        noExitRuntime: true
    };

    globalThis.pushWasmDisplay = function(ptr, callerGen) {
        if (callerGen !== generation) return;
        if (!pinmameInstance) return;
        let data = '';
        for (let i = 0; i < 40; i++) {
            const lo = pinmameInstance.HEAPU8[ptr + i * 2];
            const hi = pinmameInstance.HEAPU8[ptr + i * 2 + 1];
            data += (lo | (hi << 8)).toString(16).padStart(4, '0');
        }
        sendLine('display', `!display:action=raw&data=${data}`);
    };

    globalThis.pushWasmDisplayText = function(text, callerGen) {
        if (callerGen !== generation) return;
        sendLine('display', `!display:action=text&data=${encodeURIComponent(text)}`);
    };

    globalThis.pushWasmLamps = function(ptr, callerGen) {
        if (callerGen !== generation) return;
        if (!pinmameInstance) return;
        let lampHex = '';
        for (let col = 0; col < 12; col++)
            lampHex += pinmameInstance.HEAPU8[ptr + col].toString(16).padStart(2, '0');
        sendLine('driver', `!lamp:${lampHex}`);
    };

    globalThis.pushWasmSolens = function(solState, callerGen) {
        if (callerGen !== generation) return;
        for (let s = 0; s < 32; s++) {
            if (((solState >> s) & 1) !== ((lastSolState >> s) & 1))
                sendLine('driver', `!set:id=${s}&state=${(solState >> s) & 1}`);
        }
        lastSolState = solState;
    };

    globalThis.postWasmLog = function(cmdId, callerGen) {
        if (callerGen !== generation) return;
        sendLine('status', `@audio:cmd=0x${cmdId.toString(16).toUpperCase()}`);
    };

    globalThis.postWasmSoundChips = function(chips) {
        if (generation !== _emulatorGeneration) return;
        sendLine('status', `@sound:chips=${chips}`);
    };

    globalThis.postWasmDacRange = function(min, max, absMax) {
        sendLine('status', `@dacrange:min=${min}&max=${max}&absmax=${absMax}`);
    };

    globalThis.postWasmMachineInfo = function(info) {
        if (generation !== _emulatorGeneration) return;
        sendLine('status', `@machine:${info}`);
        // compatibilité Node.js : extraire snd= et l'envoyer séparément
        const m = info.split('|').find(s => s.startsWith('snd='));
        if (m) sendLine('status', `@sound:chips=${m.slice(4).split('+').join(', ')}`);
    };

    async function initialiserMoteur(customRomBytes, customRomName, baseUrl) {
        sendLine('status', '@status:state=loading');

        const instance = await createPinMAMEFactory(Module);
        pinmameInstance = instance;

        const audio = createAudioProcessor({
            pinmameInstance: instance,
            sendAudio,
            sendCapture,
            sendScope,
            generation,
            getEmulatorGeneration: () => _emulatorGeneration
        });
        audio.installGlobals();

        let romBuffer;
        if (customRomBytes && customRomName) {
            romBuffer = normalizeRomBytes(customRomBytes);
        } else {
            romBuffer = await loadRom(customRomName || 'bonebstr', baseUrl);
        }

        try { pinmameInstance.FS.lookupPath('/roms', { parents: true }); }
        catch (e) { try { pinmameInstance.FS.mkdir('/roms'); } catch (_) {} }

        const targetRomName = (customRomName || 'bonebstr').replace('.zip', '').toLowerCase();
        pinmameInstance.FS.writeFile(`/roms/${targetRomName}.zip`, new Uint8Array(romBuffer));

        vfdMemoryPointer = pinmameInstance._pinmame_get_dsprom_ptr();
        // Stamp our generation into the Wasm's own shared corridor (slot 1076).
        // api.cpp reads this and passes it back on every callback, so JS can reject
        // audio/display calls from stale Wasm instances that are still looping.
        writeU32(pinmameInstance.HEAPU8, vfdMemoryPointer + 1076, generation);

        audio.startPacing(handleLine);

        const strAddr = vfdMemoryPointer + 1000;
        for (let i = 0; i < targetRomName.length; i++) pinmameInstance.HEAPU8[strAddr + i] = targetRomName.charCodeAt(i);
        pinmameInstance.HEAPU8[strAddr + targetRomName.length] = 0;

        sendLine('status', `@status:state=ready&rom=${encodeURIComponent(targetRomName)}`);

        setTimeout(() => { pinmameInstance._pinmame_web_boot(); }, 100);
    }

    // Parse a text protocol line coming from the INPUT channel
    function handleLine(line) {
        if (!line || !pinmameInstance || !vfdMemoryPointer) return;
        let p;
        if (line.startsWith('@set:')) {
            p = new URLSearchParams(line.slice(5));
            const id = parseInt(p.get('id')), state = parseInt(p.get('state'));
            if (!isNaN(id)) pinmameInstance.HEAPU8[vfdMemoryPointer + 100 + id] = state;
        } else if (line.startsWith('@dip:')) {
            p = new URLSearchParams(line.slice(5));
            const id = parseInt(p.get('id')), state = parseInt(p.get('state'));
            if (!isNaN(id)) pinmameInstance.HEAPU8[vfdMemoryPointer + 400 + id] = state;
        } else if (line.startsWith('@sound:')) {
            p = new URLSearchParams(line.slice(7));
            const cmd = parseInt(p.get('cmd'));
            if (!isNaN(cmd)) pinmameInstance.HEAPU8[vfdMemoryPointer + 1060] = cmd;
        } else if (line.startsWith('@audio:')) {
            p = new URLSearchParams(line.slice(7));
            const dist = parseInt(p.get('distance'));
            if (!isNaN(dist)) writeU32(pinmameInstance.HEAPU8, vfdMemoryPointer + 1070, dist);
            const chip = parseFloat(p.get('chip')), dac = parseFloat(p.get('dac'));
            if (!isNaN(chip) && !isNaN(dac) && globalThis.setAudioMix) globalThis.setAudioMix(chip, dac);
            const sep = p.get('sep');
            if (sep !== null && globalThis.setAudioSep) globalThis.setAudioSep(sep === '1');
        } else if (line.startsWith('@scope:')) {
            p = new URLSearchParams(line.slice(7));
            globalThis._scopeActive = p.get('on') === '1';
        } else if (line.startsWith('@capture:')) {
            p = new URLSearchParams(line.slice(9));
            const action = p.get('action');
            if (action === 'start' && globalThis.startCapture) globalThis.startCapture();
            else if (action === 'stop' && globalThis.stopCapture) globalThis.stopCapture();
        }
    }

    function handleMessage(type, payload) {
        if (type === 'INIT_ENGINE') return initialiserMoteur(payload.customRomBytes, payload.customRomName, payload.baseUrl);
    }

    return { sendMessage: handleMessage, handleLine };
}

// ── Browser Worker ──────────────────────────────────────────────────────────

if (isWorker) {
    let emulator = null;
    self.onmessage = function(event) {
        const msg = event.data;
        if (msg.type === 'WASM_BINARY') {
            globalThis.__PINMAME_WASM_BINARY__ = new Uint8Array(msg.data);
            emulator = createEmulator({
                sendLine:    (ch, line) => self.postMessage({ channel: ch, line }),
                sendAudio:   (l, r)     => self.postMessage({ channel: 'audio', left: l, right: r }),
                sendCapture: (d)        => self.postMessage({ channel: 'capture', ym_L: d.ym_L, ym_R: d.ym_R, dac: d.dac }, [d.ym_L.buffer, d.ym_R.buffer, d.dac.buffer]),
                sendScope:   (d)        => self.postMessage({ channel: 'scope',   ym_L: d.ym_L, ym_R: d.ym_R, dac: d.dac, spk_L: d.spk_L, spk_R: d.spk_R }),
                loadRom:   async (romName, baseUrl) => {
                    const url = baseUrl ? new URL(`roms/${romName}.zip`, baseUrl).href : `roms/${romName}.zip`;
                    const resp = await fetch(url);
                    if (!resp.ok) throw new Error(`Pack introuvable (${resp.status})`);
                    return resp.arrayBuffer();
                }
            });
        } else if (msg.channel && msg.line) {
            if (emulator) emulator.handleLine(msg.line);
        } else if (msg.type) {
            if (emulator) emulator.sendMessage(msg.type, msg.payload);
        }
    };
    // WASM_BINARY puis INIT_ENGINE sont envoyés par le thread principal
}

// ── Node.js export ──────────────────────────────────────────────────────────

if (isNode) module.exports = { createEmulator };
