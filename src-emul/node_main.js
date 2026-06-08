// node_main.js — CLI Node.js (chargé uniquement dans le bundle tilt)
// createEmulator et isNode sont fournis par runtime.js dans le même scope IIFE.

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
                try {
                    const Speaker = require('speaker');
                    let spk = null;
                    const queue = [];
                    let draining = false;
                    let queuedSamples = 0;

                    const flush = () => {
                        while (queue.length > 0 && spk) {
                            const buf = queue[0];
                            const ok = spk.write(buf);
                            if (!ok) { draining = true; spk.once('drain', () => { draining = false; flush(); }); return; }
                            queue.shift();
                            queuedSamples -= buf.length / 4;
                        }
                    };

                    const makeSpk = () => {
                        spk = new Speaker({ channels: 2, bitDepth: 16, sampleRate: 44100, signed: true });
                        spk.on('error', () => { spk = null; setTimeout(makeSpk, 200); });
                        spk.on('close', () => { spk = null; setTimeout(makeSpk, 200); });
                    };
                    makeSpk();

                    audioSink = {
                        write(buf) {
                            queue.push(buf);
                            queuedSamples += buf.length / 4;
                            if (!draining) flush();
                        },
                        get queued() { return queuedSamples; }
                    };
                    audioLabel = 'speaker (npm)';
                } catch (e) { info(`  Audio    : speaker non chargé — ${e.message}`); }

                if (!audioSink && process.platform === 'darwin') {
                    audioSink = await trySpawnSink('play', ['-r','44100','-b','16','-c','2','-e','signed-integer','-t','raw','-']);
                    if (audioSink) audioLabel = 'play (SoX)';
                }
                if (!audioSink && process.platform === 'linux') {
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
            const BLE_SVC  = 'ab120001b5a3f393e0a9e50e24dcca9e';
            const BLE_OUT  = 'ab120002b5a3f393e0a9e50e24dcca9e';
            const BLE_IN   = 'ab120003b5a3f393e0a9e50e24dcca9e';

            let bleNotify   = null;
            let bleMtu      = 20;
            let bleConnected = false;

            function bleSend(line) {
                if (!bleNotify) return;
                const buf = Buffer.from(line + '\n');
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
                            if (lastDisplayLine) bleSend(lastDisplayLine);
                            if (lastLampLine)    bleSend(lastLampLine);
                            if (lastStatusLine)  bleSend(lastStatusLine);
                        },
                        onUnsubscribe() {
                            bleNotify    = null;
                            bleConnected = false;
                            info('  [BLE] client déconnecté');
                        }
                    });

                    let bleInBuf = '';
                    const inChar = new bleno.Characteristic({
                        uuid: BLE_IN,
                        properties: ['write', 'writeWithoutResponse'],
                        onWriteRequest(data, offset, withoutResponse, cb) {
                            const isLast = data[0] === 0x01;
                            bleInBuf += data.slice(1).toString('utf8');
                            if (isLast) {
                                const line = bleInBuf.trim();
                                bleInBuf = '';
                                if (line && !handleClientLine(line, bleSend))
                                    emulator.handleLine(line);
                            }
                            cb(bleno.Characteristic.RESULT_SUCCESS);
                        }
                    });

                    const service = new bleno.PrimaryService({ uuid: BLE_SVC, characteristics: [outChar, inChar] });

                    bleno.on('stateChange', state => {
                        if (state === 'poweredOn') bleno.startAdvertising('PinMAME', [BLE_SVC]);
                        else bleno.stopAdvertising();
                    });

                    bleno.on('advertisingStart', err => {
                        if (!err) { bleno.setServices([service]); info('  BLE      : advertising PinMAME'); }
                    });
                } catch {
                    info('⚠️  BLE indisponible — npm install @abandonware/bleno  (ou --no-ble)');
                }
            }

            // ── EMULATEUR ────────────────────────────────────────────────────

            const wsClients = new Set();
            let lastStatusLine  = null;
            let lastDisplayLine = null;
            let lastLampLine    = null;
            let currentRomArgs  = process.argv.slice(2);

            function makeEmulator() {
                return createEmulator({
                    sendLine(channel, line) {
                        if (line.startsWith('@status:state=ready'))       lastStatusLine  = line;
                        if (line.startsWith('!display:action=raw&data=')) lastDisplayLine = line;
                        if (line.startsWith('!lamp:'))                    lastLampLine    = line;
                        if (displaySerial && line.startsWith('!display:action=text&data=')) {
                            const str = decodeURIComponent(line.slice(26));
                            if (str !== lastDisplayStr) {
                                lastDisplayStr = str;
                                displaySerial.write(`D:${str}\n`);
                            }
                        }
                        log(line);
                        for (const ws of wsClients) if (ws.readyState === 1) ws.send(line);
                        if (bleConnected) bleSend(line);
                    },
                    sendAudio(left, right) {
                        if (audioSink) audioSink.write(floatTo16BitPCM(left, right));
                    },
                    loadRom(romName) {
                        const candidates = [
                            path.join(process.cwd(), 'roms', `${romName}.zip`),
                            path.join(__dirname,     'roms', `${romName}.zip`),
                            path.join(process.cwd(),         `${romName}.zip`)
                        ];
                        const romPath = candidates.find(p => fs.existsSync(p));
                        if (!romPath) throw new Error(`Pack introuvable: ${candidates.join(', ')}`);
                        return Promise.resolve(fs.readFileSync(romPath).buffer);
                    }
                });
            }

            let emulator = makeEmulator();

            // Pacing corrigé : envoie la profondeur réelle du queue Speaker toutes les 16ms.
            // Plus fréquent que le pacing wall-clock de runtime.js (32ms) → prend le dessus.
            // Sans ça, runtime.js estime la consommation par horloge murale et ignore le backpressure
            // du Speaker, ce qui provoque des drops silencieux et du crackling.
            if (audioSink && 'queued' in audioSink) {
                setInterval(() => emulator.handleLine(`@audio:distance=${audioSink.queued}`), 16);
            }

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
                    info('  [REBOOT]  redémarrage émulateur en place');
                    lastStatusLine = lastDisplayLine = lastLampLine = null;
                    emulator = makeEmulator();
                    const romArg = currentRomArgs.find(a => a.startsWith('--rom='));
                    const romName = romArg ? romArg.slice(6) : null;
                    emulator.sendMessage('INIT_ENGINE', { customRomBytes: null, customRomName: romName });
                    const notif = '@status:state=loading';
                    for (const ws of wsClients) if (ws.readyState === 1) ws.send(notif);
                    if (bleConnected) bleSend(notif);
                    return true;
                }
                if (line.startsWith('@rom:')) {
                    const p = new URLSearchParams(line.slice(5));
                    const name = decodeURIComponent(p.get('name') || 'bonebstr').replace(/\.zip$/i, '');
                    const data = p.get('data') || null;
                    info(`  ROM      : changement → ${name}`);
                    if (data) {
                        const romPath = path.join(process.cwd(), 'roms', `${name}.zip`);
                        fs.writeFileSync(romPath, Buffer.from(data, 'base64'));
                        info(`  ROM sauvegardée → ${romPath}`);
                    }
                    currentRomArgs = currentRomArgs.filter(a => !a.startsWith('--rom=') && !a.startsWith('--custom-rom='));
                    currentRomArgs.push(`--rom=${name}`);
                    lastStatusLine = lastDisplayLine = lastLampLine = null;
                    emulator = makeEmulator();
                    emulator.sendMessage('INIT_ENGINE', { customRomBytes: null, customRomName: name });
                    const notif = '@status:state=loading';
                    for (const ws of wsClients) if (ws.readyState === 1) ws.send(notif);
                    if (bleConnected) bleSend(notif);
                    return true;
                }
                return false;
            }

            // ── WEBSOCKET ────────────────────────────────────────────────────
            try {
                const { WebSocketServer } = require('ws');
                const wss = new WebSocketServer({ port: wsPort });
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

            emulator.sendMessage('INIT_ENGINE', { customRomBytes, customRomName });
        })().catch(e => { console.error(e); process.exit(1); });
    }
}
