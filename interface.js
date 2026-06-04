// interface.js
// Browser UI — découverte de maîtres (WebSerial ou Worker local), sélection, connexion

// ═══════════════════════════════════════════════════════════════════════════════
// MAÎTRES
// Un maître parle le protocole texte ligne par ligne :
//   Reçoit (browser → maître) : @set:  @dip:  @sound:  @audio:
//   Émet   (maître → browser) : !set:  !lamp:  !display:  @status:
// ═══════════════════════════════════════════════════════════════════════════════

// ─── PORTS ───────────────────────────────────────────────────────────────────
// Un port expose : { readable: ReadableStream<string>, writable: WritableStream<string>, name, isLocal? }
// Le port Worker ajoute : onAudio(cb) — cb(left, right) — canal audio séparé du texte

async function createWorkerPort() {
    const resp = await fetch('tilt');
    const blob = new Blob([await resp.text()], { type: 'application/javascript' });
    const worker = new Worker(URL.createObjectURL(blob));
    let audioCallback = null;

    const { readable, writable: innerWritable } = new TransformStream();
    const lineWriter = innerWritable.getWriter();

    worker.onmessage = ({ data: msg }) => {
        if (msg.channel === 'audio') {
            audioCallback?.(msg.left, msg.right);
        } else if (msg.line) {
            lineWriter.write(msg.line).catch(() => {});
        }
    };

    const writable = new WritableStream({
        write(line) { worker.postMessage({ channel: 'input', line }); }
    });

    // sessionStorage n'est pas accessible depuis un Worker — on lit ici et on envoie
    const customRomBytes = sessionStorage.getItem('custom_rom_bytes') || null;
    const customRomName  = sessionStorage.getItem('custom_rom_filename')
        || new URLSearchParams(location.search).get('rom')
        || null;
    worker.postMessage({ type: 'INIT_ENGINE', payload: { customRomBytes, customRomName, baseUrl: location.href } });

    return {
        readable, writable,
        name: 'Exécution locale (navigateur)', isLocal: true,
        terminate()   { worker.terminate(); },
        disconnect()  { worker.terminate(); },
        onAudio(cb) { audioCallback = cb; }
    };
}

function createWebSocketPort(ws, name) {
    const { readable, writable: innerWritable } = new TransformStream();
    const lineWriter = innerWritable.getWriter();

    ws.onmessage = ({ data }) => lineWriter.write(data.trim()).catch(() => {});
    ws.onclose   = ()        => lineWriter.close().catch(() => {});

    const writable = new WritableStream({
        write(line) { if (ws.readyState === WebSocket.OPEN) ws.send(line); }
    });

    return {
        readable, writable, name,
        disconnect() { try { ws.close(); } catch {} }
    };
}

// UUIDs doivent correspondre à ceux de runtime.js (bleno)
const BLE_SVC_UUID = 'ab120001-b5a3-f393-e0a9-e50e24dcca9e';
const BLE_OUT_UUID = 'ab120002-b5a3-f393-e0a9-e50e24dcca9e'; // notify → browser
const BLE_IN_UUID  = 'ab120003-b5a3-f393-e0a9-e50e24dcca9e'; // write  ← browser

