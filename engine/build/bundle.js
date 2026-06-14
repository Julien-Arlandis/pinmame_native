#!/usr/bin/env node
// bundle.js — assemble engine/ → tilt (exécutable universel)
'use strict';

const fs   = require('node:fs');
const path = require('node:path');

const ENGINE_DIR  = path.dirname(__dirname);
const PROJECT_ROOT = path.dirname(ENGINE_DIR);
const OUT_DIR     = path.join(ENGINE_DIR, 'out');
const NODE_DIR    = path.join(ENGINE_DIR, 'node');
const OUT         = path.join(PROJECT_ROOT, 'tilt');

const wasmBuf   = fs.readFileSync(path.join(OUT_DIR, 'pinmame_web.wasm'));
const webJs     = fs.readFileSync(path.join(OUT_DIR, 'pinmame_web.js'),  'utf8');
const audioJs   = fs.readFileSync(path.join(NODE_DIR, 'runtime-audio.js'), 'utf8');
const runtimeJs = fs.readFileSync(path.join(NODE_DIR, 'runtime.js'),  'utf8');

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

const jsText = `/* ================================================================
   PinMAME — librairie partagée (navigateur Worker + Node.js)
   Généré le ${new Date().toISOString()}
   Sources : pinmame_web.js + pinmame_web.wasm + runtime-audio.js + runtime.js
   ================================================================ */
${nodeExtract}

(function () {

${webJs}

${audioJs}

${bundledRuntimeJs}

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
