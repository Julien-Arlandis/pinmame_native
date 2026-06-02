// runtime.js
// Shared emulator core — browser Worker and Node.js
// Protocol: { channel, line } for all I/O except audio ({ channel:'audio', left, right })

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
    throw new Error('Unsupported environment for runtime.js');
}

function postToChannel(channel, line) {
    if (isWorker) {
        self.postMessage({ channel, line });
    } else if (isNode && typeof globalThis.onEmulatorMessage === 'function') {
        globalThis.onEmulatorMessage({ channel, line });
    }
}

function postAudio(left, right) {
    if (isWorker) {
        self.postMessage({ channel: 'audio', left, right });
    } else if (isNode && typeof globalThis.onEmulatorMessage === 'function') {
        globalThis.onEmulatorMessage({ channel: 'audio', left, right });
    }
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
    const binaryStr = typeof atob === 'function' ? atob(base64) : Buffer.from(base64, 'base64').toString('binary');
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

function createEmulator() {
    let pinmameInstance = null;
    let vfdMemoryPointer = 0;
    let lastVfdCounter  = 0;
    let lastLampCounter = 0;
    let lastSolCounter  = 0;
    let lastSolState    = 0;

    const Module = {
        locateFile(path) {
            if (path.endsWith('.wasm')) {
                if (isNode) return require('node:path').join(__dirname, path);
                return 'pinmame_web.wasm';
            }
            return path;
        },
        noExitRuntime: true
    };

    globalThis.pushWasmAudio = function(ptr, count) {
        if (!pinmameInstance) return;
        const ptr16 = ptr >> 1;
        const left  = new Float32Array(count / 2);
        const right = new Float32Array(count / 2);
        for (let i = 0, idx = 0; i < count; i += 2, idx++) {
            left[idx]  = pinmameInstance.HEAP16[ptr16 + i]     / 32768.0;
            right[idx] = pinmameInstance.HEAP16[ptr16 + i + 1] / 32768.0;
        }
        postAudio(left, right);
    };

    globalThis.postWasmLog = function(cmdId) {
        postToChannel('status', `@audio:cmd=0x${cmdId.toString(16).toUpperCase()}`);
    };

    async function initialiserMoteur(customRomBytes, customRomName) {
        postToChannel('status', '@status:state=loading');
        if (isNode) globalThis.window = globalThis;

        const instance = await createPinMAMEFactory(Module);
        pinmameInstance = instance;

        let romBuffer;
        if (customRomBytes && customRomName) {
            romBuffer = normalizeRomBytes(customRomBytes);
        } else {
            const romName = customRomName || 'bonebstr';
            if (isNode) {
                const fs   = require('node:fs');
                const path = require('node:path');
                const candidates = [
                    path.join(process.cwd(), 'roms', `${romName}.zip`),
                    path.join(__dirname,     'roms', `${romName}.zip`),
                    path.join(process.cwd(),         `${romName}.zip`)
                ];
                const romPath = candidates.find(p => fs.existsSync(p));
                if (!romPath) throw new Error(`Pack introuvable: ${candidates.join(', ')}`);
                romBuffer = fs.readFileSync(romPath).buffer;
            } else {
                const response = await fetch(`roms/${romName}.zip`);
                if (!response.ok) throw new Error(`Pack introuvable (${response.status})`);
                romBuffer = await response.arrayBuffer();
            }
        }

        try { pinmameInstance.FS.lookupPath('/roms', { parents: true }); }
        catch (e) { try { pinmameInstance.FS.mkdir('/roms'); } catch (_) {} }

        const targetRomName = (customRomName || 'bonebstr').replace('.zip', '').toLowerCase();
        pinmameInstance.FS.writeFile(`/roms/${targetRomName}.zip`, new Uint8Array(romBuffer));

        vfdMemoryPointer = pinmameInstance._pinmame_get_dsprom_ptr();
        const strAddr = vfdMemoryPointer + 1000;
        for (let i = 0; i < targetRomName.length; i++) pinmameInstance.HEAPU8[strAddr + i] = targetRomName.charCodeAt(i);
        pinmameInstance.HEAPU8[strAddr + targetRomName.length] = 0;

        postToChannel('status', `@status:state=ready&rom=${encodeURIComponent(targetRomName)}`);

        setTimeout(() => {
            pinmameInstance._pinmame_web_boot();
            lancerSurveillanceEvenementielle();
        }, 100);
    }

    function lancerSurveillanceEvenementielle() {
        function loop() {
            if (pinmameInstance && vfdMemoryPointer) {

                // Raw segment snapshot — fiable, utilisé par le rendu browser (emulDisplay)
                const vfdCounter = readU32(pinmameInstance.HEAPU8, vfdMemoryPointer + 1080);
                if (vfdCounter !== lastVfdCounter) {
                    lastVfdCounter = vfdCounter;
                    let data = '';
                    for (let i = 0; i < 40; i++) {
                        const offset = vfdMemoryPointer + (i * 2);
                        const mask = pinmameInstance.HEAPU8[offset] | (pinmameInstance.HEAPU8[offset + 1] << 8);
                        data += mask.toString(16).padStart(4, '0');
                    }
                    postToChannel('display', `!display:action=raw&data=${data}`);
                }

                // ASCII FIFO depuis api_pop_ascii_event() — pour le hardware série
                // (actif quand api_hook_gottlieb_display_write est câblé dans le driver)
                let ptr;
                while ((ptr = pinmameInstance._api_pop_ascii_event()) !== 0) {
                    const pos    = pinmameInstance.HEAPU8[ptr];
                    const ascii  = pinmameInstance.HEAPU8[ptr + 1];
                    const action = pinmameInstance.HEAPU8[ptr + 2];
                    if (action === 2) {
                        postToChannel('display', '!display:action=clear');
                    } else if (action === 1) {
                        postToChannel('display', `!display:action=move&pos=${pos}`);
                    } else {
                        postToChannel('display', `!display:action=write&pos=${pos}&text=${encodeURIComponent(String.fromCharCode(ascii))}`);
                    }
                }

                // Lamps: emit one line per column when changed
                const lampCounter = readU32(pinmameInstance.HEAPU8, vfdMemoryPointer + 1084);
                if (lampCounter !== lastLampCounter) {
                    lastLampCounter = lampCounter;
                    for (let col = 0; col < 12; col++) {
                        const mask = pinmameInstance.HEAPU8[vfdMemoryPointer + 300 + col];
                        postToChannel('driver', `!lamp:col=${col}&mask=${mask}`);
                    }
                }

                // Solenoids: emit one line per changed bit
                const solCounter = readU32(pinmameInstance.HEAPU8, vfdMemoryPointer + 1088);
                if (solCounter !== lastSolCounter) {
                    lastSolCounter = solCounter;
                    const solState = readU32(pinmameInstance.HEAPU8, vfdMemoryPointer + 320);
                    for (let s = 0; s < 32; s++) {
                        if (((solState >> s) & 1) !== ((lastSolState >> s) & 1)) {
                            postToChannel('driver', `!set:id=${s}&state=${(solState >> s) & 1}`);
                        }
                    }
                    lastSolState = solState;
                }
            }
            setTimeout(loop, 16);
        }
        loop();
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
        if (type === 'INIT_ENGINE') return initialiserMoteur(payload.customRomBytes, payload.customRomName);
    }

    return { sendMessage: handleMessage, handleLine };
}

// ── Browser Worker ──────────────────────────────────────────────────────────

if (isWorker) {
    const emulator = createEmulator();
    self.onmessage = function(event) {
        const msg = event.data;
        if (msg.channel && msg.line) {
            emulator.handleLine(msg.line);
        } else if (msg.type) {
            emulator.sendMessage(msg.type, msg.payload);
        }
    };
    const customRomB64  = (typeof sessionStorage !== 'undefined') ? sessionStorage.getItem('custom_rom_bytes')    : null;
    const customRomName = (typeof sessionStorage !== 'undefined') ? sessionStorage.getItem('custom_rom_filename') : null;
    emulator.sendMessage('INIT_ENGINE', { customRomBytes: customRomB64, customRomName });
}

// ── Node.js ─────────────────────────────────────────────────────────────────

if (isNode) {
    module.exports = { createEmulator };

    if (require.main === module) {
        const fs   = require('node:fs');
        const path = require('node:path');

        const options = {};
        for (const arg of process.argv.slice(2)) {
            if (arg.startsWith('--rom='))        options.rom      = arg.split('=')[1];
            else if (arg.startsWith('--custom-rom=')) options.customRom = arg.split('=')[1];
            else if (arg.startsWith('--audio-out=')) options.audioOut  = arg.split('=')[1];
        }

        let customRomBytes = null, customRomName = options.rom || 'bonebstr';

        if (options.customRom) {
            const romPath = path.resolve(process.cwd(), options.customRom);
            if (!fs.existsSync(romPath)) { console.error(`ROM introuvable : ${romPath}`); process.exit(1); }
            customRomBytes = new Uint8Array(fs.readFileSync(romPath)).buffer;
            customRomName  = path.basename(romPath);
        }

        const audioOutputStream = options.audioOut
            ? fs.createWriteStream(path.resolve(process.cwd(), options.audioOut))
            : null;
        let speaker = null;
        try {
            const Speaker = require('speaker');
            speaker = new Speaker({ channels: 2, bitDepth: 16, sampleRate: 44100, signed: true });
            console.log('🔊 Speaker détecté.');
        } catch {
            if (options.audioOut) console.log(`📝 Audio → ${options.audioOut}`);
            else console.log('⚠️ Pas de module speaker.');
        }

        function floatTo16BitPCM(left, right) {
            const buf = Buffer.alloc(left.length * 4);
            for (let i = 0; i < left.length; i++) {
                buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, left[i]))  * 0x7fff), i * 4);
                buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, right[i])) * 0x7fff), i * 4 + 2);
            }
            return buf;
        }

        const emulator = createEmulator();
        const wsClients = new Set();

        // Serveur WebSocket — accessible via ws://localhost:PORT
        const wsPort = parseInt(options.wsPort) || 8765;
        try {
            const { WebSocketServer } = require('ws');
            const wss = new WebSocketServer({ port: wsPort });
            console.log(`🌐 WebSocket : ws://localhost:${wsPort}`);
            wss.on('connection', (ws) => {
                wsClients.add(ws);
                ws.send(`@master:name=runtime-node&version=1`);
                ws.on('message', (data) => emulator.handleLine(data.toString().trim()));
                ws.on('close', () => wsClients.delete(ws));
                ws.on('error', () => wsClients.delete(ws));
            });
        } catch {
            console.log('⚠️ Module ws absent — installez-le : npm install ws');
        }

        globalThis.onEmulatorMessage = function({ channel, line, left, right }) {
            if (channel === 'audio') {
                const pcm = floatTo16BitPCM(left, right);
                if (speaker) speaker.write(pcm);
                if (audioOutputStream) audioOutputStream.write(pcm);
            } else if (line) {
                if (channel === 'status') console.log(line);
                // Diffuse toutes les lignes aux clients WebSocket connectés
                for (const ws of wsClients) {
                    if (ws.readyState === 1) ws.send(line);
                }
            }
        };

        emulator.sendMessage('INIT_ENGINE', { customRomBytes, customRomName });
    }
}
