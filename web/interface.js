// interface.js
// Browser UI — transport agnostique (implémentations dans web/transport/)

function feedAudioRingBuffer() {}

function unlockAudio() {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctx.resume();
    let t = 0;
    feedAudioRingBuffer = (left, right) => {
        const s = ctx.createBufferSource();
        s.buffer = ctx.createBuffer(2, left.length, 44100);
        s.buffer.getChannelData(0).set(left);
        s.buffer.getChannelData(1).set(right);
        s.connect(ctx.destination);
        s.start(t = Math.max(t, ctx.currentTime + left.length / 44100));
        t += left.length / 44100;
    };
    unlockAudio = () => ctx.resume();
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAÎTRES
// Un maître parle le protocole texte ligne par ligne :
//   Reçoit (browser → maître) : @set:  @dip:  @sound:  @audio:
//   Émet   (maître → browser) : !set:  !lamp:  !display:  @status:
// ═══════════════════════════════════════════════════════════════════════════════

// ─── SerialMaster ─────────────────────────────────────────────────────────────
// Adapte un transport { send, onMessage, onAudio?, onCapture?, onScope?,
//                       onDisconnect?, disconnect? } en objet unifié pour l'UI.

class SerialMaster {
    constructor(transport) {
        this._transport = transport;
        this.isLocal    = transport.isLocal || false;
        this._callbacks = [];

        transport.onMessage(line => { for (const cb of this._callbacks) cb(line); });
        transport.onAudio?.((l, r) => this._audioCallback?.(l, r));
        transport.onCapture?.(d    => this._captureCallback?.(d));
        transport.onScope?.(d      => this._scopeCallback?.(d));
        transport.onDisconnect?.(() => this._disconnectCallback?.());
    }

    send(line)         { this._transport.send(line); }
    onMessage(cb)      { this._callbacks.push(cb); }
    onAudio(cb)        { this._audioCallback   = cb; }
    onCapture(cb)      { this._captureCallback = cb; }
    onScope(cb)        { this._scopeCallback   = cb; }
    onDisconnect(cb)   { this._disconnectCallback = cb; }
    disconnect()       { this._transport.disconnect?.(); }
    get name()         { return this._transport.name; }
}

// Tente une connexion WebSocket, attend le handshake @master:name=...
// Retourne un SerialMaster ou null au bout de 1,5 s
async function trySerialMaster(url) {
    const transport = await tryWsTransport(url); // défini dans transport/ws-client.js
    if (!transport) return null;
    const m = new SerialMaster(transport);
    m._reconnectUrl = url;
    return m;
}

const BLE_STUB   = { _ble: true,   name: 'Bluetooth — flip-g80' };
const LOCAL_STUB = { _local: true, name: 'Exécution locale (navigateur)', isLocal: true };

async function discoverMasters() {
    return [LOCAL_STUB];
}

// Crée le master effectif à partir d'un stub ou retourne le master déjà résolu
async function resolveMaster(m) {
    if (m._local) return new SerialMaster(await createWorkerTransport());    // transport/worker.js
    if (m._ble)   return new SerialMaster(await createBleCentralTransport()); // transport/ble-central.js
    return m;
}

// Sélection : auto-local si aucune connexion externe disponible, overlay sinon
// Le Worker n'est créé QU'APRÈS la sélection pour éviter la race condition
// où @status:state=ready arrive avant que connectMaster ait câblé onMessage.
async function selectMaster(masters) {
    const hasExternal = masters.some(m => !m.isLocal);
    if (!hasExternal) return resolveMaster(masters[0]);
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;z-index:9999;';
        const title = document.createElement('div');
        title.style.cssText = 'color:#fff;font-family:monospace;font-size:1rem;margin-bottom:8px;';
        title.textContent = 'Sélectionner un maître';
        overlay.appendChild(title);
        for (const m of masters) {
            const btn = document.createElement('button');
            btn.style.cssText = 'background:#1c1c1c;border:1px solid #444;color:#fff;padding:10px 24px;border-radius:4px;font-family:monospace;font-size:0.9rem;cursor:pointer;min-width:200px;';
            btn.textContent = m.name;
            btn.onmouseenter = () => btn.style.borderColor = '#00ffff';
            btn.onmouseleave = () => btn.style.borderColor = '#444';
            btn.onclick = async () => {
                try {
                    const resolved = await resolveMaster(m);
                    overlay.remove();
                    resolve(resolved);
                } catch (e) {
                    btn.textContent = 'Erreur — réessayer';
                    btn.style.borderColor = '#ff4444';
                    setTimeout(() => { btn.textContent = m.name; btn.style.borderColor = '#444'; }, 2000);
                }
            };
            overlay.appendChild(btn);
        }
        document.body.appendChild(overlay);
    });
}

