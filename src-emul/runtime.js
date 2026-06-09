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
function createEmulator({ sendLine, sendAudio, loadRom }) {
    const generation = ++_emulatorGeneration;
    let pinmameInstance = null;
    let vfdMemoryPointer = 0;
    let lastSolState = 0;
    let samplesProduced = 0;
    let firstAudioTime = null;

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

    // Dernier sample DAC de la frame précédente, pour continuité inter-frames
    const lastFrameDacOut = [0.0, 0.0];
    // État du filtre passe-bas anti-aliasing DAC (1-pôle, fc ≈ 7 kHz @ 44100 Hz)
    // Lisse les artefacts "escalier" de l'upsampling ~15625 Hz → 44100 Hz
    // sans affecter le caractère percussif (gain ≈ -3 dB à 7 kHz, -10 dB à 12 kHz)
    const dacLpState = [0.0, 0.0];
    // a = 1 - exp(-2π*7000/44100) ≈ 0.631  →  pôle à 0.369
    const DAC_LP_A = 0.631;

    globalThis.pushWasmAudio = function(ptr, count, callerGen) {
        if (callerGen !== generation) return;
        if (!pinmameInstance) return;
        if (firstAudioTime === null) firstAudioTime = Date.now();
        const ptr16  = ptr >> 1;
        const frames = count / 2;
        const left   = new Float32Array(frames);
        const right  = new Float32Array(frames);

        for (let i = 0, idx = 0; i < count; i += 2, idx++) {
            left[idx]  = pinmameInstance.HEAP16[ptr16 + i]     / 32768.0;
            right[idx] = pinmameInstance.HEAP16[ptr16 + i + 1] / 32768.0;
        }

        // Mixer la contribution DAC (jeux sans YM2151 : Robowars, b2…)
        for (let chip = 0; chip < 2; chip++) {
            const n = pinmameInstance._api_get_dac_count(chip);
            if (n === 0) continue;

            const dacPtr32 = pinmameInstance._api_get_dac_buffer(chip) >>> 2;

            // L'intégrateur DC-offset est déjà appliqué dans api.cpp (réplique dac.c).
            // Les valeurs stockées sont en -32768..32767 → normaliser directement.
            const processed = new Float32Array(n);
            for (let i = 0; i < n; i++) {
                processed[i] = pinmameInstance.HEAP32[dacPtr32 + i] / 32768.0;
            }

            // Redistribuer sur frames samples en incluant le dernier sample de la frame
            // précédente comme point de départ → interpolation continue inter-frames.
            // Points de référence : [lastFrameDacOut, processed[0..n-1]] = n+1 points
            const prevVal = lastFrameDacOut[chip];
            const scale   = n / (frames - 1);  // n intervals sur frames-1 pas
            let   lp      = dacLpState[chip];
            for (let s = 0; s < frames; s++) {
                const pos  = s * scale;
                const i0   = pos | 0;           // 0 = frame précédente, 1..n = processed[0..n-1]
                const i1   = i0 + 1 <= n ? i0 + 1 : i0;
                const frac = pos - i0;
                const v0   = i0 === 0 ? prevVal : processed[i0 - 1];
                const v1   = i1 === 0 ? prevVal : processed[i1 - 1];
                const raw  = v0 * (1 - frac) + v1 * frac;
                // Filtre passe-bas 1-pôle : lisse les artefacts d'upsampling DAC
                lp = (1 - DAC_LP_A) * lp + DAC_LP_A * raw;
                left[s]  = Math.max(-1, Math.min(1, left[s]  + lp));
                right[s] = Math.max(-1, Math.min(1, right[s] + lp));
            }
            dacLpState[chip]      = lp;
            lastFrameDacOut[chip] = processed[n - 1];

            pinmameInstance._api_reset_dac_buffer(chip);
        }

        sendAudio(left, right);
        samplesProduced += frames;
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

    async function initialiserMoteur(customRomBytes, customRomName, baseUrl) {
        sendLine('status', '@status:state=loading');

        const instance = await createPinMAMEFactory(Module);
        pinmameInstance = instance;

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

        // Self-contained pacing: regulate emulator speed via @audio:distance every 32ms.
        // Works identically in Worker and Node.js — no external pacing needed.
        samplesProduced = 0;
        firstAudioTime = null;
        const pacingInterval = setInterval(() => {
            if (generation !== _emulatorGeneration) { clearInterval(pacingInterval); return; }
            const dist = firstAudioTime !== null
                ? Math.max(0, samplesProduced - Math.floor((Date.now() - firstAudioTime) / 1000 * 44100))
                : 0;
            handleLine(`@audio:distance=${dist}`);
        }, 32);

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
                sendLine:  (ch, line) => self.postMessage({ channel: ch, line }),
                sendAudio: (l, r)    => self.postMessage({ channel: 'audio', left: l, right: r }),
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
