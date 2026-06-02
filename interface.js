// interface.js
// Browser UI — découverte de maîtres (WebSerial ou Worker local), sélection, connexion

// ═══════════════════════════════════════════════════════════════════════════════
// MAÎTRES
// Un maître parle le protocole texte ligne par ligne :
//   Reçoit (browser → maître) : @set:  @dip:  @sound:  @audio:
//   Émet   (maître → browser) : !set:  !lamp:  !display:  @status:
// ═══════════════════════════════════════════════════════════════════════════════

class WorkerMaster {
    constructor() {
        this._worker = new Worker('runtime.js');
        this._callbacks = [];
        this._worker.onmessage = (e) => {
            const msg = e.data;
            if (msg.channel === 'audio') {
                for (const cb of this._callbacks) cb(msg); // { channel:'audio', left, right }
            } else if (msg.line) {
                for (const cb of this._callbacks) cb(msg.line);
            }
        };
    }
    send(line) { this._worker.postMessage({ channel: 'input', line }); }
    onMessage(cb) { this._callbacks.push(cb); }
    get name() { return 'runtime (local)'; }
}

async function* readSerialLines(port) {
    const decoder = new TextDecoder();
    let buffer = '';
    const reader = port.readable.getReader();
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let nl;
            while ((nl = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, nl).trim();
                buffer = buffer.slice(nl + 1);
                if (line) yield line;
            }
        }
    } finally { reader.releaseLock(); }
}

class SerialMaster {
    constructor(port, name) {
        this._port = port;
        this._name = name;
        this._writer = null;
        this._callbacks = [];
    }
    async start() {
        this._writer = this._port.writable.getWriter();
        (async () => {
            try {
                for await (const line of readSerialLines(this._port)) {
                    for (const cb of this._callbacks) cb(line);
                }
            } catch { console.warn(`[SerialMaster] ${this._name} déconnecté`); }
        })();
    }
    send(line) {
        if (this._writer) this._writer.write(new TextEncoder().encode(line + '\n')).catch(() => {});
    }
    onMessage(cb) { this._callbacks.push(cb); }
    get name() { return this._name; }
}

// Lit la 1re ligne d'un port pour identifier le maître : @master:name=xxx&version=1
async function readMasterHandshake(port) {
    try { await port.open({ baudRate: 115200 }); } catch { if (!port.readable) return null; }
    const decoder = new TextDecoder();
    let buf = '';
    const reader = port.readable.getReader();
    const deadline = Date.now() + 2000;
    try {
        while (Date.now() < deadline) {
            const timeout = new Promise(r => setTimeout(() => r({ value: null, done: true }), 300));
            const { value, done } = await Promise.race([reader.read(), timeout]);
            if (done || !value) break;
            buf += decoder.decode(value, { stream: true });
            const nl = buf.indexOf('\n');
            if (nl !== -1) {
                const line = buf.slice(0, nl).trim();
                if (line.startsWith('@master:')) {
                    return new URLSearchParams(line.slice(8)).get('name') || 'maître série';
                }
                break;
            }
        }
    } finally { reader.releaseLock(); }
    return null;
}

async function discoverMasters() {
    const masters = [];
    if (typeof navigator !== 'undefined' && navigator.serial) {
        for (const port of await navigator.serial.getPorts()) {
            const name = await readMasterHandshake(port);
            if (name) masters.push(new SerialMaster(port, name));
        }
    }
    masters.push(new WorkerMaster()); // toujours disponible en dernier recours
    return masters;
}

async function requestSerialMaster() {
    if (!navigator.serial) throw new Error('WebSerial non disponible');
    const port = await navigator.serial.requestPort();
    const name = await readMasterHandshake(port);
    if (!name) throw new Error('Appareil non reconnu comme maître');
    return new SerialMaster(port, name);
}