// Afficheurs chargés via <script> dans index.html :
//   display/gottlieb-80.js   → GottliebDisplay80
//   display/gottlieb-80a.js  → GottliebDisplay80A
//   display/gottlieb-80b.js  → GottliebDisplay80B (actif, 14 segments alphanumériques)

// ═══════════════════════════════════════════════════════════════════════════════
// UI NAVIGATEUR
// ═══════════════════════════════════════════════════════════════════════════════

const SOUND_DICTIONARY = { 1: "STOP", 2: "BGM 1", 3: "BGM 2", 4: "BGM 3", 5: "BGM 4", 61: "BANK CLEAR", 63: "TEST TONE" };
const SWITCH_DICTIONARY = {
    0:"10 Points",1:"10 Points",2:"10 Points",3:"10 Points",4:"Left Outlane",5:"Left Return",6:"Right Return",7:"Test Button",
    10:"10 Points",11:"10 Points",12:"10 Points",13:"10 Points",14:"Right Outlane",15:"Left Top Lane",16:"Right Top Lane",17:"Center Coin Chute (8 Cr)",
    20:"10 Points",21:"10 Points",22:"10 Points",23:"10 Points",24:"Left Drop - Top",25:"Left Drop - Center",26:"Left Drop - Bottom",27:"Left Coin Chute (1/2 Cr)",
    30:"10 Points",31:"10 Points",32:"10 Points",33:"Left Bumper",34:"Right Drop - Top",35:"Right Drop - Center",36:"Right Drop - Bottom",37:"Coin Chute 4",
    40:"Target 'B'",41:"Target 'O'",42:"Target 'N'",43:"Shooter Lane",44:"Left Captive",45:"Right Captive",46:"Outhole",47:"Replay Button (START)",
    50:"Target 'E'",51:"Target 'S'",52:"Target 'U'",53:"Trough 1",54:"Trough 2",55:"Trough 3",56:"Trough 4",57:"Right Coin Chute",
    60:"Target 'B' (Bust)",61:"Target 'U' (Bust)",62:"Target 'S' (Bust)",63:"Target 'T' (Bust)",64:"Target 'E' (Bust)",65:"Target 'R' (Bust)",66:"Target 'S' (Bust)",67:"Slam Tilt",
    70:"Top Rebound",71:"Right Bumper",72:"Bottom Bumper",73:"Kicker",74:"Standup Right",75:"Standup Left",76:"Spinner",77:"Plumb Bob Tilt"
};

// ── DOM ───────────────────────────────────────────────────────────────────────

const statusEl       = document.getElementById('status');
const termEl         = document.getElementById('terminal');
const dipContainer   = document.getElementById('dipContainer');
const romUploader    = document.getElementById('romUploader');
const romSelector    = document.getElementById('romSelector');
const rebootBtn      = document.getElementById('rebootBtn');


const _masterRef = { current: null, isLocal: true }; // référence partagée, toujours à jour

// ── État ──────────────────────────────────────────────────────────────────────

const swCells    = [], lampCells = [], solCells = [], dipToggles = [];
const userSwitchStates = new Array(80).fill(false);
const ancienEtatLampesIndividuelles = new Uint8Array(96).fill(0);

let userDipStates = new Array(32).fill(false);
try { const s = localStorage.getItem('pinmame_dips'); if (s) userDipStates = JSON.parse(s); } catch (_) {}

const COIN_ID = 27, START_ID = 47, TEST_ID = 7;

let _audioMaster = null; // Référence mutable — mise à jour à chaque changement de master

// ── Logs ──────────────────────────────────────────────────────────────────────

const MAX_LOG_LINES = 200;
const _logLines = [];
let _termRafPending = false;
function logToTerminal(msg) {
    _logLines.push(msg);
    if (_logLines.length > MAX_LOG_LINES) _logLines.splice(0, _logLines.length - MAX_LOG_LINES);
    if (!_termRafPending) {
        _termRafPending = true;
        requestAnimationFrame(() => {
            _termRafPending = false;
            termEl.textContent = _logLines.join('\n');
            termEl.scrollTop = termEl.scrollHeight;
        });
    }
}

const chkInput = document.getElementById('chkInput');
const chkDriver = document.getElementById('chkDriver');
const chkDisplay = document.getElementById('chkDisplay');
document.getElementById('btnCopyLogs').onclick = () => {
    navigator.clipboard.writeText(termEl.textContent).then(() => {
        const btn = document.getElementById('btnCopyLogs'), orig = btn.textContent;
        btn.textContent = '✔ Copié !'; btn.style.background = '#004411';
        setTimeout(() => { btn.textContent = orig; btn.style.background = '#1f1f1f'; }, 1200);
    });
};

