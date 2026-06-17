#!/usr/bin/env node
// bundle.js — assemble engine/ → web/flip-g80 (la librairie)
'use strict';

const fs   = require('node:fs');
const path = require('node:path');

const ENGINE_DIR = path.dirname(__dirname);
const OUT_DIR    = path.join(ENGINE_DIR, 'out');
const NODE_DIR   = path.join(ENGINE_DIR, 'node');
const WEB_DIR    = path.join(ENGINE_DIR, 'web');

const OUT_FLIP = path.join(WEB_DIR, 'flip-g80');

fs.mkdirSync(WEB_DIR, { recursive: true });

const wasmBuf   = fs.readFileSync(path.join(OUT_DIR, 'pinmame_web.wasm'));
const webJs     = fs.readFileSync(path.join(OUT_DIR, 'pinmame_web.js'),    'utf8');
const audioJs   = fs.readFileSync(path.join(NODE_DIR, 'runtime-audio.js'), 'utf8');
const runtimeJs = fs.readFileSync(path.join(NODE_DIR, 'runtime.js'),       'utf8');

// Escape */ (0x2A 0x2F) sequences in WASM so they can't close the JS block comment
function escapeWasm(buf) {
    const chunks = [];
    let start = 0;
    for (let i = 0; i < buf.length - 1; i++) {
        if (buf[i] === 0x2A && buf[i + 1] === 0x2F) {
            chunks.push(buf.slice(start, i + 1));
            chunks.push(Buffer.from([0x5C]));
            start = i + 1;
            i++;
        }
    }
    chunks.push(buf.slice(start));
    return Buffer.concat(chunks);
}

const escapedWasm = escapeWasm(wasmBuf);

const bundledRuntimeJs = runtimeJs.replace(
    "const _bundled = typeof __PINMAME_WASM_BINARY__ !== 'undefined';",
    "const _bundled = true; // bundle: WASM binary embedded"
);

// Extraction WASM embarqué (commun aux deux bundles)
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

const stamp   = new Date().toISOString();
const sepBuf  = Buffer.from('\n/* __WASM__\n');
const footBuf = Buffer.from('\n*/\n');

// ── flip-g80 ─────────────────────────────────────────────────────────────────
// Bundle universel : navigateur Worker + require() Node.js (librairie)
const flipJsText = `/* ================================================================
   flip-g80 — librairie PinMAME Gottlieb System 80 (navigateur Worker + Node.js)
   Généré le ${stamp}
   Sources : pinmame_web.js + pinmame_web.wasm + runtime-audio.js + runtime.js
   ================================================================ */
${nodeExtract}

(function () {

${webJs}

${audioJs}

${bundledRuntimeJs}

})();`;

const flipBundle = Buffer.concat([Buffer.from(flipJsText, 'utf8'), sepBuf, escapedWasm, footBuf]);
fs.writeFileSync(OUT_FLIP, flipBundle);
fs.chmodSync(OUT_FLIP, 0o755);

const mb = n => (n / 1024 / 1024).toFixed(2) + ' MB';
const extra = escapedWasm.length - wasmBuf.length;
console.log(`✅ flip-g80 → web/flip-g80 : ${mb(flipBundle.length)}  (WASM brut: ${mb(wasmBuf.length)}, échappements: +${extra} octets)`);
