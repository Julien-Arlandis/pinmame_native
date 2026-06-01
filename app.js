// =========================================================================
// ⚙️ INTERFACE GRAPHIQUE & PASSERELLE USB (app.js)
// 🏷️ VERSION : V200.04 - ÉVÉNEMENTIEL DISPLAY FIX
// =========================================================================

let metaViewport = document.querySelector('meta[name="viewport"]');
if (!metaViewport) {
    metaViewport = document.createElement('meta');
    metaViewport.name = "viewport";
    document.head.appendChild(metaViewport);
}
metaViewport.content = "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover";

const styleInject = document.createElement('style');
styleInject.innerHTML = `
    * {
        -webkit-tap-highlight-color: transparent !important;
        -webkit-touch-callout: none !important;
        user-select: none !important;
        -webkit-user-select: none !important;
    }
    .cell, .cell-cmd, .dip-toggle, button { touch-action: none !important; }
`;
document.head.appendChild(styleInject);

const SOUND_DICTIONARY = { 1: "STOP", 2: "BGM 1", 3: "BGM 2", 4: "BGM 3", 5: "BGM 4", 61: "BANK CLEAR", 63: "TEST TONE" };
const SWITCH_DICTIONARY = {
    0: "10 Points", 1: "10 Points", 2: "10 Points", 3: "10 Points", 4: "Left Outlane", 5: "Left Return", 6: "Right Return", 7: "Test Button",
    10: "10 Points", 11: "10 Points", 12: "10 Points", 13: "10 Points", 14: "Right Outlane", 15: "Left Top Lane", 16: "Right Top Lane", 17: "Center Coin Chute (8 Cr)",
    20: "10 Points", 21: "10 Points", 22: "10 Points", 23: "10 Points", 24: "Left Drop - Top", 25: "Left Drop - Center", 26: "Left Drop - Bottom", 27: "Left Coin Chute (1/2 Cr)",
    30: "10 Points", 31: "10 Points", 32: "10 Points", 33: "Left Bumper", 34: "Right Drop - Top", 35: "Right Drop - Center", 36: "Right Drop - Bottom", 37: "Coin Chute 4",
    40: "Target 'B'", 41: "Target 'O'", 42: "Target 'N'", 43: "Shooter Lane", 44: "Left Captive", 45: "Right Captive", 46: "Outhole", 47: "Replay Button (START)",
    50: "Target 'E'", 51: "Target 'S'", 52: "Target 'U'", 53: "Trough 1", 54: "Trough 2", 55: "Trough 3", 56: "Trough 4", 57: "Right Coin Chute",
    60: "Target 'B' (Bust)", 61: "Target 'U' (Bust)", 62: "Target 'S' (Bust)", 63: "Target 'T' (Bust)", 64: "Target 'E' (Bust)", 65: "Target 'R' (Bust)", 66: "Target 'S' (Bust)", 67: "Slam Tilt",
    70: "Top Rebound", 71: "Right Bumper", 72: "Bottom Bumper", 73: "Kicker", 74: "Standup Right", 75: "Standup Left", 76: "Spinner", 77: "Plumb Bob Tilt"
};

const canvas = document.getElementById('vfdCanvas'); const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status'); const termEl = document.getElementById('terminal');
const dipContainer = document.getElementById('dipContainer'); const romUploader = document.getElementById('romUploader');
const romNameDisplay = document.getElementById('romNameDisplay'); const clearRomBtn = document.getElementById('clearRomBtn');
const rebootBtn = document.getElementById('rebootBtn'); const audioLed = document.getElementById('audio-led');

const CHAR_WIDTH = 40; const CHAR_HEIGHT = 70; const SPACING = 15;
const swCells = []; const lampCells = []; const solCells = []; const dipToggles = [];
const userSwitchStates = new Array(80).fill(false);