function logHardwareTraffic(from, to, line, cat) {
    if (cat === 'INPUT' && !chkInput.checked) return;
    if (cat === 'DRIVER' && !chkDriver.checked) return;
    if (cat === 'DISPLAY' && !chkDisplay.checked) return;
    logToTerminal(`[${from} ➔ ${to}] ${line}`);
}


// ── Handlers messages maître ──────────────────────────────────────────────────

// Buffers pour batcher les mises à jour DOM dans requestAnimationFrame
const _pendingLamp = new Uint8Array(96);   // nouvel état
const _dirtyLamp   = new Uint8Array(96);   // 1 = à mettre à jour
const _pendingSol  = new Int8Array(32);    // -1=rien, 0/1=état
let   _driverRaf      = false;
let   _lastLampFlush  = 0;
_pendingSol.fill(-1);

function _flushDriver() {
    _driverRaf = false;
    const now = performance.now();
    const remaining = 50 - (now - _lastLampFlush);
    if (remaining > 0) {
        if (!_driverRaf) { _driverRaf = true; setTimeout(() => requestAnimationFrame(_flushDriver), remaining); }
        return;
    }
    _lastLampFlush = now;
    for (let i = 0; i < 96; i++) {
        if (!_dirtyLamp[i]) continue;
        _dirtyLamp[i] = 0;
        if (lampCells[i]) lampCells[i].classList.toggle('lamp-on', _pendingLamp[i] === 1);
    }
    for (let i = 0; i < 32; i++) {
        if (_pendingSol[i] < 0) continue;
        if (solCells[i]) solCells[i].classList.toggle('sol-on', _pendingSol[i] === 1);
        _pendingSol[i] = -1;
    }
}

function handleDriverLine(line) {
    if (line.startsWith('!lamp:')) {
        // format: !lamp:<24 hex chars> — 12 colonnes × 1 octet
        const hex = line.slice(6);
        for (let col = 0; col < 12; col++) {
            const mask = parseInt(hex.slice(col * 2, col * 2 + 2), 16);
            for (let row = 0; row < 8; row++) {
                const lampId = col * 8 + row, state = (mask >> row) & 1;
                if (state !== ancienEtatLampesIndividuelles[lampId]) {
                    logHardwareTraffic('MASTER', 'DRIVER', `!lamp:id=${lampId+1}&state=${state}`, 'DRIVER');
                    ancienEtatLampesIndividuelles[lampId] = state;
                    _pendingLamp[lampId] = state;
                    _dirtyLamp[lampId]   = 1;
                }
            }
        }
    } else if (line.startsWith('!set:')) {
        // format: !set:id=X&state=Y — parse manuel sans URLSearchParams
        const amp = line.indexOf('&', 5);
        const id    = parseInt(line.slice(8, amp));
        const state = parseInt(line.slice(amp + 7));
        _pendingSol[id] = state;
        logHardwareTraffic('MASTER', 'DRIVER', line, 'DRIVER');
    }
    if (!_driverRaf) { _driverRaf = true; requestAnimationFrame(_flushDriver); }
}

let _currentRom = null;

const stripExt = name => name.replace(/\.[^.]+$/, '');

function applyCurrentRom() {
    if (!romSelector || !_currentRom) return;
    if (sessionStorage.getItem('custom_rom_bytes')) {
        const label = stripExt(sessionStorage.getItem('custom_rom_filename') || _currentRom);
        let opt = romSelector.querySelector(`option[value="${_currentRom}"]`);
        if (!opt) {
            opt = document.createElement('option');
            opt.value = _currentRom; opt.textContent = label;
            opt.dataset.injected = '1';
            romSelector.appendChild(opt);
            romSelector.style.display = 'inline-block';
        }
        romSelector.value = _currentRom;
        return;
    }
    romSelector.querySelectorAll('option[data-injected]').forEach(o => o.remove());
    romSelector.value = romSelector.querySelector(`option[value="${_currentRom}"]`) ? _currentRom : '';
}

function handleStatusLine(line) {
    if (!line.startsWith('@status:')) return;
    const p = new URLSearchParams(line.slice(8)), state = p.get('state');
    if (state === 'ready') {
        const rom = p.get('rom') || 'unknown';
        _currentRom = rom;
        statusEl.textContent = '🟢 PinMAME Workbench v3.127';
        statusEl.style.color = '#00ffcc';
        logToTerminal(`✅ ROM prête : ${rom}`);
        applyCurrentRom();
        window._onEngineReady?.();
    } else if (state === 'loading') {
        statusEl.textContent = '🟡 Chargement...'; statusEl.style.color = '';
        logToTerminal('⏳ Chargement ROM...');
    }
}

// ── Connexion au maître ───────────────────────────────────────────────────────

