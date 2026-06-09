#!/usr/bin/env node
// build_bundle.js — assemble src-emul/ → tilt (exécutable universel)
'use strict';

const fs   = require('node:fs');
const path = require('node:path');

const SRC   = path.join(__dirname, 'src-emul');
const OUT   = path.join(__dirname, 'tilt');

const wasmBuf    = fs.readFileSync(path.join(SRC, 'pinmame_web.wasm'));
const webJs      = fs.readFileSync(path.join(SRC, 'pinmame_web.js'),  'utf8');
const audioJs    = fs.readFileSync(path.join(SRC, 'audio.js'),    'utf8');
const runtimeJs  = fs.readFileSync(path.join(SRC, 'runtime.js'),  'utf8');
const nodeMainJs = fs.readFileSync(path.join(SRC, 'node_main.js'), 'utf8');

// Escape */ (0x2A 0x2F) sequences in WASM so they can't close the JS block comment
function escapeWasm(buf) {
    const chunks = [];
    let start = 0;
    for (let i = 0; i < buf.length - 1; i++) {
        if (buf[i] === 0x2A && buf[i + 1] === 0x2F) {
            chunks.push(buf.slice(start, i + 1)); // include the 0x2A
            chunks.push(Buffer.from([0x5C]));      // insert backslash between * and /
            start = i + 1;
            i++; // skip the 0x2F (it stays at start)
        }
    }
    chunks.push(buf.slice(start));
    return Buffer.concat(chunks);
}

const escapedWasm = escapeWasm(wasmBuf);

// In the bundle, _bundled is always true (WASM is embedded)
const bundledRuntimeJs = runtimeJs.replace(

    "const _bundled = typeof __PINMAME_WASM_BINARY__ !== 'undefined';",
    "const _bundled = true; // bundle: WASM binary embedded"
);

// Node self-extraction: read own file, find WASM after marker, unescape, set global
const nodeExtract = `\
if (typeof process !== 'undefined' && typeof __filename !== 'undefined') {
    const _d = require('fs').readFileSync(__filename);
    const _m = Buffer.from('\\n/* __WASM__\\n');
    const _mp = _d.lastIndexOf(_m);
    if (_mp !== -1) {
        let _r = _d.slice(_mp + _m.length);
        const _ep = _r.lastIndexOf(Buffer.from('\\n*/'));
        if (_ep !== -1) _r = _r.slice(0, _ep);
        const _o = Buffer.allocUnsafe(_r.length);
        let _oi = 0;
        for (let _i = 0; _i < _r.length; _i++) {
            if (_r[_i] === 0x2A && _r[_i+1] === 0x5C && _r[_i+2] === 0x2F) {
                _o[_oi++] = 0x2A; _o[_oi++] = 0x2F; _i += 2;
            } else { _o[_oi++] = _r[_i]; }
        }
        globalThis.__PINMAME_WASM_BINARY__ = _o.slice(0, _oi);
    }
}`;

const jsText = `#!/usr/bin/env node
/* ================================================================
   PinMAME — bundle universel (navigateur Worker + Node.js CLI)
   Généré le ${new Date().toISOString()}
   Sources : src-emul/pinmame_web.js + pinmame_web.wasm + audio.js + runtime.js
   ================================================================ */
${nodeExtract}

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

${webJs}

${audioJs}

${bundledRuntimeJs}

${nodeMainJs}

})();`;

// Bundle = JS text + binary WASM inside a /* */ comment
const jsBuf    = Buffer.from(jsText, 'utf8');
const sepBuf   = Buffer.from('\n/* __WASM__\n');
const footBuf  = Buffer.from('\n*/\n');
const bundle   = Buffer.concat([jsBuf, sepBuf, escapedWasm, footBuf]);

fs.writeFileSync(OUT, bundle);
fs.chmodSync(OUT, 0o755);

const mb = n => (n / 1024 / 1024).toFixed(2) + ' MB';
const extra = escapedWasm.length - wasmBuf.length;
console.log(`✅ tilt  : ${mb(bundle.length)} (WASM brut: ${mb(wasmBuf.length)}, échappements: +${extra} octets)`);