let userDipStates = new Array(32).fill(false);
try { const savedDips = localStorage.getItem('pinmame_dips'); if (savedDips) userDipStates = JSON.parse(savedDips); } catch (e) {}

const COIN_ID = 27; const START_ID = 47; const TEST_ID = 7;   

const RING_BUFFER_SIZE = 131072;
const ringBufferL = new Float32Array(RING_BUFFER_SIZE); const ringBufferR = new Float32Array(RING_BUFFER_SIZE);
let audioWritePtr = 0; let audioReadPtr = 0; let isBufferWarming = true;
let lastSampleL = 0.0; let lastSampleR = 0.0; let audioCtx = null; let audioNode = null;

// Mémoire locale pour le rendu graphique de l'IHM
let masquesVFDLocaux = new Uint16Array(40);

const flipperWorker = new Worker('flipper-worker.js');

function logToTerminal(msg) { termEl.textContent += "\n" + msg; termEl.scrollTop = termEl.scrollHeight; }

function unlockAudio() {
    if (!audioCtx) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AudioContext({ sampleRate: 44100 });
        audioNode = audioCtx.createScriptProcessor(4096, 0, 2);
        
        audioNode.onaudioprocess = function(e) {
            const outL = e.outputBuffer.getChannelData(0); const outR = e.outputBuffer.getChannelData(1);
            let distance = (audioWritePtr - audioReadPtr + RING_BUFFER_SIZE) % RING_BUFFER_SIZE;
            
            flipperWorker.postMessage({ type: 'UPDATE_AUDIO_DISTANCE', payload: { distance: distance } });

            if (isBufferWarming) {
                if (distance >= 8192) isBufferWarming = false;
                else { outL.fill(0); outR.fill(0); audioLed.classList.remove('active'); return; }
            }
            for (let i = 0; i < outL.length; i++) {
                if (audioReadPtr !== audioWritePtr) {
                    lastSampleL = ringBufferL[audioReadPtr]; lastSampleR = ringBufferR[audioReadPtr];
                    audioReadPtr = (audioReadPtr + 1) % RING_BUFFER_SIZE; outL[i] = lastSampleL; outR[i] = lastSampleR;
                } else {
                    lastSampleL *= 0.90; lastSampleR *= 0.90; outL[i] = lastSampleL; outR[i] = lastSampleR;
                }
            }
            if (distance > 24576) audioReadPtr = (audioWritePtr - 4096 + RING_BUFFER_SIZE) % RING_BUFFER_SIZE;
            if (distance > 512) audioLed.classList.add('active'); else audioLed.classList.remove('active');
        };
        audioNode.connect(audioCtx.destination);
        logToTerminal("🔊 Flux audio stéréo débloqué.");
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
}

flipperWorker.onmessage = function(event) {
    const { type, payload, data } = event.data;

    switch (type) {
        case 'STATUS':
            statusEl.textContent = data;
            break;

        case 'LOG':
            logToTerminal(data);
            break;

        case 'AUDIO_CMD_LOG':
            const desc = SOUND_DICTIONARY[payload.cmdId] || "SFX";
            logToTerminal(`🎵 Commande : 0x${payload.cmdId.toString(16).padStart(2,'0').toUpperCase()} -> ${desc}`);
            break;

        case 'AUDIO_DATA':
            if (!audioCtx) return;
            const left = payload.left; const right = payload.right;
            for (let i = 0; i < left.length; i++) {
                ringBufferL[audioWritePtr] = left[i];
                ringBufferR[audioWritePtr] = right[i];
                audioWritePtr = (audioWritePtr + 1) % RING_BUFFER_SIZE;
            }
            break;

        case 'VFD_UPDATE':
            // 🎯 RÉCEPTION DU TEXTE/SEGMENTS : On stocke l'état poussé par le Worker
            masquesVFDLocaux = payload.masques;
            break;

        case 'ENGINE_READY':
            if (sessionStorage.getItem('custom_rom_bytes')) {
                romNameDisplay.textContent = sessionStorage.getItem('custom_rom_filename');
                romNameDisplay.style.color = "var(--neon-green)";
                clearRomBtn.style.display = "inline-block";
            }

            statusEl.textContent = "🟢 PinMAME Workbench V200.04 - TEXT DRIVEN WORKER";
            statusEl.style.color = "#00ffcc";

            setupButtons(); setupSystemHandlers();
            document.body.addEventListener('touchstart', unlockAudio, { passive: true });
            
            // Lancement de l'affichage graphique autonome
            requestAnimationFrame(renderFrame);
            break;
    }
};