function connectMaster(master, displayRef) {
    master.onAudio((left, right) => feedAudioRingBuffer(left, right));
    master.onMessage((line) => {
        if (typeof line !== 'string') return;
        const display = displayRef.current;
        if (line.startsWith('!display:')) {
            display.parseCommand(line);
            if (line.startsWith('!display:action=raw&data=')) {
                const s = display.decodeRaw(line.slice(25));
                logHardwareTraffic('MASTER', 'DISPLAY', `!display:ascii=[${s.slice(0,20)}|${s.slice(20)}]`, 'DISPLAY');
            } else {
                logHardwareTraffic('MASTER', 'DISPLAY', line, 'DISPLAY');
            }
        } else if (line.startsWith('!set:') || line.startsWith('!lamp:')) {
            handleDriverLine(line);
        } else if (line.startsWith('@status:')) {
            handleStatusLine(line);
        } else if (line.startsWith('@machine:')) {
            const raw = line.slice(9);
            const p2  = new URLSearchParams(raw.replace(/\|/g, '&'));
            // Sélection dynamique de l'afficheur selon la génération matérielle
            const dsp = p2.get('dsp');
            if (dsp === '80B' && !(displayRef.current instanceof GottliebDisplay80B))
                displayRef.current = new GottliebDisplay80B('vfdCanvas');
            else if (dsp === '80' && !(displayRef.current instanceof GottliebDisplay80))
                displayRef.current = new GottliebDisplay80('vfdCanvas');
            const cpu    = (p2.get('cpu')    || '').replace(/\+/g, '  ');
            const snd    = (p2.get('snd')    || '').replace(/\+/g, ', ');
            const stereo = p2.get('stereo') === '1';
            const rate   = p2.get('rate') || '?';
            logToTerminal(`CPU : ${cpu}`);
            logToTerminal(`Son : ${snd} | ${stereo ? 'Stéréo' : 'Mono'} | ${rate} Hz`);
            if (dsp) logToTerminal(`Afficheur : Gottlieb System ${dsp}`);
        } else if (line.startsWith('@sound:chips=')) {
            // conservé pour compatibilité Node.js
        } else if (line.startsWith('@roms:list=')) {
            const names = line.slice(11).split(',').map(decodeURIComponent).filter(Boolean);
            romSelector.innerHTML = names.map(n => `<option value="${n}">${stripExt(n)}</option>`).join('');
            if (romSelector.options.length > 0) { romSelector.style.display = 'inline-block'; applyCurrentRom(); }
        }
    });
}

// ── Grilles ───────────────────────────────────────────────────────────────────

function buildSwitchGrid() {
    const grid = document.getElementById('swGrid');
    grid.innerHTML = ''; swCells.length = 0;
    for (let i = 0; i < 80; i++) {
        const cell = document.createElement('div'); cell.className = 'cell';
        cell.title = SWITCH_DICTIONARY[i] || `Contact ${String(i).padStart(2,'0')}`;
        cell.innerHTML = `<span class="sw-num-text">${String(i).padStart(2,'0')}</span><svg class="mini-loader-svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"></circle></svg>`;
        let holdTimer = null, isLocked = false, isPressed = false;
        const notify = (state) => {
            userSwitchStates[i] = state === 1;
            logHardwareTraffic('INPUT', 'MASTER', `@set:id=${i}&state=${state}`, 'INPUT');
            _masterRef.current?.send(`@set:id=${i}&state=${state}`);
        };
        const down = (e) => {
            if (e.type.startsWith('touch')) e.preventDefault();
            if (isLocked) { isLocked = false; cell.classList.remove('sw-locked'); notify(0); isPressed = false; clearTimeout(holdTimer); return; }
            if (!isPressed) {
                isPressed = true; notify(1);
                cell.classList.add('sw-user');
                holdTimer = setTimeout(() => { if (isPressed) { isLocked = true; cell.classList.remove('sw-user'); cell.classList.add('sw-locked'); } }, 500);
            }
        };
        const up = (e) => {
            if (e && e.type.startsWith('touch')) e.preventDefault();
            clearTimeout(holdTimer); holdTimer = null;
            if (isPressed && !isLocked) { isPressed = false; notify(0); cell.classList.remove('sw-user'); }
        };
        cell.addEventListener('mousedown',  down); cell.addEventListener('touchstart',  down, { passive:false });
        cell.addEventListener('mouseup',    up);   cell.addEventListener('touchend',    up,   { passive:false });
        cell.addEventListener('mouseleave', up);   cell.addEventListener('touchcancel', up,   { passive:false });
        grid.appendChild(cell); swCells.push(cell);
    }
}

