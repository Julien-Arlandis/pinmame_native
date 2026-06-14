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

const { createEmulator } = require('../../tilt');

(async function main() {
    const fs     = require('node:fs');
    const path   = require('node:path');
    const { spawn } = require('node:child_process');

    const HELP = `
PinMAME Node Runtime
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Usage: node engine/node/main.js [options]

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

    // ── BLE PERIPHERAL ────────────────────────────────────────────────────────
    const BLE_SVC  = 'ab120001b5a3f393e0a9e50e24dcca9e';
    const BLE_OUT  = 'ab120002b5a3f393e0a9e50e24dcca9e';
    const BLE_IN   = 'ab120003b5a3f393e0a9e50e24dcca9e';

    let bleNotify    = null;
    let bleMtu       = 20;
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
                    bleMtu = maxValueSize; bleNotify = cb; bleConnected = true;
                    info('  [BLE] client connecté');
                    if (lastDisplayLine) bleSend(lastDisplayLine);
                    if (lastLampLine)    bleSend(lastLampLine);
                    if (lastStatusLine)  bleSend(lastStatusLine);
                },
                onUnsubscribe() { bleNotify = null; bleConnected = false; info('  [BLE] client déconnecté'); }
            });

            let bleInBuf = '';
            const inChar = new bleno.Characteristic({
                uuid: BLE_IN,
                properties: ['write', 'writeWithoutResponse'],
                onWriteRequest(data, offset, withoutResponse, cb) {
                    const isLast = data[0] === 0x01;
                    bleInBuf += data.slice(1).toString('utf8');
                    if (isLast) {
                        const line = bleInBuf.trim(); bleInBuf = '';
                        if (line && !handleClientLine(line, bleSend)) emulator.handleLine(line);
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

    // ── EMULATEUR ────────────────────────────────────────────────────────────
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
                    if (str !== lastDisplayStr) { lastDisplayStr = str; displaySerial.write(`D:${str}\n`); }
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
                    path.join(__dirname,     '..', '..', 'roms', `${romName}.zip`),
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
                path.join(process.cwd(), 'roms'),
                path.join(__dirname, '..', '..', 'roms')
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

    // ── WEBSOCKET (built-in, zéro dépendance) ────────────────────────────────
    {
        const crypto = require('node:crypto');
        const http   = require('node:http');

        class _WS {
            constructor(socket) {
                this.socket = socket; this.readyState = 1;
                this._ev = {}; this._buf = Buffer.alloc(0);
                socket.on('data',  d => this._onData(d));
                socket.on('close', () => { this.readyState = 3; this._emit('close'); });
                socket.on('error', e => this._emit('error', e));
            }
            on(e, cb) { (this._ev[e] = this._ev[e] || []).push(cb); return this; }
            _emit(e, ...a) { (this._ev[e] || []).forEach(cb => cb(...a)); }
            send(msg) {
                if (this.readyState !== 1) return;
                const d = Buffer.from(msg); const n = d.length;
                let h;
                if (n < 126)      { h = Buffer.alloc(2);  h[0]=0x81; h[1]=n; }
                else if (n<65536) { h = Buffer.alloc(4);  h[0]=0x81; h[1]=126; h.writeUInt16BE(n,2); }
                else              { h = Buffer.alloc(10); h[0]=0x81; h[1]=127; h.writeBigUInt64BE(BigInt(n),2); }
                try { this.socket.write(Buffer.concat([h, d])); } catch {}
            }
            _onData(chunk) {
                this._buf = Buffer.concat([this._buf, chunk]);
                while (this._buf.length >= 2) {
                    const b0=this._buf[0], b1=this._buf[1];
                    const masked=!!(b1&0x80); let len=b1&0x7f, off=2;
                    if (len===126){ if(this._buf.length<4)return; len=this._buf.readUInt16BE(2); off=4; }
                    else if(len===127){ if(this._buf.length<10)return; len=Number(this._buf.readBigUInt64BE(2)); off=10; }
                    const need=off+(masked?4:0)+len;
                    if(this._buf.length<need)return;
                    let payload;
                    if (masked) {
                        const mask=this._buf.slice(off,off+4); off+=4;
                        payload=Buffer.alloc(len);
                        for(let i=0;i<len;i++) payload[i]=this._buf[off+i]^mask[i%4];
                    } else { payload=this._buf.slice(off,off+len); }
                    this._buf=this._buf.slice(off+len);
                    const op=b0&0x0f;
                    if(op===1||op===2) this._emit('message', payload);
                    else if(op===8){ this.readyState=3; this.socket.end(); this._emit('close'); }
                }
            }
        }

        const server = http.createServer();
        server.on('error', e => console.error(`⚠️  WebSocket: ${e.message}`));
        server.on('upgrade', (req, socket) => {
            const key = req.headers['sec-websocket-key'];
            if (!key) { socket.end(); return; }
            const accept = crypto.createHash('sha1')
                .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
            socket.write(
                'HTTP/1.1 101 Switching Protocols\r\n' +
                'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
                `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
            );
            const ws = new _WS(socket);
            wsClients.add(ws);
            ws.send(`@master:name=runtime-node&version=1`);
            ws.on('message', data => {
                const line = data.toString().trim();
                if (!handleClientLine(line, l => ws.send(l))) emulator.handleLine(line);
            });
            const disconnect = () => {
                if (!wsClients.has(ws)) return;
                wsClients.delete(ws);
                info('  [WS]      déconnecté');
            };
            ws.on('close', disconnect);
            ws.on('error', disconnect);
        });
        server.listen(wsPort);
        info(`  WebSocket: ws://localhost:${wsPort}`);
    }

    emulator.sendMessage('INIT_ENGINE', { customRomBytes, customRomName });
})().catch(e => { console.error(e); process.exit(1); });