// Sélectionne automatiquement si un seul maître, sinon affiche un sélecteur
function selectMaster(masters) {
    if (masters.length === 1) return Promise.resolve(masters[0]);
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
            btn.onclick = () => { overlay.remove(); resolve(m); };
            overlay.appendChild(btn);
        }
        document.body.appendChild(overlay);
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// AFFICHEUR GOTTLIEB 14 SEGMENTS
// ═══════════════════════════════════════════════════════════════════════════════

class GottliebDisplayEmulator {
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        if (!this.canvas) throw new Error(`Canvas '${canvasId}' introuvable`);
        this.ctx = this.canvas.getContext('2d');
        this.CHAR_WIDTH = 40; this.CHAR_HEIGHT = 70; this.SPACING = 15;
        this.vfdCells = new Uint16Array(40);
        this.cursorPosition = 0;
        this.ascii2gottlieb = new Uint16Array([
            0x0000,0x0000,0x0000,0x0000,0x0000,0x0000,0x0000,0x0000,
            0x0000,0x0000,0x0000,0x0000,0x0000,0x0000,0x0000,0x0000,
            0x0000,0x0000,0x0000,0x0000,0x0000,0x0000,0x0000,0x0000,
            0x0000,0x0000,0x0000,0x0000,0x0000,0x0000,0x0000,0x0000,
            0x0000,0x000c,0x0202,0x12bc,0x298d,0x1248,0x2af5,0x0400,
            0x2400,0x0900,0x3f3f,0x0b0b,0x0000,0x0909,0x0000,0x2100,
            0x003f,0x0006,0x09db,0x09cf,0x0966,0x09ed,0x09fd,0x0007,
            0x09ff,0x09ef,0x0000,0x0000,0x2400,0x0909,0x0900,0x2203,
            0x003f,0x09f7,0x2a0f,0x0039,0x220f,0x0979,0x0971,0x01bd,
            0x09f6,0x2209,0x001e,0x2470,0x0038,0x0536,0x1136,0x003f,
            0x09f3,0x103f,0x19f3,0x09ed,0x2201,0x003e,0x4430,0x5036,
            0x5500,0x2500,0x4409,0x0039,0x4400,0x000f,0x0000,0x0008,
            0x0100,0x09f7,0x2a0f,0x0039,0x220f,0x0979,0x0971,0x01bd,
            0x09f6,0x2209,0x001e,0x2470,0x0038,0x0536,0x1136,0x003f,
            0x09f3,0x103f,0x19f3,0x09ed,0x2201,0x003e,0x4430,0x5036,
            0x5500,0x2500,0x4409,0x0000,0x0000,0x0000,0x0000
        ]);
        this._startRenderLoop();
    }

    parseCommand(cmd) {
        if (!cmd || !cmd.startsWith('!display:')) return;
        const params = new URLSearchParams(cmd.slice(9));
        switch (params.get('action')) {
            case 'raw': {
                const data = params.get('data') || '';
                for (let i = 0; i < 40; i++)
                    this.vfdCells[i] = parseInt(data.slice(i * 4, i * 4 + 4), 16) || 0;
                break;
            }
            case 'clear': this.vfdCells.fill(0); this.cursorPosition = 0; break;
            case 'move': {
                const p = parseInt(params.get('pos'), 10);
                if (p >= 0 && p < 40) this.cursorPosition = p;
                break;
            }
            case 'write': {
                const posParam = params.get('pos');
                if (posParam !== null) this.cursorPosition = parseInt(posParam, 10);
                const text = params.get('text') || '';
                for (let i = 0; i < text.length && this.cursorPosition < 40; i++) {
                    const code = text.charCodeAt(i);
                    let mask = this.ascii2gottlieb[code & 0x7F];
                    if (code & 0x80) mask |= 0x8000;
                    this.vfdCells[this.cursorPosition++] = mask;
                }
                break;
            }
        }
    }

    _drawSegment(x, y, mask) {
        const ctx = this.ctx, w = this.CHAR_WIDTH, h = this.CHAR_HEIGHT, m = h / 2, hw = w / 2;
        ctx.save(); ctx.translate(x, y); ctx.transform(1, 0, -0.15, 1, 0, 0);
        ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        const seg = (bit, fn) => {
            ctx.strokeStyle = (mask & bit) ? '#00ffff' : '#101a1a';
            ctx.shadowBlur  = (mask & bit) ? 10 : 0;
            ctx.shadowColor = '#00ffff';
            ctx.beginPath(); fn(); ctx.stroke();
        };
        seg(0x0001,()=>{ctx.moveTo(2,0);ctx.lineTo(w-2,0)});
        seg(0x0002,()=>{ctx.moveTo(w,2);ctx.lineTo(w,m-2)});
        seg(0x0004,()=>{ctx.moveTo(w,m+2);ctx.lineTo(w,h-2)});
        seg(0x0008,()=>{ctx.moveTo(2,h);ctx.lineTo(w-2,h)});
        seg(0x0010,()=>{ctx.moveTo(0,m+2);ctx.lineTo(0,h-2)});
        seg(0x0020,()=>{ctx.moveTo(0,2);ctx.lineTo(0,m-2)});
        seg(0x0040,()=>{ctx.moveTo(2,m);ctx.lineTo(hw-2,m)});
        seg(0x0800,()=>{ctx.moveTo(hw+2,m);ctx.lineTo(w-2,m)});
        seg(0x0100,()=>{ctx.moveTo(2,2);ctx.lineTo(hw-2,m-2)});
        seg(0x0200,()=>{ctx.moveTo(hw,2);ctx.lineTo(hw,m-3)});
        seg(0x0400,()=>{ctx.moveTo(w-2,2);ctx.lineTo(hw+2,m-2)});
        seg(0x4000,()=>{ctx.moveTo(2,h-2);ctx.lineTo(hw-2,m+2)});
        seg(0x2000,()=>{ctx.moveTo(hw,h-4);ctx.lineTo(hw,m+3)});
        seg(0x1000,()=>{ctx.moveTo(w-2,h-2);ctx.lineTo(hw+2,m+2)});
        seg(0x0080,()=>{ctx.moveTo(w+2,h);ctx.lineTo(w+6,h+8)});
        seg(0x8000,()=>{ctx.arc(w+4,h,2,0,Math.PI*2)});
        ctx.restore();
    }

    _render() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        for (let i = 0; i < 20; i++) {
            this._drawSegment(30 + i * (this.CHAR_WIDTH + this.SPACING), 40,  this.vfdCells[i]);
            this._drawSegment(30 + i * (this.CHAR_WIDTH + this.SPACING), 140, this.vfdCells[20 + i]);
        }
    }

    _startRenderLoop() {
        const loop = () => { this._render(); requestAnimationFrame(loop); };
        requestAnimationFrame(loop);
    }
}

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
const romNameDisplay = document.getElementById('romNameDisplay');
const clearRomBtn    = document.getElementById('clearRomBtn');
const rebootBtn      = document.getElementById('rebootBtn');
const audioLed       = document.getElementById('audio-led');