function buildSoundGrid() {
    const grid = document.getElementById('cmd-grid');
    grid.innerHTML = '';
    for (let i = 1; i <= 64; i++) {
        const cell = document.createElement('div'); cell.className = 'cell cell-cmd';
        cell.innerHTML = `<div class="cell-cmd-num">${String(i).padStart(2,'0')}</div><div class="cell-cmd-desc">${SOUND_DICTIONARY[i]||'SFX'}</div>`;
        const trigger = (e) => {
            if (e.type.startsWith('touch')) e.preventDefault();
            cell.classList.add('cmd-active'); setTimeout(() => cell.classList.remove('cmd-active'), 120);
            _masterRef.current?.send(`@sound:cmd=${i}`);
        };
        cell.addEventListener('mousedown', trigger); cell.addEventListener('touchstart', trigger, { passive:false });
        grid.appendChild(cell);
    }
}

function buildDipSwitches() {
    dipContainer.innerHTML = ''; dipToggles.length = 0;
    for (let bank = 0; bank < 4; bank++) {
        const bankEl = document.createElement('div'); bankEl.className = 'dip-bank';
        for (let bit = 0; bit < 8; bit++) {
            const dipId = bank * 8 + bit;
            const wrap = document.createElement('div'); wrap.className = 'dip-switch';
            const label = document.createElement('span'); label.textContent = String(dipId+1).padStart(2,'0');
            const toggle = document.createElement('div'); toggle.className = 'dip-toggle';
            if (userDipStates[dipId]) toggle.classList.add('dip-on');
            const toggleDip = (e) => {
                if (e.type.startsWith('touch')) e.preventDefault();
                userDipStates[dipId] = !userDipStates[dipId];
                toggle.classList.toggle('dip-on', userDipStates[dipId]);
                _masterRef.current?.send(`@dip:id=${dipId}&state=${userDipStates[dipId]?1:0}`);
                localStorage.setItem('pinmame_dips', JSON.stringify(userDipStates));
            };
            toggle.addEventListener('mousedown', toggleDip); toggle.addEventListener('touchstart', toggleDip, { passive:false });
            wrap.appendChild(label); wrap.appendChild(toggle); bankEl.appendChild(wrap); dipToggles.push(toggle);
        }
        dipContainer.appendChild(bankEl);
    }
}

function buildLampGrid() {
    const grid = document.getElementById('lampGrid');
    for (let i = 0; i < 96; i++) {
        const c = document.createElement('div');
        c.className = 'cell';
        c.textContent = 'L' + String(i + 1).padStart(2, '0');
        grid.appendChild(c);
        lampCells.push(c);
    }
}

function buildSolGrid() {
    const grid = document.getElementById('solGrid');
    for (let i = 0; i < 32; i++) { const c = document.createElement('div'); c.className='cell'; c.textContent='S'+String(i+1).padStart(2,'0'); grid.appendChild(c); solCells.push(c); }
}

function setupSystemHandlers(restartFn) {
    const localRestart = restartFn || (() => {});
    const isRemote = () => !_masterRef.isLocal;
    rebootBtn.onclick = () => {
        logToTerminal('🔄 Reboot');
        isRemote() ? _masterRef.current.send('@reboot:') : localRestart();
    };
    if (romSelector) {
        romSelector.onchange = () => {
            const name = romSelector.value;
            if (!name) return;
            logToTerminal(`📀 ROM sélectionnée : ${name}`);
            if (isRemote()) {
                sessionStorage.removeItem('custom_rom_bytes');
                sessionStorage.removeItem('custom_rom_filename');
                _masterRef.current.send(`@rom:name=${encodeURIComponent(name)}`);
            } else {
                if (name !== sessionStorage.getItem('custom_rom_filename')) {
                    sessionStorage.removeItem('custom_rom_bytes');
                }
                sessionStorage.setItem('custom_rom_filename', name);
                localRestart();
            }
        };
    }
    romUploader.onchange = (e) => {
        const file = e.target.files[0]; if (!file) return;
        e.target.value = '';
        const reader = new FileReader();
        reader.onload = (evt) => {
            const bytes = new Uint8Array(evt.target.result);
            let bin = '';
            for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
            const b64 = btoa(bin);
            logToTerminal(`📤 Upload ROM : ${file.name} (${(bytes.length/1024).toFixed(1)} KB)`);
            if (isRemote()) {
                _masterRef.current.send(`@rom:name=${encodeURIComponent(file.name)}&data=${encodeURIComponent(b64)}`);
            } else {
                sessionStorage.setItem('custom_rom_bytes', b64);
                sessionStorage.setItem('custom_rom_filename', file.name);
                localRestart();
            }
        };
        reader.readAsArrayBuffer(file);
    };
    const attachMacro = (btnId, id) => {
        const btn = document.getElementById(btnId); if (!btn) return;
        let pressed = false;
        const down = (e) => {
            if (e.type.startsWith('touch')) e.preventDefault();
            if (pressed) return;
            pressed = true;
            swCells[id]?.classList.add('sw-user');
            _masterRef.current?.send(`@set:id=${id}&state=1`);
        };
        const up = (e) => {
            if (e.type.startsWith('touch')) e.preventDefault();
            if (!pressed) return;
            pressed = false;
            swCells[id]?.classList.remove('sw-user');
            _masterRef.current?.send(`@set:id=${id}&state=0`);
        };
        btn.addEventListener('mousedown', down); btn.addEventListener('touchstart', down, { passive:false });
        btn.addEventListener('mouseup',   up);   btn.addEventListener('touchend',   up,   { passive:false });
        btn.addEventListener('mouseleave', up);  btn.addEventListener('touchcancel', up,  { passive:false });
    };
    attachMacro('coinBtn', COIN_ID); attachMacro('startBtn', START_ID); attachMacro('testBtn', TEST_ID);

}

