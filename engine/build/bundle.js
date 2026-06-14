#!/usr/bin/env node
// bundle.js — assemble engine/ → engine/web/tilt_web + engine/node/tilt_node
'use strict';

const fs   = require('node:fs');
const path = require('node:path');

const ENGINE_DIR = path.dirname(__dirname);
const OUT_DIR    = path.join(ENGINE_DIR, 'out');
const NODE_DIR   = path.join(ENGINE_DIR, 'node');
const WEB_DIR    = path.join(ENGINE_DIR, 'web');

const OUT_WEB  = path.join(WEB_DIR,  'tilt_web');
const OUT_NODE = path.join(NODE_DIR, 'tilt_node');

fs.mkdirSync(WEB_DIR, { recursive: true });

const wasmBuf   = fs.readFileSync(path.join(OUT_DIR, 'pinmame_web.wasm'));
const webJs     = fs.readFileSync(path.join(OUT_DIR, 'pinmame_web.js'),    'utf8');
const audioJs   = fs.readFileSync(path.join(NODE_DIR, 'runtime-audio.js'), 'utf8');
const runtimeJs = fs.readFileSync(path.join(NODE_DIR, 'runtime.js'),       'utf8');
const mainJs    = fs.readFileSync(path.join(NODE_DIR, 'main.js'),           'utf8');

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

// ── tilt_web ─────────────────────────────────────────────────────────────────
// Bundle universel : navigateur Worker + require() Node.js (librairie)
const webJsText = `/* ================================================================
   PinMAME — tilt_web (navigateur Worker + Node.js)
   Généré le ${stamp}
   Sources : pinmame_web.js + pinmame_web.wasm + runtime-audio.js + runtime.js
   ================================================================ */
${nodeExtract}

(function () {

${webJs}

${audioJs}

${bundledRuntimeJs}

})();`;

const webBundle = Buffer.concat([Buffer.from(webJsText, 'utf8'), sepBuf, escapedWasm, footBuf]);
fs.writeFileSync(OUT_WEB, webBundle);
fs.chmodSync(OUT_WEB, 0o755);

// ── tilt_node ─────────────────────────────────────────────────────────────────
// Bundle autoexécutable Node.js : runtime PinMAME + serveur WS/BLE intégré
// Aucun node_modules requis (BLE optionnel via @abandonware/bleno)

// Adapter main.js : supprimer 'use strict' (déjà en tête) + require('../../tilt')
const mainAdapted = mainJs
    .replace(/^'use strict';\n/m, '')
    .replace(/^const \{ createEmulator \} = require\([^)]+\);\n/m, '');

const nodeJsText = `#!/usr/bin/env node
'use strict';
/* ================================================================
   PinMAME — tilt_node (Node.js autoexécutable)
   Généré le ${stamp}
   Sources : pinmame_web.js + pinmame_web.wasm + runtime-audio.js
             + runtime.js + main.js
   ================================================================ */

/* ── Extraction WASM embarqué ── */
${nodeExtract}

/* ── Runtime PinMAME (définit createEmulator) ── */
(function () {

${webJs}

${audioJs}

${bundledRuntimeJs}

})();

/* ── Récupère createEmulator depuis le runtime ── */
const { createEmulator } = module.exports;
module.exports = {};

/* ── Serveur Node.js (WS + BLE optionnel) ── */
${mainAdapted}`;

const nodeBundle = Buffer.concat([Buffer.from(nodeJsText, 'utf8'), sepBuf, escapedWasm, footBuf]);
fs.writeFileSync(OUT_NODE, nodeBundle);
fs.chmodSync(OUT_NODE, 0o755);

const mb = n => (n / 1024 / 1024).toFixed(2) + ' MB';
const extra = escapedWasm.length - wasmBuf.length;
console.log(`✅ tilt_web  → engine/web/tilt_web   : ${mb(webBundle.length)}`);
console.log(`✅ tilt_node → engine/node/tilt_node : ${mb(nodeBundle.length)}  (WASM brut: ${mb(wasmBuf.length)}, échappements: +${extra} octets)`);