async function createBluetoothPort() {
    const device = await navigator.bluetooth.requestDevice({
        filters: [{ name: 'PinMAME' }],
        optionalServices: [BLE_SVC_UUID]
    });

    const { readable, writable: innerWritable } = new TransformStream();
    const lineWriter = innerWritable.getWriter();
    const decoder = new TextDecoder();
    let fragBuf = '';
    let inChar  = null;

    function onNotification(e) {
        const data   = new Uint8Array(e.target.value.buffer);
        const isLast = data[0] === 0x01;
        fragBuf += decoder.decode(data.slice(1));
        if (isLast) {
            for (const line of fragBuf.split('\n')) {
                const l = line.trim();
                if (l) lineWriter.write(l).catch(() => {});
            }
            fragBuf = '';
        }
    }

    async function gattConnect() {
        const server  = await device.gatt.connect();
        const service = await server.getPrimaryService(BLE_SVC_UUID);
        const out     = await service.getCharacteristic(BLE_OUT_UUID);
        inChar        = await service.getCharacteristic(BLE_IN_UUID);
        out.addEventListener('characteristicvaluechanged', onNotification);
        await out.startNotifications();
    }

    device.addEventListener('gattserverdisconnected', async () => {
        // Reconnexion automatique après reboot/changement de ROM
        for (let i = 0; i < 10; i++) {
            await new Promise(r => setTimeout(r, 1000));
            try {
                await gattConnect();
                // Redemande l'état courant au serveur
                await inChar.writeValueWithoutResponse(
                    new TextEncoder().encode('@connect:input=1&display=1&driver=1')
                );
                return;
            } catch {}
        }
        lineWriter.close().catch(() => {});
    });

    await gattConnect();

    const writable = new WritableStream({
        write(line) {
            return inChar.writeValueWithoutResponse(new TextEncoder().encode(line));
        }
    });

    return {
        readable, writable, name: device.name || 'PinMAME BLE',
        disconnect() { try { device.gatt.disconnect(); } catch {} }
    };
}

// ─── MAÎTRE ──────────────────────────────────────────────────────────────────
// Transport agnostique — même classe pour Worker, WebSocket, ou futur WebSerial

class SerialMaster {
    constructor(port) {
        this._port   = port;
        this._writer = port.writable.getWriter();
        this._callbacks = [];
        this.isLocal = port.isLocal || false;

        if (port.onAudio) port.onAudio((l, r) => this._audioCallback?.(l, r));
        this._pump(port.readable);
    }

    async _pump(readable) {
        const reader = readable.getReader();
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                for (const cb of this._callbacks) cb(value);
            }
        } catch (e) { console.warn('[SerialMaster]', e); }
        finally { reader.releaseLock(); this._disconnectCallback?.(); }
    }

    send(line)         { this._writer.write(line).catch(() => {}); }
    onMessage(cb)      { this._callbacks.push(cb); }
    onAudio(cb)        { this._audioCallback = cb; }
    onDisconnect(cb)   { this._disconnectCallback = cb; }
    get name()         { return this._port.name; }
}

// Tente une connexion WebSocket, attend le handshake @master:name=...
// Retourne un SerialMaster ou null au bout de 1,5 s
async function trySerialMaster(url) {
    return new Promise((resolve) => {
        let ws, timer;
        const done = (result) => { clearTimeout(timer); resolve(result); };
        timer = setTimeout(() => { try { ws?.close(); } catch (_) {} done(null); }, 1500);
        try { ws = new WebSocket(url); } catch { done(null); return; }
        ws.onmessage = (e) => {
            const line = e.data.trim();
            if (line.startsWith('@master:')) {
                const name = new URLSearchParams(line.slice(8)).get('name') || url;
                const m = new SerialMaster(createWebSocketPort(ws, name));
                m._reconnectUrl = url;
                done(m);
            }
        };
        ws.onerror = () => done(null);
    });
}

// URLs candidates : localhost (ADB reverse / même machine) + Pi Zero gadget ethernet
const WS_CANDIDATES = [
    'ws://localhost:8765',
    'ws://192.168.7.2:8765',
];

const BLE_STUB   = { _ble: true,   name: 'Bluetooth — PinMAME' };
const LOCAL_STUB = { _local: true, name: 'Exécution locale (navigateur)', isLocal: true };

async function discoverMasters() {
    return [LOCAL_STUB];
}

// Crée le master effectif à partir d'un stub ou retourne le master déjà résolu
async function resolveMaster(m) {
    if (m._local) return new SerialMaster(await createWorkerPort());
    if (m._ble)   return new SerialMaster(await createBluetoothPort());
    return m;
}