function notifierChangementInput(id, state) {
    userSwitchStates[id] = (state === 1);
    flipperWorker.postMessage({ type: 'INJECT_INPUT', payload: { id: id, state: state } });
}

// 🎛️ MATRICE DES SWITCHS
const swGridEl = document.getElementById('swGrid');
for (let i = 0; i < 80; i++) {
    const cell = document.createElement('div'); cell.className = 'cell'; 
    const swDesc = SWITCH_DICTIONARY[i] || `Contact ${String(i).padStart(2, '0')}`;
    cell.title = swDesc;
    cell.innerHTML = `<span class="sw-num-text">${String(i).padStart(2, '0')}</span><svg class="mini-loader-svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"></circle></svg>`;

    let holdTimer = null; let isLocked = false; let isPressed = false;

    const pressDown = (e) => { 
        if(e.type.startsWith('touch')) e.preventDefault();
        unlockAudio();
        if (isLocked) {
            isLocked = false; cell.classList.remove('sw-locked'); notifierChangementInput(i, 0);
            isPressed = false; if(holdTimer) clearTimeout(holdTimer);
            logToTerminal(`⚡ Déverrouillé : ${swDesc}`); return;
        }
        if (!isPressed) {
            isPressed = true; notifierChangementInput(i, 1);
            cell.classList.remove('sw-user'); void cell.offsetWidth; cell.classList.add('sw-user'); 
            logToTerminal(`⚡ Actionné : ${swDesc}`);
            holdTimer = setTimeout(() => {
                if (isPressed) { 
                    isLocked = true; cell.classList.remove('sw-user'); cell.classList.add('sw-locked'); 
                    logToTerminal(`🔒 VERROUILLÉ : ${swDesc}`);
                }
            }, 500); 
        }
    };

    const releaseUp = (e, forceRelease = false) => {
        if(e && e.type.startsWith('touch')) e.preventDefault();
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
        if ((isPressed && !isLocked) || forceRelease) {
            isPressed = false; notifierChangementInput(i, 0); cell.classList.remove('sw-user');
        }
    };

    cell.addEventListener('mousedown', pressDown); cell.addEventListener('touchstart', pressDown, {passive: false});
    cell.addEventListener('mouseup', releaseUp); cell.addEventListener('touchend', releaseUp, {passive: false});
    cell.addEventListener('mouseleave', releaseUp); cell.addEventListener('touchcancel', releaseUp, {passive: false});
    swGridEl.appendChild(cell); swCells.push(cell);
}

// 🎛️ COMMANDES DE DIAGNOSTIC AUDIO
const cmdGridEl = document.getElementById('cmd-grid');
for (let i = 1; i <= 64; i++) {
    const cell = document.createElement('div'); cell.className = 'cell cell-cmd';
    const description = SOUND_DICTIONARY[i] || "SFX";
    cell.innerHTML = `<div class="cell-cmd-num">${String(i).padStart(2, '0')}</div><div class="cell-cmd-desc">${description}</div>`;
    cell.title = description; 
    
    const triggerAudioCmd = (e) => {
        if(e.type.startsWith('touch')) e.preventDefault(); unlockAudio();
        cell.classList.add('cmd-active'); setTimeout(() => cell.classList.remove('cmd-active'), 120);
        flipperWorker.postMessage({ type: 'TRIGGER_SOUND_CMD', payload: { cmdId: i } });
    };
    cell.addEventListener('mousedown', triggerAudioCmd); cell.addEventListener('touchstart', triggerAudioCmd, {passive: false});
    cmdGridEl.appendChild(cell);
}