// ── État ──────────────────────────────────────────────────────────────────────

const swCells    = [], lampCells = [], solCells = [], dipToggles = [];
const userSwitchStates = new Array(80).fill(false);
const ancienEtatLampesIndividuelles = new Uint8Array(96).fill(0);

let userDipStates = new Array(32).fill(false);
try { const s = localStorage.getItem('pinmame_dips'); if (s) userDipStates = JSON.parse(s); } catch (_) {}

const COIN_ID = 27, START_ID = 47, TEST_ID = 7;

// ── Audio ─────────────────────────────────────────────────────────────────────

const RING_BUFFER_SIZE = 131072;
const ringBufferL = new Float32Array(RING_BUFFER_SIZE);
const ringBufferR = new Float32Array(RING_BUFFER_SIZE);
let audioWritePtr = 0, audioReadPtr = 0;
let lastSampleL = 0, lastSampleR = 0;
let audioCtx = null, audioNode = null;
let isBufferWarming = false;

function feedAudioRingBuffer(left, right) {
    for (let i = 0; i < left.length; i++) {
        ringBufferL[audioWritePtr] = left[i];
        ringBufferR[audioWritePtr] = right[i];
        audioWritePtr = (audioWritePtr + 1) % RING_BUFFER_SIZE;
    }
}

