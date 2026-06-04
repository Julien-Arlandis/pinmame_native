// runtime.js
// Shared emulator core — browser Worker and Node.js
// Protocol: { channel, line } for all I/O except audio ({ channel:'audio', left, right })

// Supprime les logs NSLog/CoreBluetooth (bleno) sur macOS avant tout require natif
// Utiliser --ble-log pour les réactiver (diagnostic bleno)
if (typeof process !== 'undefined' && process.platform === 'darwin') {
    if (!process.argv.includes('--ble-log')) process.env.OS_ACTIVITY_MODE = 'disable';
}

const isWorker = typeof importScripts === 'function' && typeof self !== 'undefined' && typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope;
const isNode = typeof process !== 'undefined' && process.versions?.node && !(typeof window !== 'undefined');

let createPinMAMEFactory = null;

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
    let lastSolState = 0;

    const Module = {
        ...(_bundled && { wasmBinary: __PINMAME_WASM_BINARY__ }),
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

    // Intégrateur DC-offset pour le DAC push (persistant entre frames)
    // Réplique la logique de dac.c mais exécuté en JS avec bon timing
    const dacInteg = [0.0, 0.0];
    const dacPrev  = [-1, -1];   // -1 = non initialisé (warm-up premier appel)

    globalThis.pushWasmAudio = function(ptr, count) {
        if (!pinmameInstance) return;
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

            // Passer chaque écriture DAC par l'intégrateur DC-offset
            const processed = new Float32Array(n);
            for (let i = 0; i < n; i++) {
                const raw = pinmameInstance.HEAP32[dacPtr32 + i];   // 0..65025
                if (dacPrev[chip] < 0) {
                    // Warm-up : initialiser sans spike
                    dacPrev[chip]  = raw;
                    dacInteg[chip] = 0.0;
                    processed[i]   = 0.0;
                    continue;
                }
                dacInteg[chip] = dacInteg[chip] * 0.995 + (raw - dacPrev[chip]);
                dacPrev[chip]  = raw;
                // Gain 50% → mixing_level du DACinterface, normalisé [-1,+1]
                processed[i] = Math.max(-0.5, Math.min(0.5, dacInteg[chip] / 65025.0));
            }

            // Redistribuer les N valeurs sur frames samples (interpolation linéaire)
            const scale = (n - 1) / (frames - 1);
            for (let s = 0; s < frames; s++) {
                const pos  = s * scale;
                const i0   = pos | 0;
                const i1   = i0 + 1 < n ? i0 + 1 : i0;
                const frac = pos - i0;
                const dac  = processed[i0] * (1 - frac) + processed[i1] * frac;
                left[s]    = Math.max(-1, Math.min(1, left[s]  + dac));
                right[s]   = Math.max(-1, Math.min(1, right[s] + dac));
            }

            pinmameInstance._api_reset_dac_buffer(chip);
        }

        postAudio(left, right);
    };

    globalThis.pushWasmDisplay = function(ptr) {
        if (!pinmameInstance) return;
        let data = '';
        for (let i = 0; i < 40; i++) {
            const lo = pinmameInstance.HEAPU8[ptr + i * 2];
            const hi = pinmameInstance.HEAPU8[ptr + i * 2 + 1];
            data += (lo | (hi << 8)).toString(16).padStart(4, '0');
        }
        postToChannel('display', `!display:action=raw&data=${data}`);
    };

    globalThis.pushWasmLamps = function(ptr) {
        if (!pinmameInstance) return;
        let lampHex = '';
        for (let col = 0; col < 12; col++)
            lampHex += pinmameInstance.HEAPU8[ptr + col].toString(16).padStart(2, '0');
        postToChannel('driver', `!lamp:${lampHex}`);
    };

    globalThis.pushWasmSolens = function(solState) {
        for (let s = 0; s < 32; s++) {
            if (((solState >> s) & 1) !== ((lastSolState >> s) & 1))
                postToChannel('driver', `!set:id=${s}&state=${(solState >> s) & 1}`);
        }
        lastSolState = solState;
    };

    globalThis.postWasmLog = function(cmdId) {
        postToChannel('status', `@audio:cmd=0x${cmdId.toString(16).toUpperCase()}`);
    };

    async function initialiserMoteur(customRomBytes, customRomName, baseUrl) {
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
                const romUrl = baseUrl ? new URL(`roms/${romName}.zip`, baseUrl).href : `roms/${romName}.zip`;
                const response = await fetch(romUrl);
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
  --no-ble               Désactiver le périphérique BLE
  --ble-log              Réactiver les logs CoreBluetooth natifs (macOS)

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
                else if (arg === '--no-ble')                    options.noBle     = true;
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
            const _a2s = {
                ' ':0x0000,'!':0x0006,'"':0x0202,'#':0x0A8D,'$':0x086D,
                '%':0x1CE8,'&':0x2AF5,'\'':0x0200,'(':0x0039,')':0x000F,
                '*':0x7F40,'+':0x2A40,',':0x4000,'-':0x0840,'.':0x0080,
                '/':0x4400,':':0x2200,';':0x4200,'<':0x1400,'=':0x0849,
                '>':0x0500,'?':0x2203,'@':0x2A3F,'[':0x0039,'\\':0x1100,
                ']':0x000F,'^':0x0500,'_':0x0008,'`':0x0100,'{':0x2240,
                '|':0x2200,'}':0x0A09,'~':0x0840,
                '0':0x003F,'1':0x0006,'2':0x085B,'3':0x084F,'4':0x0866,
                '5':0x086D,'6':0x087D,'7':0x0007,'8':0x087F,'9':0x086F,
                'A':0x0877,'B':0x2A2F,'C':0x0039,'D':0x220F,'E':0x0079,
                'F':0x0071,'G':0x083D,'H':0x0876,'I':0x2209,'J':0x001E,
                'K':0x1470,'L':0x0038,'M':0x0536,'N':0x1136,'O':0x003F,
                'P':0x0873,'Q':0x103F,'R':0x1873,'S':0x086D,'T':0x2201,
                'U':0x003E,'V':0x4430,'W':0x5036,'X':0x5500,'Y':0x2500,
                'Z':0x4409,
            };
            // Inverse : segments → ASCII (minuscules aliasées vers majuscules)
            const _g2a = new Map();
            for (const [ch, mask] of Object.entries(_a2s)) {
                if (!_g2a.has(mask)) _g2a.set(mask, ch);
            }
            function decodeDisplay(hexData) {
                let s = '';
                for (let i = 0; i < 40; i++) {
                    const mask = parseInt(hexData.slice(i * 4, i * 4 + 4), 16) || 0;
                    if (mask === 0) { s += ' '; continue; }
                    const ch = _g2a.get(mask);
                    s += ch !== undefined ? ch : `[${mask.toString(16)}]`;
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

            // ── BLE PERIPHERAL ───────────────────────────────────────────────
            // UUIDs custom PinMAME (128-bit)
            const BLE_SVC  = 'ab120001b5a3f393e0a9e50e24dcca9e';
            const BLE_OUT  = 'ab120002b5a3f393e0a9e50e24dcca9e'; // NOTIFY  → browser
            const BLE_IN   = 'ab120003b5a3f393e0a9e50e24dcca9e'; // WRITE   ← browser

            let bleNotify   = null;  // updateValueCallback quand un client est subscribé
            let bleMtu      = 20;    // MTU négocié (mis à jour dans onSubscribe)
            let bleConnected = false;

            function bleSend(line) {
                if (!bleNotify) return;
                const buf = Buffer.from(line + '\n');
                // Fragmentation : 0x00=suite, 0x01=dernier fragment
                for (let off = 0; off < buf.length; off += bleMtu - 1) {
                    const chunk  = buf.slice(off, off + bleMtu - 1);
                    const isLast = off + bleMtu - 1 >= buf.length;
                    const packet = Buffer.alloc(1 + chunk.length);
                    packet[0] = isLast ? 0x01 : 0x00;
                    chunk.copy(packet, 1);
                    bleNotify(packet);
                }
            }

            if (!options.noBle) {
                try {
                    const bleno = require('@abandonware/bleno');

                    const outChar = new bleno.Characteristic({
                        uuid: BLE_OUT,
                        properties: ['notify'],
                        onSubscribe(maxValueSize, cb) {
                            bleMtu      = maxValueSize;
                            bleNotify   = cb;
                            bleConnected = true;
                            info('  [BLE] client connecté');
                            // Envoyer statut courant immédiatement
                            if (lastStatusLine) bleSend(lastStatusLine);
                        },
                        onUnsubscribe() {
                            bleNotify    = null;
                            bleConnected = false;
                            info('  [BLE] client déconnecté');
                        }
                    });

                    const inChar = new bleno.Characteristic({
                        uuid: BLE_IN,
                        properties: ['write', 'writeWithoutResponse'],
                        onWriteRequest(data, offset, withoutResponse, cb) {
                            const line = data.toString().trim();
                            if (!handleClientLine(line, bleSend))
                                emulator.handleLine(line);
                            cb(bleno.Characteristic.RESULT_SUCCESS);
                        }
                    });

                    const service = new bleno.PrimaryService({ uuid: BLE_SVC, characteristics: [outChar, inChar] });

                    bleno.on('stateChange', state => {
                        if (state === 'poweredOn') {
                            bleno.startAdvertising('PinMAME', [BLE_SVC]);
                        } else {
                            bleno.stopAdvertising();
                        }
                    });

                    bleno.on('advertisingStart', err => {
                        if (!err) {
                            bleno.setServices([service]);
                            info('  BLE      : advertising PinMAME');
                        }
                    });
                } catch {
                    info('⚠️  BLE indisponible — npm install @abandonware/bleno  (ou --no-ble)');
                }
            }

            const emulator  = createEmulator();
            const wsClients = new Set();
            let lastStatusLine  = null;
            let lastDisplayLine = null;
            let lastLampLine    = null;

            // Logique commune WS + BLE : retourne true si la ligne a été traitée
            function handleClientLine(line, replyCb) {
                if (line.startsWith('@connect:')) {
                    const p = new URLSearchParams(line.slice(9));
                    if (p.get('input')   === '1') info('  [INPUT]   connecté');
                    if (p.get('display') === '1') info('  [DISPLAY] connecté');
                    if (p.get('driver')  === '1') info('  [DRIVER]  connecté');
                    const romsDir = [
                        path.join(process.cwd(), 'roms'),
                        path.join(__dirname, 'roms')
                    ].find(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
                    if (romsDir) {
                        const roms = fs.readdirSync(romsDir)
                            .filter(f => f.endsWith('.zip'))
                            .map(f => f.slice(0, -4))
                            .sort();
                        if (roms.length) replyCb(`@roms:list=${roms.map(encodeURIComponent).join(',')}`);
                    }
                    if (lastDisplayLine) replyCb(lastDisplayLine);
                    if (lastLampLine)    replyCb(lastLampLine);
                    if (lastStatusLine)  replyCb(lastStatusLine);
                    return true;
                }
                if (line === '@reboot:') {
                    const newArgs = process.argv.slice(2);
                    for (const c of wsClients) try { c.terminate(); } catch {}
                    if (wss) wss.close(() => {
                        spawn(process.execPath, [__filename, ...newArgs], { detached: true, stdio: 'inherit' }).unref();
                        process.exit(0);
                    });
                    setTimeout(() => process.exit(0), 1000);
                    return true;
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
                    if (wss) wss.close(() => {
                        spawn(process.execPath, [__filename, ...newArgs], { detached: true, stdio: 'inherit' }).unref();
                        process.exit(0);
                    });
                    setTimeout(() => process.exit(0), 1000);
                    return true;
                }
                return false;
            }

            let wss = null;
            try {
                const { WebSocketServer } = require('ws');
                wss = new WebSocketServer({ port: wsPort });
                info(`  WebSocket: ws://localhost:${wsPort}`);
                wss.on('connection', (ws) => {
                    wsClients.add(ws);
                    ws.send(`@master:name=runtime-node&version=1`);
                    ws.on('message', (data) => {
                        const line = data.toString().trim();
                        if (!handleClientLine(line, l => ws.send(l)))
                            emulator.handleLine(line);
                    });
                    const disconnect = () => {
                        if (!wsClients.has(ws)) return;
                        wsClients.delete(ws);
                        info('  [WS]      déconnecté');
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
                    if (line.startsWith('@status:state=ready'))        lastStatusLine  = line;
                    if (line.startsWith('!display:action=raw&data='))  lastDisplayLine = line;
                    if (line.startsWith('!lamp:'))                     lastLampLine    = line;
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
                    if (bleConnected) bleSend(line);
                }
            };

            emulator.sendMessage('INIT_ENGINE', { customRomBytes, customRomName });
        })().catch(e => { console.error(e); process.exit(1); });
    }
}