for (let bank = 0; bank < 4; bank++) {
    const bankEl = document.createElement('div'); bankEl.className = 'dip-bank';
    for (let bit = 0; bit < 8; bit++) {
        const dipId = (bank * 8) + bit; const swWrap = document.createElement('div'); swWrap.className = 'dip-switch';
        const label = document.createElement('span'); label.textContent = String(dipId + 1).padStart(2, '0');
        const toggle = document.createElement('div'); toggle.className = 'dip-toggle';
        if (userDipStates[dipId]) toggle.classList.add('dip-on');

        const toggleDip = (e) => {
            if(e.type.startsWith('touch')) e.preventDefault();
            userDipStates[dipId] = !userDipStates[dipId];
            if (userDipStates[dipId]) toggle.classList.add('dip-on'); else toggle.classList.remove('dip-on');
            flipperWorker.postMessage({ type: 'UPDATE_DIPS', payload: { dips: userDipStates } });
            localStorage.setItem('pinmame_dips', JSON.stringify(userDipStates));
        };
        toggle.addEventListener('mousedown', toggleDip); toggle.addEventListener('touchstart', toggleDip, {passive: false});
        swWrap.appendChild(label); swWrap.appendChild(toggle); bankEl.appendChild(swWrap); dipToggles.push(toggle);
    }
    dipContainer.appendChild(bankEl);
}

const lampGridEl = document.getElementById('lampGrid');
for (let i = 0; i < 96; i++) { const cell = document.createElement('div'); cell.className = 'cell'; cell.textContent = 'L' + String(i+1).padStart(2, '0'); lampGridEl.appendChild(cell); lampCells.push(cell); }
const solGridEl = document.getElementById('solGrid');
for (let i = 0; i < 32; i++) { const cell = document.createElement('div'); cell.className = 'cell'; cell.textContent = 'S' + String(i+1).padStart(2, '0'); solGridEl.appendChild(cell); solCells.push(cell); }

// 🎨 LE RENDU VISUEL AUTONOME DE L'IHM
function renderFrame() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Rendu Afficheur Gottlieb VFD à partir des masques reçus du Worker
    for (let i = 0; i < 20; i++) {
        drawGottlieb14Segment(ctx, 30 + i * (CHAR_WIDTH + SPACING), 40, masquesVFDLocaux[i]);
        drawGottlieb14Segment(ctx, 30 + i * (CHAR_WIDTH + SPACING), 140, masquesVFDLocaux[20 + i]);
    }
    
    requestAnimationFrame(renderFrame);
}

function setupSystemHandlers() {
    rebootBtn.onclick = () => { location.reload(); };
    clearRomBtn.onclick = () => { sessionStorage.removeItem('custom_rom_bytes'); sessionStorage.removeItem('custom_rom_filename'); location.reload(); };
    romUploader.onchange = (e) => {
        const file = e.target.files[0]; if (!file) return; const reader = new FileReader();
        reader.onload = (evt) => {
            const bytes = new Uint8Array(evt.target.result); let binaryStr = "";
            for (let i = 0; i < bytes.length; i++) binaryStr += String.fromCharCode(bytes[i]);
            sessionStorage.setItem('custom_rom_bytes', btoa(binaryStr)); sessionStorage.setItem('custom_rom_filename', file.name); location.reload();
        };
        reader.readAsArrayBuffer(file);
    };
}