function resetAudioRead() {
    audioReadPtr = audioWritePtr;
    isBufferWarming = true;
}

function unlockAudio(master) {
    if (audioCtx) {
        if (audioCtx.state === 'suspended') audioCtx.resume().then(resetAudioRead).catch(() => {});
        return;
    }
    try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 });
        logToTerminal(`📊 Audio: ${audioCtx.sampleRate}Hz, état: ${audioCtx.state}`);
        resetAudioRead();
        if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});

        audioNode = audioCtx.createScriptProcessor(4096, 1, 2);
        const kick = audioCtx.createOscillator(); kick.frequency.value = 0;
        kick.connect(audioNode); kick.start(0);
        setTimeout(() => { try { kick.stop(); } catch (_) {} }, 500);

        audioNode.onaudioprocess = function(e) {
            const outL = e.outputBuffer.getChannelData(0);
            const outR = e.outputBuffer.getChannelData(1);
            const distance = (audioWritePtr - audioReadPtr + RING_BUFFER_SIZE) % RING_BUFFER_SIZE;
            if (master) master.send(`@audio:distance=${distance}`);
            if (isBufferWarming) {
                if (distance >= 4096) isBufferWarming = false;
                for (let i = 0; i < outL.length; i++) outL[i] = outR[i] = 0;
                return;
            }
            for (let i = 0; i < outL.length; i++) {
                if (audioReadPtr !== audioWritePtr) {
                    lastSampleL = ringBufferL[audioReadPtr];
                    lastSampleR = ringBufferR[audioReadPtr];
                    audioReadPtr = (audioReadPtr + 1) % RING_BUFFER_SIZE;
                } else { lastSampleL *= 0.90; lastSampleR *= 0.90; }
                outL[i] = lastSampleL; outR[i] = lastSampleR;
            }
            if (distance > 24576) audioReadPtr = (audioWritePtr - 8192 + RING_BUFFER_SIZE) % RING_BUFFER_SIZE;
            audioLed.classList.toggle('active', distance > 512);
        };
        audioNode.connect(audioCtx.destination);
        logToTerminal('🔊 Flux audio connecté.');
    } catch (err) { logToTerminal(`❌ Erreur audio: ${err.message}`); }
}

// ── Logs ──────────────────────────────────────────────────────────────────────

function logToTerminal(msg) { termEl.textContent += '\n' + msg; termEl.scrollTop = termEl.scrollHeight; }

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

// ── Statut maître ─────────────────────────────────────────────────────────────

function updateMasterStatus(master) {
    const el = document.getElementById('connectorStatus');
    if (!el) return;
    const isWorker = master instanceof WorkerMaster;
    el.innerHTML = isWorker
        ? '<span style="color:#9d4edd">⚙ ÉMULATION LOCALE</span>'
        : `<span style="color:#00ff44">🔌 ${master.name}</span>`;
}

// ── Handlers messages maître ──────────────────────────────────────────────────

