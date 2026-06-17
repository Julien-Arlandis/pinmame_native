'use strict';

// Filtre les logs CoreBluetooth en se respawnant avec stderr pipé
if (!process.env._TILT_RUNNING && !process.argv.includes('--ble-log')) {
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, [__filename, ...process.argv.slice(2)], {
        env: { ...process.env, _TILT_RUNNING: '1' },
        stdio: ['inherit', 'inherit', 'pipe']
    });
    const BLE_RE = /BlenoMac|CoreBluetooth|napiToCB|napiArray|peripheralManager|CBMutable/;
    let buf = '';
    child.stderr.on('data', chunk => {
        buf += chunk.toString();
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i + 1); buf = buf.slice(i + 1);
            if (!BLE_RE.test(line)) process.stderr.write(line);
        }
    });
    child.stderr.on('end', () => { if (buf) process.stderr.write(buf); });
    child.on('exit', (code, sig) => { process.exitCode = code ?? (sig ? 1 : 0); });
    return;
}

const { createEmulator }            = require('flip-g80');
const { createWsServerTransport }   = require('./transport/ws-server');
const { createBlePeripheralTransport } = require('./transport/ble-peripheral');

(async function main() {
    const fs     = require('node:fs');
    const path   = require('node:path');
    const { spawn } = require('node:child_process');

    const HELP = `
PinMAME Node Runtime
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Usage: node node/main.js  [options]

ROM
  --rom=<name>           Nom de la ROM intégrée    (défaut: bonebstr)
  --custom-rom=<path>    Chemin vers un fichier .zip

Réseau
  --port=<n>             Port WebSocket             (défaut: 8765)
  --no-ble               Désactiver le périphérique BLE
  --ble-log              Réactiver les logs CoreBluetooth natifs (macOS)

Audio (détection automatique : play/SoX sur macOS, aplay/ALSA sur Linux)
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
        else if (arg === '--verbose' || arg === '-v') options.verbose      = true;
        else if (arg === '--no-speaker')               options.noSpeaker   = true;
        else if (arg === '--no-ble')                   options.noBle       = true;
        else if (arg.startsWith('--rom='))             options.rom         = arg.split('=')[1];
        else if (arg.startsWith('--custom-rom='))      options.customRom   = arg.split('=')[1];
        else if (arg.startsWith('--port='))            options.port        = arg.split('=')[1];
        else if (arg.startsWith('--audio-out='))       options.audioOut    = arg.split('=')[1];
        else if (arg.startsWith('--display-serial='))  options.displaySerial = arg.split('=').slice(1).join('=');
    }

    const log  = (...a) => { if (options.verbose) console.log(...a); };
    const info = (...a) => console.log(...a);

    // ── ROM ──────────────────────────────────────────────────────────────────
    let customRomBytes = null, customRomName = options.rom || 'bonebstr';
    if (options.customRom) {
        const romPath = path.resolve(process.cwd(), options.customRom);
        if (!fs.existsSync(romPath)) { console.error(`ROM introuvable : ${romPath}`); process.exit(1); }
        customRomBytes = new Uint8Array(fs.readFileSync(romPath)).buffer;
        customRomName  = path.basename(romPath);
    }

    // ── AUDIO ─────────────────────────────────────────────────────────────────
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

    let audioSink = null, audioLabel = 'désactivé';

    if (options.audioOut) {
        const stream = fs.createWriteStream(path.resolve(process.cwd(), options.audioOut));
        audioSink  = { write: buf => stream.write(buf) };
        audioLabel = `fichier → ${options.audioOut}`;
    } else if (!options.noSpeaker) {
        if (process.platform === 'darwin') {
            audioSink = await trySpawnSink('play', ['-r','44100','-b','16','-c','2','-e','signed-integer','-t','raw','-']);
            if (audioSink) audioLabel = 'play (SoX)';
        }
        if (!audioSink && process.platform === 'linux') {
            audioSink = await trySpawnSink('aplay', ['-f','S16_LE','-r','44100','-c','2']);
            if (audioSink) audioLabel = 'aplay (ALSA)';
        }
        if (!audioSink) audioLabel = 'désactivé  (SoX introuvable)';
    }

    const wsPort = parseInt(options.port) || 8765;

    // ── DISPLAY SÉRIE ─────────────────────────────────────────────────────────
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

    // ── TRANSPORTS ────────────────────────────────────────────────────────────
    const wsTr  = createWsServerTransport(wsPort, info);
    const bleTr = options.noBle ? null : createBlePeripheralTransport(info);

    function broadcast(line) {
        wsTr.send(line);
        bleTr?.send(line);
    }

    // ── EMULATEUR ─────────────────────────────────────────────────────────────
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
                    if (str !== lastDisplayStr) { lastDisplayStr = str; displaySerial.write(`D:${str}\n`); }
                }
                log(line);
                broadcast(line);
            },
            sendAudio(left, right) {
                if (audioSink) audioSink.write(floatTo16BitPCM(left, right));
            },
            loadRom(romName) {
                const candidates = [
                    path.join(__dirname, 'roms', `${romName}.zip`),
                    path.join(process.cwd(), 'roms', `${romName}.zip`),
                    path.join(process.cwd(), `${romName}.zip`)
                ];
                const romPath = candidates.find(p => fs.existsSync(p));
                if (!romPath) throw new Error(`Pack introuvable: ${candidates.join(', ')}`);
                return Promise.resolve(fs.readFileSync(romPath).buffer);
            }
        });
    }

    let emulator = makeEmulator();

    function handleClientLine(line, replyCb) {
        if (line.startsWith('@connect:')) {
            const p = new URLSearchParams(line.slice(9));
            if (p.get('input')   === '1') info('  [INPUT]   connecté');
            if (p.get('display') === '1') info('  [DISPLAY] connecté');
            if (p.get('driver')  === '1') info('  [DRIVER]  connecté');
            const romsDir = [
                path.join(__dirname, 'roms'),
                path.join(process.cwd(), 'roms')
            ].find(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
            if (romsDir) {
                const roms = fs.readdirSync(romsDir).filter(f => f.endsWith('.zip'))
                    .map(f => f.slice(0, -4)).sort();
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
            emulator.sendMessage('INIT_ENGINE', { customRomBytes: null, customRomName: romArg ? romArg.slice(6) : null });
            broadcast('@status:state=loading');
            return true;
        }
        if (line.startsWith('@rom:')) {
            const p = new URLSearchParams(line.slice(5));
            const name = decodeURIComponent(p.get('name') || 'bonebstr').replace(/\.zip$/i, '');
            const data = p.get('data') || null;
            info(`  ROM      : changement → ${name}`);
            if (data) {
                const romPath = path.join(__dirname, 'roms', `${name}.zip`);
                fs.writeFileSync(romPath, Buffer.from(data, 'base64'));
                info(`  ROM sauvegardée → ${romPath}`);
            }
            currentRomArgs = currentRomArgs.filter(a => !a.startsWith('--rom=') && !a.startsWith('--custom-rom='));
            currentRomArgs.push(`--rom=${name}`);
            lastStatusLine = lastDisplayLine = lastLampLine = null;
            emulator = makeEmulator();
            emulator.sendMessage('INIT_ENGINE', { customRomBytes: null, customRomName: name });
            broadcast('@status:state=loading');
            return true;
        }
        return false;
    }

    // ── CÂBLAGE WS ────────────────────────────────────────────────────────────
    wsTr.onMessage((line, replyCb) => {
        if (!handleClientLine(line, replyCb)) emulator.handleLine(line);
    });
    wsTr.listen();

    // ── CÂBLAGE BLE ───────────────────────────────────────────────────────────
    if (bleTr) {
        bleTr.onConnect(() => {
            if (lastDisplayLine) bleTr.send(lastDisplayLine);
            if (lastLampLine)    bleTr.send(lastLampLine);
            if (lastStatusLine)  bleTr.send(lastStatusLine);
        });
        bleTr.onMessage(line => {
            if (!handleClientLine(line, l => bleTr.send(l))) emulator.handleLine(line);
        });
    }

    emulator.sendMessage('INIT_ENGINE', { customRomBytes, customRomName });
})().catch(e => { console.error(e); process.exit(1); });
