#!/usr/bin/env node
// build_bundle.js — assemble src-emul/ → tilt (exécutable universel)
'use strict';

const fs   = require('node:fs');
const path = require('node:path');

const SRC   = path.join(__dirname, 'src-emul');
const OUT   = path.join(__dirname, 'tilt');

const wasmBuf  = fs.readFileSync(path.join(SRC, 'pinmame_web.wasm'));
const wasmB64  = wasmBuf.toString('base64');
const webJs    = fs.readFileSync(path.join(SRC, 'pinmame_web.js'),  'utf8');
const runtimeJs = fs.readFileSync(path.join(SRC, 'runtime.js'),     'utf8');

const bundle = `#!/usr/bin/env node
/* ================================================================
   PinMAME — bundle universel (navigateur Worker + Node.js CLI)
   Généré le ${new Date().toISOString()}
   Sources : src-emul/pinmame_web.js + pinmame_web.wasm + runtime.js
   ================================================================ */
(function () {

// Filtre les logs natifs BLE (CoreBluetooth/bleno) en se respawnant
// avec stderr pipé. Désactivé si --ble-log est passé.
if (typeof process !== 'undefined' && typeof require !== 'undefined' &&
    require.main === module && !process.env._TILT_RUNNING &&
    !process.argv.includes('--ble-log')) {
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, process.argv.slice(1), {
        env: { ...process.env, _TILT_RUNNING: '1' },
        stdio: ['inherit', 'inherit', 'pipe']
    });
    const BLE_RE = /BlenoMac|CoreBluetooth|napiToCB|napiArray|peripheralManager|CBMutable/;
    let buf = '';
    child.stderr.on('data', chunk => {
        buf += chunk.toString();
        let i;
        while ((i = buf.indexOf('\\n')) >= 0) {
            const line = buf.slice(0, i + 1);
            buf = buf.slice(i + 1);
            if (!BLE_RE.test(line)) process.stderr.write(line);
        }
    });
    child.stderr.on('end', () => { if (buf) process.stderr.write(buf); });
    child.on('exit', (code, sig) => { process.exitCode = code ?? (sig ? 1 : 0); });
    return; // Le parent n'exécute pas la suite
}

const __PINMAME_WASM_BINARY__ = (() => {
    const b64 = "${wasmB64}";
    if (typeof Buffer !== 'undefined') return Buffer.from(b64, 'base64');
    const s = atob(b64);
    const a = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
    return a;
})();

${webJs}

${runtimeJs}

})();`;

fs.writeFileSync(OUT, bundle, 'utf8');
fs.chmodSync(OUT, 0o755);

const kb = s => (s / 1024).toFixed(1) + ' KB';
const mb = s => (s / 1024 / 1024).toFixed(2) + ' MB';
const sz = Buffer.byteLength(bundle);
console.log(`✅ tilt  : ${mb(sz)} (WASM embarqué : ${kb(wasmBuf.length)})`);