function handleDriverLine(line) {
    if (line.startsWith('!lamp:')) {
        const p = new URLSearchParams(line.slice(6));
        const col = parseInt(p.get('col')), mask = parseInt(p.get('mask'));
        for (let row = 0; row < 8; row++) {
            const lampId = col * 8 + row, state = (mask >> row) & 1;
            if (lampCells[lampId]) lampCells[lampId].classList.toggle('lamp-on', state === 1);
            if (state !== ancienEtatLampesIndividuelles[lampId]) {
                logHardwareTraffic('MASTER', 'DRIVER', `!lamp:id=${lampId+1}&state=${state}`, 'DRIVER');
                ancienEtatLampesIndividuelles[lampId] = state;
            }
        }
    } else if (line.startsWith('!set:')) {
        const p = new URLSearchParams(line.slice(5));
        const id = parseInt(p.get('id')), state = parseInt(p.get('state'));
        if (solCells[id]) solCells[id].classList.toggle('sol-on', state === 1);
        logHardwareTraffic('MASTER', 'DRIVER', line, 'DRIVER');
    }
}

function handleStatusLine(line) {
    if (!line.startsWith('@status:')) return;
    const p = new URLSearchParams(line.slice(8)), state = p.get('state');
    if (state === 'ready') {
        const rom = p.get('rom') || 'unknown';
        statusEl.textContent = `🟢 PinMAME Workbench V200.28 — ${rom}`;
        statusEl.style.color = '#00ffcc';
        romNameDisplay.textContent = sessionStorage.getItem('custom_rom_filename') || `${rom} (Interne)`;
        if (sessionStorage.getItem('custom_rom_bytes')) {
            romNameDisplay.style.color = 'var(--neon-green)';
            clearRomBtn.style.display = 'inline-block';
        }
    } else if (state === 'loading') {
        statusEl.textContent = '🟡 Chargement...'; statusEl.style.color = '';
    }
}

// ── Connexion au maître ───────────────────────────────────────────────────────

function connectMaster(master, display) {
    master.onMessage((msg) => {
        if (msg && typeof msg === 'object' && msg.channel === 'audio') {
            feedAudioRingBuffer(msg.left, msg.right);
            return;
        }
        const line = typeof msg === 'string' ? msg : null;
        if (!line) return;
        if (line.startsWith('!display:')) {
            display.parseCommand(line);
            logHardwareTraffic('MASTER', 'DISPLAY', line, 'DISPLAY');
        } else if (line.startsWith('!set:') || line.startsWith('!lamp:')) {
            handleDriverLine(line);
        } else if (line.startsWith('@status:')) {
            handleStatusLine(line);
        }
    });
}

// ── Grilles ───────────────────────────────────────────────────────────────────