function setupButtons() {
    const coinBtn = document.getElementById('coinBtn'); const startBtn = document.getElementById('startBtn'); const testBtn = document.getElementById('testBtn');
    const attachBtn = (btn, id) => {
        if(!btn) return;
        const pDown = (e) => { if(e.type.startsWith('touch')) e.preventDefault(); unlockAudio(); swCells[id].classList.add('sw-user'); notifierChangementInput(id, 1); };
        const pUp = (e) => { if(e.type.startsWith('touch')) e.preventDefault(); swCells[id].classList.remove('sw-user'); notifierChangementInput(id, 0); };
        btn.addEventListener('mousedown', pDown); btn.addEventListener('touchstart', pDown, {passive: false});
        btn.addEventListener('mouseup', pUp); btn.addEventListener('touchend', pUp, {passive: false});
        btn.addEventListener('mouseleave', pUp); btn.addEventListener('touchcancel', pUp, {passive: false});
    };
    attachBtn(coinBtn, COIN_ID); attachBtn(startBtn, START_ID); attachBtn(testBtn, TEST_ID);
}

function drawGottlieb14Segment(ctx, x, y, mask) {
    ctx.save(); ctx.translate(x, y); ctx.transform(1, 0, -0.15, 1, 0, 0); 
    ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const drawSeg = (bit, drawFn) => {
        if (mask & bit) { ctx.strokeStyle = '#00ffff'; ctx.shadowBlur = 10; ctx.shadowColor = '#00ffff'; }
        else { ctx.strokeStyle = '#122222'; ctx.shadowBlur = 0; }
        ctx.beginPath(); drawFn(); ctx.stroke();
    };
    const w = CHAR_WIDTH; const h = CHAR_HEIGHT; const m = h / 2; const hw = w / 2;
    drawSeg(0x0001, () => { ctx.moveTo(2, 0); ctx.lineTo(w - 2, 0); }); drawSeg(0x0002, () => { ctx.moveTo(w, 2); ctx.lineTo(w, m - 2); });               
    drawSeg(0x0004, () => { ctx.moveTo(w, m + 2); ctx.lineTo(w, h - 2); }); drawSeg(0x0008, () => { ctx.moveTo(2, h); ctx.lineTo(w - 2, h); });               
    drawSeg(0x0010, () => { ctx.moveTo(0, m + 2); ctx.lineTo(0, h - 2); }); drawSeg(0x0020, () => { ctx.moveTo(0, 2); ctx.lineTo(0, m - 2); });               
    drawSeg(0x0040, () => { ctx.moveTo(2, m); ctx.lineTo(hw - 2, m); }); drawSeg(0x0800, () => { ctx.moveTo(hw + 2, m); ctx.lineTo(w - 2, m); });          
    drawSeg(0x0100, () => { ctx.moveTo(2, 2); ctx.lineTo(hw - 2, m - 2); }); drawSeg(0x0200, () => { ctx.moveTo(hw, 2); ctx.lineTo(hw, m - 3); });             
    drawSeg(0x0400, () => { ctx.moveTo(w - 2, 2); ctx.lineTo(hw + 2, m - 2); }); drawSeg(0x4000, () => { ctx.moveTo(2, h - 2); ctx.lineTo(hw - 2, m + 2); });      
    drawSeg(0x1000, () => { ctx.moveTo(w - 2, h - 2); ctx.lineTo(hw + 2, m + 2); }); drawSeg(0x2000, () => { ctx.moveTo(hw, h - 4); ctx.lineTo(hw, m + 3); });         
    drawSeg(0x0080, () => { ctx.moveTo(w + 2, h); ctx.lineTo(w + 6, h + 8); }); drawSeg(0x8000, () => { ctx.arc(w + 4, h, 2, 0, Math.PI*2); });                   
    ctx.restore();
}

flipperWorker.postMessage({
    type: 'INIT_ENGINE',
    payload: {
        customRomBytes: sessionStorage.getItem('custom_rom_bytes'),
        customRomName: sessionStorage.getItem('custom_rom_filename')
    }
});