// ═══════════════════════════════════════════════════════════════════════════════
// BOOTSTRAP
// ═══════════════════════════════════════════════════════════════════════════════

function matWrite(variables) {
    const LE = true;
    const enc = new TextEncoder();
    function pad8(n) { return (n + 7) & ~7; }
    function elem(type, bytes) {
        const p = pad8(bytes.byteLength);
        const buf = new Uint8Array(8 + p);
        const dv = new DataView(buf.buffer);
        dv.setUint32(0, type, LE);
        dv.setUint32(4, bytes.byteLength, LE);
        buf.set(bytes, 8);
        return buf;
    }
    const chunks = [];
    for (const [name, arr] of Object.entries(variables)) {
        const n = arr.length;
        const flags = new Uint8Array(8); new DataView(flags.buffer).setUint32(0, 7, LE);
        const dims  = new Uint8Array(8); const dv = new DataView(dims.buffer); dv.setInt32(0, 1, LE); dv.setInt32(4, n, LE);
        const flagsEl = elem(6, flags);
        const dimsEl  = elem(5, dims);
        const nameEl  = elem(1, enc.encode(name));
        const dataEl  = elem(7, new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength));
        const innerSize = flagsEl.byteLength + dimsEl.byteLength + nameEl.byteLength + dataEl.byteLength;
        const outerTag = new Uint8Array(8);
        new DataView(outerTag.buffer).setUint32(0, 14, LE);
        new DataView(outerTag.buffer).setUint32(4, innerSize, LE);
        chunks.push(outerTag, flagsEl, dimsEl, nameEl, dataEl);
    }
    const hdr = new Uint8Array(128);
    const desc = enc.encode('MATLAB 5.0 MAT-file, PinMAME Workbench');
    hdr.set(desc); for (let i = desc.length; i < 116; i++) hdr[i] = 0x20;
    hdr[124] = 0x00; hdr[125] = 0x01; hdr[126] = 0x49; hdr[127] = 0x4D;
    let total = 128; for (const c of chunks) total += c.byteLength;
    const out = new Uint8Array(total); out.set(hdr, 0);
    let off = 128; for (const c of chunks) { out.set(c, off); off += c.byteLength; }
    return out;
}

async function loadRomManifest() {
    try {
        const r = await fetch('roms/manifest.json');
        if (!r.ok) return;
        const list = await r.json();
        if (!Array.isArray(list) || !list.length) return;
        romSelector.innerHTML = list.map(n => `<option value="${n}">${stripExt(n)}</option>`).join('');
        romSelector.style.display = 'inline-block';
    } catch (_) {}
}