function buildSwitchGrid(master) {
    const grid = document.getElementById('swGrid');
    for (let i = 0; i < 80; i++) {
        const cell = document.createElement('div'); cell.className = 'cell';
        cell.title = SWITCH_DICTIONARY[i] || `Contact ${String(i).padStart(2,'0')}`;
        cell.innerHTML = `<span class="sw-num-text">${String(i).padStart(2,'0')}</span><svg class="mini-loader-svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"></circle></svg>`;
        let holdTimer = null, isLocked = false, isPressed = false;
        const notify = (state) => {
            userSwitchStates[i] = state === 1;
            logHardwareTraffic('INPUT', 'MASTER', `@set:id=${i}&state=${state}`, 'INPUT');
            master.send(`@set:id=${i}&state=${state}`);
        };
        const down = (e) => {
            if (e.type.startsWith('touch')) e.preventDefault();
            if (isLocked) { isLocked = false; cell.classList.remove('sw-locked'); notify(0); isPressed = false; clearTimeout(holdTimer); return; }
            if (!isPressed) {
                isPressed = true; notify(1);
                cell.classList.remove('sw-user'); void cell.offsetWidth; cell.classList.add('sw-user');
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

function buildSoundGrid(master) {
    const grid = document.getElementById('cmd-grid');
    for (let i = 1; i <= 64; i++) {
        const cell = document.createElement('div'); cell.className = 'cell cell-cmd';
        cell.innerHTML = `<div class="cell-cmd-num">${String(i).padStart(2,'0')}</div><div class="cell-cmd-desc">${SOUND_DICTIONARY[i]||'SFX'}</div>`;
        const trigger = (e) => {
            if (e.type.startsWith('touch')) e.preventDefault();
            cell.classList.add('cmd-active'); setTimeout(() => cell.classList.remove('cmd-active'), 120);
            master.send(`@sound:cmd=${i}`);
        };
        cell.addEventListener('mousedown', trigger); cell.addEventListener('touchstart', trigger, { passive:false });
        grid.appendChild(cell);
    }
}

function buildDipSwitches(master) {
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
                master.send(`@dip:id=${dipId}&state=${userDipStates[dipId]?1:0}`);
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
    for (let i = 0; i < 96; i++) { const c = document.createElement('div'); c.className='cell'; c.textContent='L'+String(i+1).padStart(2,'0'); grid.appendChild(c); lampCells.push(c); }
}

function buildSolGrid() {
    const grid = document.getElementById('solGrid');
    for (let i = 0; i < 32; i++) { const c = document.createElement('div'); c.className='cell'; c.textContent='S'+String(i+1).padStart(2,'0'); grid.appendChild(c); solCells.push(c); }
}

function setupSystemHandlers(master) {
    rebootBtn.onclick = () => location.reload();
    clearRomBtn.onclick = () => { sessionStorage.removeItem('custom_rom_bytes'); sessionStorage.removeItem('custom_rom_filename'); location.reload(); };
    romUploader.onchange = (e) => {
        const file = e.target.files[0]; if (!file) return;
        const reader = new FileReader();
        reader.onload = (evt) => {
            const bytes = new Uint8Array(evt.target.result); let bin = '';
            for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
            sessionStorage.setItem('custom_rom_bytes', btoa(bin)); sessionStorage.setItem('custom_rom_filename', file.name); location.reload();
        };
        reader.readAsArrayBuffer(file);
    };
    const attachMacro = (btnId, id) => {
        const btn = document.getElementById(btnId); if (!btn) return;
        const down = (e) => { if (e.type.startsWith('touch')) e.preventDefault(); swCells[id]?.classList.add('sw-user');    master.send(`@set:id=${id}&state=1`); };
        const up   = (e) => { if (e.type.startsWith('touch')) e.preventDefault(); swCells[id]?.classList.remove('sw-user'); master.send(`@set:id=${id}&state=0`); };
        btn.addEventListener('mousedown', down); btn.addEventListener('touchstart', down, { passive:false });
        btn.addEventListener('mouseup',   up);   btn.addEventListener('touchend',   up,   { passive:false });
        btn.addEventListener('mouseleave', up);  btn.addEventListener('touchcancel', up,  { passive:false });
    };
    attachMacro('coinBtn', COIN_ID); attachMacro('startBtn', START_ID); attachMacro('testBtn', TEST_ID);

    // Bouton connexion d'un nouveau maître série
    const connectBtn = document.getElementById('connectHardwareBtn');
    if (connectBtn && navigator.serial) {
        connectBtn.style.display = 'inline-block';
        connectBtn.onclick = async () => {
            try {
                const newMaster = await requestSerialMaster();
                logToTerminal(`🔌 Nouveau maître : ${newMaster.name}`);
            } catch (err) { logToTerminal(`❌ ${err.message}`); }
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// BOOTSTRAP
// ═══════════════════════════════════════════════════════════════════════════════

async function bootstrap() {
    const masters = await discoverMasters();
    const master  = await selectMaster(masters);

    if (master instanceof SerialMaster) await master.start();

    updateMasterStatus(master);

    const display = new GottliebDisplayEmulator('vfdCanvas');
    connectMaster(master, display);

    const audioUnlock = () => unlockAudio(master);
    document.body.addEventListener('click',      audioUnlock, { passive: true });
    document.body.addEventListener('touchstart', audioUnlock, { passive: true });
    setTimeout(audioUnlock, 500);

    buildSwitchGrid(master);
    buildSoundGrid(master);
    buildDipSwitches(master);
    buildLampGrid();
    buildSolGrid();
    setupSystemHandlers(master);
}

bootstrap();