// Sélection : auto-local si aucune connexion externe disponible, overlay sinon
// Le Worker n'est créé QU'APRÈS la sélection pour éviter la race condition
// où @status:state=ready arrive avant que connectMaster ait câblé onMessage.
async function selectMaster(masters) {
    const hasExternal = masters.some(m => !m.isLocal);
    if (!hasExternal) return resolveMaster(masters[0]);
    // Auto-reconnexion après reboot/ROM change : pas de menu
    if (sessionStorage.getItem('autoReconnect') === '1') {
        sessionStorage.removeItem('autoReconnect');
        const ws = masters.find(m => !m.isLocal && !m._ble && !m._local);
        if (ws) return ws;
    }
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
        this._dirty = false;
        // Source de vérité unique — ASCII → segments PinMAME
        // Bits : a=0x0001 b=0x0002 c=0x0004 d=0x0008 e=0x0010 f=0x0020
        //        g1=0x0040 g2=0x0800 i=0x0100 j=0x0200 k=0x0400
        //        l=0x1000 m=0x2000 n=0x4000 dp=0x0080
        const _a2s = {
            // Espace et ponctuation
            ' ':0x0000,'!':0x0006,'"':0x0202,'#':0x0A8D,'$':0x086D,
            '%':0x1CE8,'&':0x2AF5,'\'':0x0200,'(':0x0039,')':0x000F,
            '*':0x7F40,'+':0x2A40,',':0x4000,'-':0x0840,'.':0x0080,
            '/':0x4400,':':0x2200,';':0x4200,'<':0x1400,'=':0x0849,
            '>':0x0500,'?':0x2203,'@':0x2A3F,'[':0x0039,'\\':0x1100,
            ']':0x000F,'^':0x0500,'_':0x0008,'`':0x0100,'{':0x2240,
            '|':0x2200,'}':0x0A09,'~':0x0840,
            // Chiffres
            '0':0x003F,'1':0x0006,'2':0x085B,'3':0x084F,'4':0x0866,
            '5':0x086D,'6':0x087D,'7':0x0007,'8':0x087F,'9':0x086F,
            // Lettres majuscules
            'A':0x0877,'B':0x2A2F,'C':0x0039,'D':0x220F,'E':0x0079,
            'F':0x0071,'G':0x083D,'H':0x0876,'I':0x2209,'J':0x001E,
            'K':0x1470,'L':0x0038,'M':0x0536,'N':0x1136,'O':0x003F,
            'P':0x0873,'Q':0x103F,'R':0x1873,'S':0x086D,'T':0x2201,
            'U':0x003E,'V':0x4430,'W':0x5036,'X':0x5500,'Y':0x2500,
            'Z':0x4409,
        };
        this.ascii2gottlieb = new Uint16Array(128);
        this.gottlieb2ascii = new Map();
        for (const [ch, mask] of Object.entries(_a2s)) {
            const c = ch.charCodeAt(0);
            this.ascii2gottlieb[c] = mask;
            if (c >= 0x41 && c <= 0x5A) this.ascii2gottlieb[c + 32] = mask;
            if (!this.gottlieb2ascii.has(mask)) this.gottlieb2ascii.set(mask, ch);
        }
        this._startRenderLoop();
    }

    decodeRaw(hex) {
        let s = '';
        for (let i = 0; i < 40; i++) {
            const mask = parseInt(hex.slice(i * 4, i * 4 + 4), 16) || 0;
            if (mask === 0) { s += ' '; continue; }
            const ch = this.gottlieb2ascii.get(mask);
            s += ch !== undefined ? ch : `[${mask.toString(16)}]`;
        }
        return s;
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
        this._dirty = true;
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
        const loop = () => { if (this._dirty) { this._dirty = false; this._render(); } requestAnimationFrame(loop); };
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
const romSelector    = document.getElementById('romSelector');
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
let _audioMaster = null; // Référence mutable — mise à jour à chaque changement de master

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
            if (_audioMaster?.isLocal) _audioMaster.send(`@audio:distance=${Math.max(0, distance - 4096)}`);
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

// ── Statut maître ─────────────────────────────────────────────────────────────

function updateMasterStatus(master) {
    const el = document.getElementById('connectorStatus');
    if (!el) return;
    el.innerHTML = master.isLocal
        ? '<span style="color:#9d4edd">⚙ ÉMULATION LOCALE</span>'
        : `<span style="color:#00ff44">🔌 ${master.name}</span>`;
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

function applyCurrentRom() {
    if (!_currentRom || !romSelector) return;
    if (!romSelector.querySelector(`option[value="${_currentRom}"]`)) {
        const opt = document.createElement('option');
        opt.value = opt.textContent = _currentRom;
        romSelector.appendChild(opt);
        romSelector.style.display = 'inline-block';
    }
    romSelector.value = _currentRom;
}

function handleStatusLine(line) {
    if (!line.startsWith('@status:')) return;
    const p = new URLSearchParams(line.slice(8)), state = p.get('state');
    if (state === 'ready') {
        const rom = p.get('rom') || 'unknown';
        _currentRom = rom;
        statusEl.textContent = `🟢 PinMAME Workbench v2.3 — ${rom}`;
        statusEl.style.color = '#00ffcc';
        romNameDisplay.textContent = sessionStorage.getItem('custom_rom_filename') || `${rom} (Interne)`;
        if (sessionStorage.getItem('custom_rom_bytes')) {
            romNameDisplay.style.color = 'var(--neon-green)';
            clearRomBtn.style.display = 'inline-block';
        }
        applyCurrentRom();
    } else if (state === 'loading') {
        statusEl.textContent = '🟡 Chargement...'; statusEl.style.color = '';
    }
}

// ── Connexion au maître ───────────────────────────────────────────────────────

function connectMaster(master, display) {
    master.onAudio((left, right) => feedAudioRingBuffer(left, right));
    master.onMessage((line) => {
        if (typeof line !== 'string') return;
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
        } else if (line.startsWith('@roms:list=')) {
            const names = line.slice(11).split(',').map(decodeURIComponent).filter(Boolean);
            romSelector.innerHTML = names.map(n => `<option value="${n}">${n}</option>`).join('');
            if (romSelector.options.length) romSelector.style.display = 'inline-block';
            applyCurrentRom();
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

function setupSystemHandlers(master, restartFn) {
    const localRestart = restartFn || (() => location.reload());
    rebootBtn.onclick = () => master.isLocal ? localRestart() : master.send('@reboot:');
    clearRomBtn.onclick = () => {
        if (master.isLocal) {
            sessionStorage.removeItem('custom_rom_bytes');
            sessionStorage.removeItem('custom_rom_filename');
            localRestart();
        } else {
            master.send('@rom:name=bonebstr');
            clearRomBtn.style.display = 'none';
            romNameDisplay.textContent = 'bonebstr (Interne)';
            romNameDisplay.style.color = '';
        }
    };
    if (romSelector) {
        romSelector.onchange = () => {
            const name = romSelector.value;
            if (!name) return;
            if (master.isLocal) {
                sessionStorage.setItem('custom_rom_filename', name);
                sessionStorage.removeItem('custom_rom_bytes');
                localRestart();
            } else {
                sessionStorage.removeItem('custom_rom_bytes');
                sessionStorage.removeItem('custom_rom_filename');
                master.send(`@rom:name=${encodeURIComponent(name)}`);
                romNameDisplay.textContent = name;
                romNameDisplay.style.color = '';
                clearRomBtn.style.display = 'none';
            }
        };
    }
    romUploader.onchange = (e) => {
        const file = e.target.files[0]; if (!file) return;
        const reader = new FileReader();
        reader.onload = (evt) => {
            const bytes = new Uint8Array(evt.target.result);
            let bin = '';
            for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
            const b64 = btoa(bin);
            if (master.isLocal) {
                sessionStorage.setItem('custom_rom_bytes', b64);
                sessionStorage.setItem('custom_rom_filename', file.name);
                localRestart();
            } else {
                master.send(`@rom:name=${encodeURIComponent(file.name)}&data=${encodeURIComponent(b64)}`);
                romNameDisplay.textContent = file.name;
                romNameDisplay.style.color = 'var(--neon-green)';
                clearRomBtn.style.display = 'inline-block';
            }
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

}

// ═══════════════════════════════════════════════════════════════════════════════
// BOOTSTRAP
// ═══════════════════════════════════════════════════════════════════════════════

async function loadRomManifest() {
    try {
        const r = await fetch('roms/manifest.json');
        if (!r.ok) return;
        const list = await r.json();
        if (!Array.isArray(list) || !list.length) return;
        romSelector.innerHTML = list.map(n => `<option value="${n}">${n}</option>`).join('');
        romSelector.style.display = 'inline-block';
    } catch (_) {}
}

async function bootstrap() {
    await loadRomManifest();
    const masters = await discoverMasters();
    let master  = await selectMaster(masters);


    updateMasterStatus(master);

    master.onDisconnect(() => {
        const el = document.getElementById('connectorStatus');
        if (el) el.innerHTML = '<span style="color:#ff4444">⚡ MAÎTRE DÉCONNECTÉ — rechargez la page</span>';
        logToTerminal('⚡ Maître déconnecté');
    });

    const display = new GottliebDisplayEmulator('vfdCanvas');
    _audioMaster = master;
    connectMaster(master, display);

    // Audio local uniquement si le maître tourne dans la page (Worker)
    if (master.isLocal) {
        const audioUnlock = () => unlockAudio(master);
        document.body.addEventListener('click',      audioUnlock, { passive: true });
        document.body.addEventListener('touchstart', audioUnlock, { passive: true });
        setTimeout(audioUnlock, 500);
    }

    buildSwitchGrid(master);
    buildSoundGrid(master);
    buildDipSwitches(master);
    buildLampGrid();
    buildSolGrid();

    // Défini après switchToMaster — passé lazily via wrapper
    let restartLocalEmulator = null;
    setupSystemHandlers(master, master.isLocal ? () => restartLocalEmulator?.() : null);

    // ── Gestion des connexions ────────────────────────────────────────────────
    let currentMode = 'local'; // 'local' | 'node' | 'ble'
    const nodeBtn    = document.getElementById('nodeConnectBtn');
    const bleBtn     = document.getElementById('bleConnectBtn');
    const goLocalBtn = document.getElementById('goLocalBtn');

    function updateConnectionButtons(nodeAvailable) {
        // Bouton ↩ Local : visible seulement si mode distant actif
        if (goLocalBtn) goLocalBtn.style.display = currentMode !== 'local' ? 'inline-block' : 'none';
        // Bouton Runtime Node
        if (nodeBtn) {
            if (currentMode === 'node') {
                nodeBtn.style.display = 'inline-block';
                nodeBtn.textContent = '🖥️ Runtime Node';
                nodeBtn.style.color = '#00ff44';
                nodeBtn.disabled = true; // ↩ Local gère la déconnexion
            } else if (nodeAvailable !== undefined) {
                nodeBtn.style.display = 'inline-block';
                nodeBtn.textContent = '🖥️ Runtime Node';
                nodeBtn.style.color = '';
                nodeBtn.disabled = !nodeAvailable;
            }
        }
        // Bouton BLE
        if (bleBtn && navigator.bluetooth) {
            bleBtn.style.display = 'inline-block';
            bleBtn.textContent = currentMode === 'ble' ? '🔵 Bluetooth' : '🔵 Bluetooth';
            bleBtn.style.color = currentMode === 'ble' ? '#00ffff' : '';
            bleBtn.disabled = currentMode === 'ble'; // ↩ Local gère la déconnexion
        }
    }

    async function switchToMaster(newMaster, type, rebuildUI = true) {
        master._port?.disconnect?.();
        master = newMaster;
        _audioMaster = newMaster;
        connectMaster(newMaster, display);
        if (!newMaster.isLocal) newMaster.send('@connect:input=1&display=1&driver=1');
        setupSystemHandlers(newMaster, type === 'local' ? () => restartLocalEmulator?.() : null);
        if (rebuildUI) {
            buildSwitchGrid(newMaster);
            buildSoundGrid(newMaster);
            buildDipSwitches(newMaster);
        }
        currentMode = type;
        updateMasterStatus(newMaster);
        updateConnectionButtons();
    }

    async function goLocal() {
        const newPort = await createWorkerPort();
        await switchToMaster(new SerialMaster(newPort), 'local');
    }

    restartLocalEmulator = async () => {
        const newPort = await createWorkerPort();
        await switchToMaster(new SerialMaster(newPort), 'local', false);
        buildSwitchGrid(master);
        buildSoundGrid(master);
        buildDipSwitches(master);
    };

    // Bouton ↩ Local — retour en émulation locale depuis n'importe quel mode distant
    if (goLocalBtn) goLocalBtn.onclick = goLocal;

    // ── Bouton Runtime Node ───────────────────────────────────────────────────
    if (nodeBtn) {
        // Sonde légère : ouvre WS, vérifie handshake, ferme — sans garder la connexion
        async function probeWs(url) {
            return new Promise(resolve => {
                let ws;
                const done = ok => { clearTimeout(t); try { ws?.close(); } catch {} resolve(ok); };
                const t = setTimeout(() => done(false), 1500);
                try { ws = new WebSocket(url); } catch { done(false); return; }
                ws.onmessage = e => { if (e.data.trim().startsWith('@master:')) done(true); };
                ws.onerror = () => done(false);
            });
        }

        nodeBtn.onclick = async () => {
            if (!nodeBtn.disabled) {
                const m = await trySerialMaster(WS_CANDIDATES.find(u => u) || WS_CANDIDATES[0]);
                if (!m) return;
                // Trouver l'URL qui a répondu
                for (const url of WS_CANDIDATES) {
                    const probe = await probeWs(url);
                    if (probe) { m._reconnectUrl = url; break; }
                }
                await switchToMaster(m, 'node');
                m.onDisconnect(async () => {
                    if (currentMode !== 'node') return;
                    display.parseCommand('!display:action=clear');
                    display.parseCommand('!display:action=write&pos=4&text=' + encodeURIComponent('SERVER DOWN'));
                    display._dirty = true;
                    const el = document.getElementById('connectorStatus');
                    if (el) el.innerHTML = '<span style="color:#ffaa00">🔄 Reconnexion...</span>';
                    const url = m._reconnectUrl;
                    while (currentMode === 'node' && url) {
                        await new Promise(r => setTimeout(r, 2000));
                        const nm = await trySerialMaster(url);
                        if (nm) { nm._reconnectUrl = url; await switchToMaster(nm, 'node', false); return; }
                    }
                });
            }
        };

        // Sonde périodique légère — met à jour disponibilité du bouton sans garder de connexion
        (async () => {
            while (true) {
                if (currentMode !== 'node') {
                    let found = false;
                    for (const url of WS_CANDIDATES) {
                        if (await probeWs(url)) { found = true; break; }
                    }
                    updateConnectionButtons(found);
                }
                await new Promise(r => setTimeout(r, 4000));
            }
        })();
    }

    // ── Bouton BLE ────────────────────────────────────────────────────────────
    if (bleBtn && navigator.bluetooth) {
        updateConnectionButtons(false);
        bleBtn.onclick = async () => {
            if (bleBtn.disabled) return;
            try {
                bleBtn.textContent = '🔵 Connexion...';
                bleBtn.disabled = true;
                const port = await createBluetoothPort();
                const bleM = new SerialMaster(port);
                await switchToMaster(bleM, 'ble');
                bleM.onDisconnect(() => {
                    if (currentMode === 'ble') { currentMode = 'local'; updateConnectionButtons(); }
                });
            } catch {
                updateConnectionButtons();
            }
        };
    }
}

bootstrap();