async function bootstrap() {
    await loadRomManifest();
    const masters = await discoverMasters();
    let master  = await selectMaster(masters);


    master.onDisconnect(() => {
        logToTerminal('⚡ Maître déconnecté');
    });

    const _displayRef = { current: new GottliebDisplay80B('vfdCanvas') };

    // ── Override display panel ─────────────────────────────────────────────
    {
        const overrideBtn    = document.getElementById('overrideBtn');
        const overridePanel  = document.getElementById('overridePanel');
        const ovrL1          = document.getElementById('ovrL1');
        const ovrL2          = document.getElementById('ovrL2');
        const ovrDirGroupL1  = document.getElementById('ovrDirGroupL1');
        const ovrDirGroupL2  = document.getElementById('ovrDirGroupL2');
        const ovrSpeedL1     = document.getElementById('ovrSpeedL1');
        const ovrSpeedL2     = document.getElementById('ovrSpeedL2');
        const overrideToggle = document.getElementById('overrideToggle');
        let ovrDirL1 = 'none', ovrDirL2 = 'none';

        const applyLineIfActive = (n) => {
            const display = _displayRef.current;
            if (!display._overrideActive) return;
            const text  = n === 1 ? ovrL1.value : ovrL2.value;
            const dir   = n === 1 ? ovrDirL1 : ovrDirL2;
            const speed = parseInt(n === 1 ? ovrSpeedL1.value : ovrSpeedL2.value);
            display._enableOverrideLine(n, text, dir, speed, false);
        };

        overrideBtn.addEventListener('click', () => {
            const open = overridePanel.style.display !== 'none';
            overridePanel.style.display = open ? 'none' : 'flex';
            overrideBtn.classList.toggle('active', !open);
        });

        const fullscreenBtn = document.getElementById('fullscreenBtn');
        fullscreenBtn.addEventListener('click', () => {
            if (!document.fullscreenElement) {
                document.documentElement.requestFullscreen();
            } else {
                document.exitFullscreen();
            }
        });
        document.addEventListener('fullscreenchange', () => {
            fullscreenBtn.textContent = document.fullscreenElement ? '✕' : '⛶';
        });

        ovrDirGroupL1.querySelectorAll('.mode-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                ovrDirGroupL1.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                ovrDirL1 = btn.dataset.dir;
                applyLineIfActive(1);
            });
        });

        ovrDirGroupL2.querySelectorAll('.mode-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                ovrDirGroupL2.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                ovrDirL2 = btn.dataset.dir;
                applyLineIfActive(2);
            });
        });

        ovrSpeedL1.addEventListener('change', () => applyLineIfActive(1));
        ovrSpeedL2.addEventListener('change', () => applyLineIfActive(2));
        ovrL1.addEventListener('input', () => applyLineIfActive(1));
        ovrL2.addEventListener('input', () => applyLineIfActive(2));

        overrideToggle.addEventListener('click', () => {
            const display = _displayRef.current;
            if (display._overrideActive) {
                display.disableOverride();
                overrideToggle.textContent = '▶ Activer';
                overrideToggle.classList.remove('active');
            } else {
                display._overrideActive = true;
                display._enableOverrideLine(1, ovrL1.value, ovrDirL1, parseInt(ovrSpeedL1.value), true);
                display._enableOverrideLine(2, ovrL2.value, ovrDirL2, parseInt(ovrSpeedL2.value), true);
                overrideToggle.textContent = '⏹ Désactiver';
                overrideToggle.classList.add('active');
            }
        });
    }

    _masterRef.current = master;
    _masterRef.isLocal = master.isLocal;
    _audioMaster = master;
    connectMaster(master, _displayRef);
    window._masterRef = _masterRef;

    window.setAudioMix = (chip, dac) => _masterRef.current?.send(`@audio:chip=${chip}&dac=${dac}`);
    window.setAudioSep = (s)         => _masterRef.current?.send(`@audio:sep=${s ? 1 : 0}`);
    window.startCapture = () => _masterRef.current?.send('@capture:action=start');
    window.stopCapture  = () => _masterRef.current?.send('@capture:action=stop');

    window._onScopeReady?.(master);

    master.onCapture((d) => {
        const bytes = matWrite({ ym_L: d.ym_L, ym_R: d.ym_R, dac: d.dac });
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
        const a = document.createElement('a');
        a.href = url; a.download = `capture_${Date.now()}.mat`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        logToTerminal(`✅ Capture ${d.ym_L.length} samples téléchargée`);
        window.dispatchEvent(new Event('captureComplete'));
    });

    // Déverrouillage AudioContext sur gesture — nécessaire pour le mode local.
    // Le mode BLE a son propre AudioContext déjà déverrouillé dans createBleCentralTransport.
    const audioUnlock = () => unlockAudio();
    // touchend + pointerdown + click pour couvrir iOS Safari, Android Chrome et desktop
    document.addEventListener('touchend',    audioUnlock, { passive: true, once: false });
    document.addEventListener('pointerdown', audioUnlock, { passive: true, once: false });
    document.addEventListener('click',       audioUnlock, { passive: true, once: false });

    buildSwitchGrid(master);
    buildSoundGrid(master);
    buildDipSwitches(master);
    buildLampGrid();
    buildSolGrid();

    // Défini après switchToMaster — passé lazily via wrapper
    let restartLocalEmulator = null;
    setupSystemHandlers(master.isLocal ? () => restartLocalEmulator?.() : null);

    // ── Sélecteur de mode ─────────────────────────────────────────────────────
    let currentMode = 'local'; // 'local' | 'node' | 'ble'
    const btnLocal = document.getElementById('modeLocal');
    const btnNode  = document.getElementById('modeNode');
    const btnBle   = document.getElementById('modeBle');

    function updateModeSelector() {
        [btnLocal, btnNode, btnBle].forEach(b => b?.classList.remove('active'));
        ({ local: btnLocal, node: btnNode, ble: btnBle })[currentMode]?.classList.add('active');
    }

    async function switchToMaster(newMaster, type, rebuildUI = true) {
        const modeLabel = { local: '🖥 Local', node: '🌐 Node WS', ble: '🔵 BLE' };
        logToTerminal(`⚙️ Mode : ${modeLabel[type] || type}`);
        master.disconnect?.();
        master = newMaster;
        _masterRef.current = newMaster;
        _masterRef.isLocal = (type === 'local');
        _audioMaster = newMaster;
        connectMaster(newMaster, _displayRef);
        if (!newMaster.isLocal) newMaster.send('@connect:input=1&display=1&driver=1');
        window._onScopeReady?.(newMaster);
        if (document.getElementById('scopeOverlay')?.style.display !== 'none') newMaster.send('@scope:on=1');
        if (type === 'node') {
            const url = newMaster._reconnectUrl;
            newMaster.onDisconnect(async () => {
                while (currentMode === 'node') {
                    await new Promise(r => setTimeout(r, 2000));
                    if (currentMode !== 'node') return;
                    const nm = await trySerialMaster(url);
                    if (nm) { nm._reconnectUrl = url; await switchToMaster(nm, 'node', false); return; }
                }
            });
        }
        if (rebuildUI) {
            buildSwitchGrid();
            buildSoundGrid();
            buildDipSwitches();
        }
        currentMode = type;
        updateModeSelector();
    }

    async function goLocal() {
        const newPort = await createWorkerTransport();
        await switchToMaster(new SerialMaster(newPort), 'local');
        romSelector.style.display = 'none';
        romSelector.innerHTML = '';
        await loadRomManifest();
    }

    restartLocalEmulator = async () => {
        if (_masterRef.current?._reconnectUrl) return;
        logToTerminal('🔄 Redémarrage émulateur local');
        const newPort = await createWorkerTransport();
        await switchToMaster(new SerialMaster(newPort), 'local', false);
        buildSwitchGrid(); buildSoundGrid(); buildDipSwitches();
    };

    // Bouton LOCAL — revenir en émulation locale
    if (btnLocal) btnLocal.onclick = () => { if (currentMode !== 'local') goLocal(); };

    // ── Bouton NODE ──────────────────────────────────────────────────────────
    async function probeWs(url) {
        return new Promise(resolve => {
            let ws, resolved = false;
            const done = ok => {
                if (resolved) return; resolved = true;
                clearTimeout(t); try { ws?.close(); } catch {} resolve(ok);
            };
            const t = setTimeout(() => done(false), 1500);
            try { ws = new WebSocket(url); } catch { done(false); return; }
            ws.onmessage = e => { if (e.data.trim().startsWith('@master:')) done(true); };
            ws.onerror   = () => done(false);
            ws.onclose   = () => done(false);
        });
    }

    if (btnNode) {
        // BLE non supporté → cacher le bouton BLE définitivement
        if (!navigator.bluetooth && btnBle) btnBle.style.display = 'none';

        btnNode.onclick = async () => {
            if (currentMode === 'node') { await goLocal(); return; }
            btnNode.disabled = true;
            let connected = false;
            for (const url of WS_CANDIDATES) {
                const m = await trySerialMaster(url);
                if (m) {
                    m._reconnectUrl = url;
                    await switchToMaster(m, 'node');
                    btnNode.disabled = false;
                    connected = true; break;
                }
            }
            if (!connected) btnNode.disabled = false;
        };

        // Sonde périodique — affiche/masque le bouton WS selon disponibilité du serveur
        // Sur HTTPS, ws:// est du contenu mixte → Chrome bloque et désactive Web Bluetooth
        if (location.protocol === 'https:') {
            btnNode.style.display = 'none';
        } else {
            (async () => {
                while (true) {
                    if (currentMode !== 'node') {
                        let found = false;
                        for (const url of WS_CANDIDATES) {
                            if (await probeWs(url)) { found = true; break; }
                        }
                        btnNode.style.display = found ? '' : 'none';
                    }
                    await new Promise(r => setTimeout(r, 2000));
                }
            })();
        }
    }

    // ── Bouton BLE ───────────────────────────────────────────────────────────
    if (btnBle && navigator.bluetooth) {
        btnBle.disabled = false;
        btnBle.onclick = async () => {
            if (currentMode === 'ble') { await goLocal(); return; }
            btnBle.disabled = true;
            try {
                const port = await createBleCentralTransport();
                const bleM = new SerialMaster(port);
                await switchToMaster(bleM, 'ble');
                btnBle.disabled = false;
                bleM.onDisconnect(() => {
                    btnBle.disabled = false;
                    if (currentMode === 'ble') goLocal();
                });
            } catch {
                btnBle.disabled = false;
            }
        };
    }
}

bootstrap();
