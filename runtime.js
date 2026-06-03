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

function createEmulator() {
    let pinmameInstance = null;
    let vfdMemoryPointer = 0;
    let lastVfdCounter  = 0;
    let lastLampCounter    = 0;
    let lastLampBroadcast  = 0;
    let lastVfdBroadcast   = 0;
    let lastSolCounter     = 0;
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
                    const now = Date.now();
                    if (now - lastVfdBroadcast >= 50) {
                        lastVfdBroadcast = now;
                        let data = '';
                        for (let i = 0; i < 40; i++) {
                            const offset = vfdMemoryPointer + (i * 2);
                            const mask = pinmameInstance.HEAPU8[offset] | (pinmameInstance.HEAPU8[offset + 1] << 8);
                            data += mask.toString(16).padStart(4, '0');
                        }
                        postToChannel('display', `!display:action=raw&data=${data}`);
                    }
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

                // Lamps: un seul message avec les 12 colonnes packées en hex
                const lampCounter = readU32(pinmameInstance.HEAPU8, vfdMemoryPointer + 1084);
                if (lampCounter !== lastLampCounter) {
                    lastLampCounter = lampCounter;
                    const now = Date.now();
                    if (now - lastLampBroadcast >= 50) {
                        lastLampBroadcast = now;
                        let lampHex = '';
                        for (let col = 0; col < 12; col++)
                            lampHex += pinmameInstance.HEAPU8[vfdMemoryPointer + 300 + col].toString(16).padStart(2, '0');
                        postToChannel('driver', `!lamp:${lampHex}`);
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
    // INIT_ENGINE est envoyé par le thread principal (seul lui a accès à sessionStorage)
}

// ── Node.js ─────────────────────────────────────────────────────────────────

if (isNode) {
    module.exports = { createEmulator };

    if (require.main === module) {
        (async function main() {
            const fs     = require('node:fs');
            const path   = require('node:path');
            const { spawn } = require('node:child_process');

            const HELP = `
PinMAME Node Runtime
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Usage: node runtime.js [options]

ROM
  --rom=<name>           Nom de la ROM intégrée    (défaut: bonebstr)
  --custom-rom=<path>    Chemin vers un fichier .zip

Réseau
  --port=<n>             Port WebSocket             (défaut: 8765)

Audio (détection automatique dans l'ordre : speaker → play → ffplay → aplay)
  --speaker              Forcer le module npm speaker (erreur si absent)
  --no-speaker           Désactiver toute sortie audio
  --audio-out=<file>     Écrire le PCM 16-bit LE stéréo dans un fichier

Display série
  --display-serial=<dev> Port série pour la carte display (ex: /dev/ttyUSB0)
                         Protocole : D:<40 chars ASCII>\\n  (ligne1=0-19, ligne2=20-39)

Logs
  --verbose, -v          Afficher les événements de l'émulateur
  --help,    -h          Afficher cette aide
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;

            const options = {};
            for (const arg of process.argv.slice(2)) {
                if      (arg === '--help'    || arg === '-h') { process.stdout.write(HELP); process.exit(0); }
                else if (arg === '--verbose' || arg === '-v') options.verbose   = true;
                else if (arg === '--speaker')                  options.speaker   = true;
                else if (arg === '--no-speaker')               options.noSpeaker = true;
                else if (arg.startsWith('--rom='))             options.rom       = arg.split('=')[1];
                else if (arg.startsWith('--custom-rom='))      options.customRom = arg.split('=')[1];
                else if (arg.startsWith('--port='))            options.port      = arg.split('=')[1];
                else if (arg.startsWith('--audio-out='))        options.audioOut      = arg.split('=')[1];
                else if (arg.startsWith('--display-serial='))  options.displaySerial = arg.split('=').slice(1).join('=');
            }

            const log  = (...a) => { if (options.verbose) console.log(...a); };
            const info = (...a) => console.log(...a);

            // ── ROM ──────────────────────────────────────────────────────────
            let customRomBytes = null, customRomName = options.rom || 'bonebstr';
            if (options.customRom) {
                const romPath = path.resolve(process.cwd(), options.customRom);
                if (!fs.existsSync(romPath)) { console.error(`ROM introuvable : ${romPath}`); process.exit(1); }
                customRomBytes = new Uint8Array(fs.readFileSync(romPath)).buffer;
                customRomName  = path.basename(romPath);
            }

            // ── AUDIO ─────────────────────────────────────────────────────────
            function floatTo16BitPCM(left, right) {
                const buf = Buffer.alloc(left.length * 4);
                for (let i = 0; i < left.length; i++) {
                    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, left[i]))  * 0x7fff), i * 4);
                    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, right[i])) * 0x7fff), i * 4 + 2);
                }
                return buf;
            }

            // Tente de spawner un process audio ; retourne { write } ou null
            function trySpawnSink(cmd, args) {
                return new Promise(resolve => {
                    let proc, alive = true;
                    try { proc = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] }); }
                    catch { return resolve(null); }
                    proc.on('error', () => { alive = false; resolve(null); });
                    setTimeout(() => resolve(alive ? { write: buf => { try { proc.stdin.write(buf); } catch {} } } : null), 80);
                });
            }

            let audioSink = null, audioLabel = 'désactivé  →  npm install speaker';

            if (options.audioOut) {
                const stream = fs.createWriteStream(path.resolve(process.cwd(), options.audioOut));
                audioSink  = { write: buf => stream.write(buf) };
                audioLabel = `fichier → ${options.audioOut}`;
            } else if (!options.noSpeaker) {
                // 1. Module npm speaker
                try {
                    const Speaker = require('speaker');
                    let spk = null;
                    // Queue max ~100ms (4 chunks de ~22ms chacun)
                    const queue = [], QUEUE_MAX = 16;
                    let draining = false;

                    const flush = () => {
                        while (queue.length > 0 && spk) {
                            const ok = spk.write(queue.shift());
                            if (!ok) { draining = true; spk.once('drain', () => { draining = false; flush(); }); return; }
                        }
                    };

                    const makeSpk = () => {
                        spk = new Speaker({ channels: 2, bitDepth: 16, sampleRate: 44100, signed: true });
                        spk.on('error', () => { spk = null; setTimeout(makeSpk, 200); });
                        spk.on('close', () => { spk = null; setTimeout(makeSpk, 200); });
                    };
                    makeSpk();

                    audioSink  = { write: buf => {
                        // Jette les vieux buffers si on accumule trop (rythme émulateur > rythme réel)
                        while (queue.length >= QUEUE_MAX) queue.shift();
                        queue.push(buf);
                        if (!draining) flush();
                    }};
                    audioLabel = 'speaker (npm)';
                } catch (e) { info(`  Audio    : speaker non chargé — ${e.message}`); }

                // 2. Fallbacks système
                if (!audioSink && process.platform === 'darwin') {
                    // SoX play (homebrew: brew install sox)
                    audioSink = await trySpawnSink('play', ['-r','44100','-b','16','-c','2','-e','signed-integer','-t','raw','-']);
                    if (audioSink) audioLabel = 'play (SoX)';
                }
                if (!audioSink && process.platform === 'linux') {
                    // aplay — ALSA intégré sur la plupart des Linux/Pi
                    audioSink = await trySpawnSink('aplay', ['-f','S16_LE','-r','44100','-c','2']);
                    if (audioSink) audioLabel = 'aplay (ALSA)';
                }

                if (!audioSink && options.speaker) {
                    console.error('⚠️  Aucune sortie audio trouvée — npm install speaker'); process.exit(1);
                }
            } else {
                audioLabel = 'désactivé';
            }

            const wsPort = parseInt(options.port) || 8765;

            // ── DISPLAY SÉRIE ─────────────────────────────────────────────────
            // Table ascii2gottlieb → inverse : mask 16 bits → char ASCII
            const _a2g = [
                0x0000,0x0000,0x0000,0x0000,0x0000,0x0000,0x0000,0x0000,
                0x0000,0x0000,0x0000,0x0000,0x0000,0x0000,0x0000,0x0000,
                0x0000,0x0000,0x0000,0x0000,0x0000,0x0000,0x0000,0x0000,
                0x0000,0x0000,0x0000,0x0000,0x0000,0x0000,0x0000,0x0000,
                0x0000,0x000c,0x0202,0x12bc,0x298d,0x1248,0x2af5,0x0400,
                0x2400,0x0900,0x3f3f,0x0b0b,0x0000,0x0909,0x0000,0x2100,
                0x003f,0x0006,0x09db,0x09cf,0x0966,0x09ed,0x09fd,0x0007,
                0x09ff,0x09ef,0x0000,0x0000,0x2400,0x0909,0x0900,0x2203,
                0x003f,0x09f7,0x2a0f,0x0039,0x220f,0x0979,0x0971,0x01bd,
                0x09f6,0x2209,0x001e,0x2470,0x0038,0x0536,0x1136,0x003f,
                0x09f3,0x103f,0x19f3,0x09ed,0x2201,0x003e,0x4430,0x5036,
                0x5500,0x2500,0x4409,0x0039,0x4400,0x000f,0x0000,0x0008,
            ];
            const _g2a = new Map();
            for (let i = 0x20; i < _a2g.length; i++) {
                if (_a2g[i] && !_g2a.has(_a2g[i])) _g2a.set(_a2g[i], String.fromCharCode(i));
            }
            function decodeDisplay(hexData) {
                let s = '';
                for (let i = 0; i < 40; i++) {
                    const mask = parseInt(hexData.slice(i * 4, i * 4 + 4), 16) || 0;
                    s += mask === 0 ? ' ' : (_g2a.get(mask) || '?');
                }
                return s;
            }

            let displaySerial = null, lastDisplayStr = null;
            if (options.displaySerial) {
                if (options.displaySerial === '-') {
                    displaySerial = process.stdout;
                } else {
                    try {
                        displaySerial = fs.createWriteStream(options.displaySerial, { flags: 'w' });
                        displaySerial.on('error', e => info(`  Display série erreur: ${e.message}`));
                    } catch (e) { info(`  Display série: ERREUR — ${e.message}`); }
                }
            }

            info('PinMAME Node Runtime');
            info(`  ROM      : ${customRomName}${customRomBytes ? ' (custom)' : ''}`);
            info(`  WS port  : ${wsPort}`);
            info(`  Audio    : ${audioLabel}`);
            if (options.displaySerial) info(`  Display  : ${options.displaySerial}`);
            info(`  Verbosité: ${options.verbose ? 'activée' : 'désactivée  (--verbose pour les événements)'}`);

            const emulator  = createEmulator();
            const wsClients = new Set();
            let lastStatusLine = null;

            try {
                const { WebSocketServer } = require('ws');
                const wss = new WebSocketServer({ port: wsPort });
                info(`  WebSocket: ws://localhost:${wsPort}`);
                wss.on('connection', (ws) => {
                    wsClients.add(ws);
                    ws.connectors = [];
                    ws.send(`@master:name=runtime-node&version=1`);
                    ws.on('message', (data) => {
                        const line = data.toString().trim();
                        if (line.startsWith('@connect:')) {
                            const p = new URLSearchParams(line.slice(9));
                            if (p.get('input')   === '1') { ws.connectors.push('INPUT');   info('  [INPUT]   connecté'); }
                            if (p.get('display') === '1') { ws.connectors.push('DISPLAY'); info('  [DISPLAY] connecté'); }
                            if (p.get('driver')  === '1') { ws.connectors.push('DRIVER');  info('  [DRIVER]  connecté'); }
                            // Envoyer la liste des ROMs disponibles dans roms/
                            const romsDir = [
                                path.join(process.cwd(), 'roms'),
                                path.join(__dirname, 'roms')
                            ].find(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
                            if (romsDir) {
                                const roms = fs.readdirSync(romsDir)
                                    .filter(f => f.endsWith('.zip'))
                                    .map(f => f.slice(0, -4))
                                    .sort();
                                if (roms.length) ws.send(`@roms:list=${roms.map(encodeURIComponent).join(',')}`);
                            }
                            // Renvoyer le statut actuel si l'émulateur est déjà prêt
                            if (lastStatusLine) ws.send(lastStatusLine);
                            return;
                        }
                        if (line.startsWith('@rom:')) {
                            const p = new URLSearchParams(line.slice(5));
                            const name = decodeURIComponent(p.get('name') || 'bonebstr').replace(/\.zip$/i, '');
                            const data = p.get('data') || null;
                            info(`  ROM      : redémarrage → ${name}`);
                            if (data) {
                                const romPath = path.join(process.cwd(), 'roms', `${name}.zip`);
                                fs.writeFileSync(romPath, Buffer.from(data, 'base64'));
                                info(`  ROM sauvegardée → ${romPath}`);
                            }
                            const newArgs = process.argv.slice(2)
                                .filter(a => !a.startsWith('--rom=') && !a.startsWith('--custom-rom='));
                            newArgs.push(`--rom=${name}`);
                            for (const c of wsClients) try { c.terminate(); } catch {}
                            wss.close(() => {
                                spawn(process.execPath, [__filename, ...newArgs], { detached: true, stdio: 'inherit' }).unref();
                                process.exit(0);
                            });
                            setTimeout(() => process.exit(0), 1000);
                            return;
                        }
                        emulator.handleLine(line);
                    });
                    const disconnect = () => {
                        if (!wsClients.has(ws)) return;
                        wsClients.delete(ws);
                        for (const c of ws.connectors) info(`  [${c.padEnd(7)}] déconnecté`);
                    };
                    ws.on('close', disconnect);
                    ws.on('error', disconnect);
                });
            } catch {
                console.error('⚠️  Module ws absent — npm install ws');
            }

            // Pacing : simule le feedback @audio:distance du navigateur
            // Sans ça l'émulateur tourne en roue libre (trop rapide, son haché)
            let samplesProduced = 0;
            const paceStart = Date.now();
            const SAMPLE_RATE = 44100;

            setInterval(() => {
                const samplesConsumed = Math.floor((Date.now() - paceStart) / 1000 * SAMPLE_RATE);
                const distance = Math.max(0, samplesProduced - samplesConsumed);
                emulator.handleLine(`@audio:distance=${distance}`);
            }, 32);

            globalThis.onEmulatorMessage = function({ channel, line, left, right }) {
                if (channel === 'audio') {
                    samplesProduced += left.length;
                    if (audioSink) audioSink.write(floatTo16BitPCM(left, right));
                } else if (line) {
                    if (line.startsWith('@status:state=ready')) lastStatusLine = line;
                    if (displaySerial && line.startsWith('!display:action=raw&data=')) {
                        const str = decodeDisplay(line.slice(25));
                        if (str !== lastDisplayStr) {
                            lastDisplayStr = str;
                            displaySerial.write(`D:${str}\n`);
                        }
                    }
                    log(line);
                    for (const ws of wsClients) {
                        if (ws.readyState === 1) ws.send(line);
                    }
                }
            };

            emulator.sendMessage('INIT_ENGINE', { customRomBytes, customRomName });
        })().catch(e => { console.error(e); process.exit(1); });
    }
}
