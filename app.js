// =========================================================================
// ⚙️ LOGIQUE INTERFACE PINMAME WASM (app.js)
// =========================================================================

// 🌟 DICTIONNAIRE AUDIO (Dépuration Sonore)
const SOUND_DICTIONARY = {
    1: "STOP",
    2: "BGM 1",
    3: "BGM 2",
    4: "BGM 3",
    5: "BGM 4",
    61: "BANK CLEAR",
    63: "TEST TONE"
};

// 🌟 NOUVEAU : DICTIONNAIRE DES CONTACTS DU PLATEAU (00-79)
const SWITCH_DICTIONARY = {
    0: "Monnayeur Gauche (Standard)",
    1: "Monnayeur Central (Standard)",
    2: "Monnayeur Droit (Standard)",
    3: "Monnayeur 4 / Jeton",
    4: "Slam Tilt (Porte)",
    5: "Plumb Bob Tilt (Balancier)",
    6: "Bouton Start / Credit",
    7: "Bouton Test",
    15: "Exemple: Cible Tombante 1",
    16: "Exemple: Cible Tombante 2",
    30: "Exemple: Bumper Droit"
};

const canvas = document.getElementById('vfdCanvas');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status');
const termEl = document.getElementById('terminal');
const dipContainer = document.getElementById('dipContainer');
const romUploader = document.getElementById('romUploader');
const romNameDisplay = document.getElementById('romNameDisplay');
const clearRomBtn = document.getElementById('clearRomBtn');
const rebootBtn = document.getElementById('rebootBtn');
const audioLed = document.getElementById('audio-led');

const CHAR_WIDTH = 40; const CHAR_HEIGHT = 70; const SPACING = 15;
let pinmameInstance = null;
let vfdMemoryPointer = 0;

const swCells = []; const lampCells = []; const solCells = []; const dipToggles = [];
const userSwitchStates = new Array(80).fill(false);

// PERSISTANCE DES DIP SWITCHES VIA LOCALSTORAGE
let userDipStates = new Array(32).fill(false);
try {
    const savedDips = localStorage.getItem('pinmame_dips');
    if (savedDips) userDipStates = JSON.parse(savedDips);
} catch (e) { console.warn("Erreur lecture DIPs."); }

const COIN_ID = 3; const START_ID = 6; const TEST_ID = 7;   

const RING_BUFFER_SIZE = 131072;
const ringBufferL = new Float32Array(RING_BUFFER_SIZE);
const ringBufferR = new Float32Array(RING_BUFFER_SIZE);
let audioWritePtr = 0; let audioReadPtr = 0;
let isBufferWarming = true;

let lastSampleL = 0.0; let lastSampleR = 0.0;
let audioCtx = null; let audioNode = null;

function unlockAudio() {
    if (!audioCtx) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AudioContext({ sampleRate: 44100 });
        audioNode = audioCtx.createScriptProcessor(4096, 0, 2);
        
        audioNode.onaudioprocess = function(e) {
            const outL = e.outputBuffer.getChannelData(0);
            const outR = e.outputBuffer.getChannelData(1);
            let distance = (audioWritePtr - audioReadPtr + RING_BUFFER_SIZE) % RING_BUFFER_SIZE;
            
            if (isBufferWarming) {
                if (distance >= 8192) isBufferWarming = false;
                else { outL.fill(0); outR.fill(0); audioLed.classList.remove('active'); return; }
            }
            
            for (let i = 0; i < outL.length; i++) {
                if (audioReadPtr !== audioWritePtr) {
                    lastSampleL = ringBufferL[audioReadPtr];
                    lastSampleR = ringBufferR[audioReadPtr];
                    audioReadPtr = (audioReadPtr + 1) % RING_BUFFER_SIZE;
                    outL[i] = lastSampleL; outR[i] = lastSampleR;
                } else {
                    lastSampleL *= 0.90; lastSampleR *= 0.90;
                    outL[i] = lastSampleL; outR[i] = lastSampleR;
                }
            }
            if (distance > 24576) audioReadPtr = (audioWritePtr - 4096 + RING_BUFFER_SIZE) % RING_BUFFER_SIZE;
            if (distance > 512) audioLed.classList.add('active');
            else audioLed.classList.remove('active');
        };
        audioNode.connect(audioCtx.destination);
        logToTerminal("🔊 Flux audio stéréo d'arcade débloqué.");
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
}

// 🛡️ CORRECTION ABSOLUE : ALIMENTATION SÉCURISÉE DU BUFFER AUDIO
window.pushWasmAudio = function(ptr, count) {
    if (!audioCtx) return; // Ne pas jeter l'audio si l'état est "suspended" !
    
    // Accès 16-bits sécurisé (Résiste à l'expansion mémoire de WebAssembly)
    const ptr16 = ptr >> 1; 
    for (let i = 0; i < count; i += 2) {
        const left = pinmameInstance.HEAP16[ptr16 + i];
        const right = (i + 1 < count) ? pinmameInstance.HEAP16[ptr16 + i + 1] : left;
        
        ringBufferL[audioWritePtr] = left / 32768.0;
        ringBufferR[audioWritePtr] = right / 32768.0;
        audioWritePtr = (audioWritePtr + 1) % RING_BUFFER_SIZE;
    }
};

window.postWasmLog = function(cmdId) {
    const desc = SOUND_DICTIONARY[cmdId] || "SFX";
    logToTerminal(`🎵 Commande envoyée : 0x${cmdId.toString(16).padStart(2,'0').toUpperCase()} -> ${desc}`);
};

function logToTerminal(msg) {
    termEl.textContent += "\n" + msg;
    termEl.scrollTop = termEl.scrollHeight;
}

// 🎛️ CONSTRUCTION DE L'INTERFACE UTILISATEUR
const swGridEl = document.getElementById('swGrid');
for (let i = 0; i < 80; i++) {
    const cell = document.createElement('div');
    cell.className = 'cell'; 
    const swDesc = SWITCH_DICTIONARY[i] || `Contact Plateau ${String(i).padStart(2, '0')}`;
    cell.title = swDesc;
    cell.innerHTML = `
        <span class="sw-num-text">${String(i).padStart(2, '0')}</span>
        <svg class="mini-loader-svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"></circle></svg>
    `;

    let holdTimer = null; let isLocked = false; let isPressed = false;
    const sendSwitchState = (state) => {
        userSwitchStates[i] = (state === 1);
        if (pinmameInstance && vfdMemoryPointer) pinmameInstance.HEAPU8[vfdMemoryPointer + 100 + i] = state;
    };

    const pressDown = (e) => { 
        e.preventDefault(); unlockAudio();
        if (isLocked) {
            isLocked = false; cell.classList.remove('sw-locked'); sendSwitchState(0);
            isPressed = false; if(holdTimer) clearTimeout(holdTimer);
            logToTerminal(`⚡ Switch ${String(i).padStart(2, '0')} déverrouillé : ${swDesc}`);
            return;
        }
        if (!isPressed) {
            isPressed = true; sendSwitchState(1);
            cell.classList.remove('sw-user'); void cell.offsetWidth; cell.classList.add('sw-user'); 
            logToTerminal(`⚡ Switch ${String(i).padStart(2, '0')} actionné : ${swDesc}`);
            holdTimer = setTimeout(() => {
                if (isPressed) { 
                    isLocked = true; cell.classList.remove('sw-user'); cell.classList.add('sw-locked'); 
                    logToTerminal(`🔒 Switch ${String(i).padStart(2, '0')} VERROUILLÉ : ${swDesc}`);
                }
            }, 500); 
        }
    };

    const releaseUp = (e, forceRelease = false) => {
        e.preventDefault();
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
        if ((isPressed && !isLocked) || forceRelease) {
            isPressed = false; sendSwitchState(0); cell.classList.remove('sw-user');
        }
    };

    cell.addEventListener('pointerdown', pressDown); cell.addEventListener('pointerup', releaseUp);
    cell.addEventListener('pointerleave', releaseUp); cell.addEventListener('pointercancel', releaseUp);
    swGridEl.appendChild(cell); swCells.push(cell);
}

const cmdGridEl = document.getElementById('cmd-grid');
for (let i = 1; i <= 64; i++) {
    const cell = document.createElement('div'); cell.className = 'cell cell-cmd';
    const description = SOUND_DICTIONARY[i] || "SFX";
    cell.innerHTML = `<div class="cell-cmd-num">${String(i).padStart(2, '0')}</div><div class="cell-cmd-desc">${description}</div>`;
    cell.title = description; 
    cell.addEventListener('pointerdown', (e) => {
        e.preventDefault(); unlockAudio();
        cell.classList.add('cmd-active'); setTimeout(() => cell.classList.remove('cmd-active'), 120);
        if (pinmameInstance && vfdMemoryPointer) pinmameInstance.HEAPU8[vfdMemoryPointer + 1060] = i;
    });
    cmdGridEl.appendChild(cell);
}

for (let bank = 0; bank < 4; bank++) {
    const bankEl = document.createElement('div'); bankEl.className = 'dip-bank';
    for (let bit = 0; bit < 8; bit++) {
        const dipId = (bank * 8) + bit;
        const swWrap = document.createElement('div'); swWrap.className = 'dip-switch';
        const label = document.createElement('span'); label.textContent = String(dipId + 1).padStart(2, '0');
        const toggle = document.createElement('div'); toggle.className = 'dip-toggle';
        if (userDipStates[dipId]) toggle.classList.add('dip-on');

        toggle.addEventListener('pointerdown', (e) => {
            e.preventDefault(); userDipStates[dipId] = !userDipStates[dipId];
            if (userDipStates[dipId]) toggle.classList.add('dip-on'); else toggle.classList.remove('dip-on');
            if (pinmameInstance && vfdMemoryPointer) pinmameInstance.HEAPU8[vfdMemoryPointer + 400 + dipId] = userDipStates[dipId] ? 1 : 0;
            localStorage.setItem('pinmame_dips', JSON.stringify(userDipStates));
        });
        swWrap.appendChild(label); swWrap.appendChild(toggle); bankEl.appendChild(swWrap); dipToggles.push(toggle);
    }
    dipContainer.appendChild(bankEl);
}

const lampGridEl = document.getElementById('lampGrid');
for (let i = 0; i < 96; i++) {
    const cell = document.createElement('div'); cell.className = 'cell'; cell.textContent = 'L' + String(i+1).padStart(2, '0');
    lampGridEl.appendChild(cell); lampCells.push(cell);
}

const solGridEl = document.getElementById('solGrid');
for (let i = 0; i < 32; i++) {
    const cell = document.createElement('div'); cell.className = 'cell'; cell.textContent = 'S' + String(i+1).padStart(2, '0');
    solGridEl.appendChild(cell); solCells.push(cell);
}

async function startEmulation() {
    try {
        statusEl.textContent = "🟡 Chargement du moteur WebAssembly...";
        const instance = await createPinMAME({
            print: function(text) { logToTerminal(text); },
            printErr: function(err) { logToTerminal(err); },
            locateFile: function(path, prefix) { return path.endsWith('.wasm') ? 'pinmame_web.wasm' : prefix + path; }
        });

        let romBuffer; let finalRomName = "bonebstr"; 
        const customRomData = sessionStorage.getItem('custom_rom_bytes');
        const customRomName = sessionStorage.getItem('custom_rom_filename');

        if (customRomData && customRomName) {
            finalRomName = customRomName.replace('.zip', '').toLowerCase();
            logToTerminal("[JS] Restitution de la ROM locale chargée : " + finalRomName);
            romNameDisplay.textContent = customRomName; romNameDisplay.style.color = "var(--neon-green)";
            clearRomBtn.style.display = "inline-block";
            const binaryStr = atob(customRomData); const bytes = new Uint8Array(binaryStr.length);
            for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
            romBuffer = bytes.buffer;
        } else {
            logToTerminal(`[JS] Téléchargement du pack système par défaut...`);
            const response = await fetch(`roms/${finalRomName}.zip`);
            if (!response.ok) throw new Error("Pack introuvable.");
            romBuffer = await response.arrayBuffer();
        }
        
        instance.FS.mkdir('/roms');
        instance.FS.writeFile(`/roms/${finalRomName}.zip`, new Uint8Array(romBuffer));

        pinmameInstance = instance;
        vfdMemoryPointer = instance._pinmame_get_dsprom_ptr();

        const stringAddress = vfdMemoryPointer + 1000;
        for (let i = 0; i < finalRomName.length; i++) instance.HEAPU8[stringAddress + i] = finalRomName.charCodeAt(i);
        instance.HEAPU8[stringAddress + finalRomName.length] = 0;

        for(let i = 0; i < 32; i++) instance.HEAPU8[vfdMemoryPointer + 400 + i] = userDipStates[i] ? 1 : 0;
        
        setupButtons(); setupSystemHandlers();
        window.addEventListener('pointerdown', unlockAudio);

        function renderFrame() {
            if (!pinmameInstance || !vfdMemoryPointer) { requestAnimationFrame(renderFrame); return; }
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            const heap = pinmameInstance.HEAPU8;

            let distance = (audioWritePtr - audioReadPtr + RING_BUFFER_SIZE) % RING_BUFFER_SIZE;
            heap[vfdMemoryPointer + 1070] = distance & 0xFF;
            heap[vfdMemoryPointer + 1071] = (distance >> 8) & 0xFF;
            heap[vfdMemoryPointer + 1072] = (distance >> 16) & 0xFF;
            heap[vfdMemoryPointer + 1073] = (distance >> 24) & 0xFF;

            for (let i = 0; i < 20; i++) {
                const low1 = heap[vfdMemoryPointer + (i * 2)]; const high1 = heap[vfdMemoryPointer + (i * 2) + 1];
                drawGottlieb14Segment(ctx, 30 + i * (CHAR_WIDTH + SPACING), 40, low1 | (high1 << 8));
                const low2 = heap[vfdMemoryPointer + ((20 + i) * 2)]; const high2 = heap[vfdMemoryPointer + ((20 + i) * 2) + 1];
                drawGottlieb14Segment(ctx, 30 + i * (CHAR_WIDTH + SPACING), 140, low2 | (high2 << 8));
            }

            for (let col = 0; col < 12; col++) {
                const colByte = heap[vfdMemoryPointer + 300 + col];
                for (let row = 0; row < 8; row++) {
                    const lampId = (col * 8) + row;
                    if (lampCells[lampId]) {
                        if ((colByte & (1 << row)) !== 0) lampCells[lampId].classList.add('lamp-on');
                        else lampCells[lampId].classList.remove('lamp-on');
                    }
                }
            }

            const solWord = (heap[vfdMemoryPointer + 320] | (heap[vfdMemoryPointer + 321] << 8) | (heap[vfdMemoryPointer + 322] << 16) | (heap[vfdMemoryPointer + 323] << 24)) >>> 0;
            for (let s = 0; s < 32; s++) {
                if (solCells[s]) {
                    if ((solWord & (1 << s)) !== 0) solCells[s].classList.add('sol-on');
                    else solCells[s].classList.remove('sol-on');
                }
            }
            requestAnimationFrame(renderFrame);
        }

        requestAnimationFrame(renderFrame);
        statusEl.textContent = "🟢 PinMAME Workbench V175.17 - Système Actif";
        statusEl.style.color = "#00ffcc";
        setTimeout(() => { instance._pinmame_web_boot(); }, 100);
    } catch (err) { statusEl.textContent = "🔴 ERREUR : " + err.message; }
}

function setupSystemHandlers() {
    rebootBtn.onclick = () => { location.reload(); };
    clearRomBtn.onclick = () => { sessionStorage.removeItem('custom_rom_bytes'); sessionStorage.removeItem('custom_rom_filename'); location.reload(); };
    romUploader.onchange = (e) => {
        const file = e.target.files[0]; if (!file) return;
        const reader = new FileReader();
        reader.onload = (evt) => {
            const bytes = new Uint8Array(evt.target.result); let binaryStr = "";
            for (let i = 0; i < bytes.length; i++) binaryStr += String.fromCharCode(bytes[i]);
            sessionStorage.setItem('custom_rom_bytes', btoa(binaryStr)); sessionStorage.setItem('custom_rom_filename', file.name);
            location.reload();
        };
        reader.readAsArrayBuffer(file);
    };
}

function setupButtons() {
    const coinBtn = document.getElementById('coinBtn'); const startBtn = document.getElementById('startBtn'); const testBtn = document.getElementById('testBtn');
    const attachBtn = (btn, id) => {
        btn.addEventListener('pointerdown', (e) => { e.preventDefault(); unlockAudio(); userSwitchStates[id] = true; swCells[id].classList.add('sw-user'); if (pinmameInstance) pinmameInstance.HEAPU8[vfdMemoryPointer + 100 + id] = 1; logToTerminal(`⚡ Switch actionné : ${SWITCH_DICTIONARY[id]}`);});
        btn.addEventListener('pointerup', (e) => { e.preventDefault(); userSwitchStates[id] = false; swCells[id].classList.remove('sw-user'); if (pinmameInstance) pinmameInstance.HEAPU8[vfdMemoryPointer + 100 + id] = 0; });
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
    drawSeg(0x0001, () => { ctx.moveTo(2, 0); ctx.lineTo(w - 2, 0); });               
    drawSeg(0x0002, () => { ctx.moveTo(w, 2); ctx.lineTo(w, m - 2); });               
    drawSeg(0x0004, () => { ctx.moveTo(w, m + 2); ctx.lineTo(w, h - 2); });           
    drawSeg(0x0008, () => { ctx.moveTo(2, h); ctx.lineTo(w - 2, h); });               
    drawSeg(0x0010, () => { ctx.moveTo(0, m + 2); ctx.lineTo(0, h - 2); });           
    drawSeg(0x0020, () => { ctx.moveTo(0, 2); ctx.lineTo(0, m - 2); });               
    drawSeg(0x0040, () => { ctx.moveTo(2, m); ctx.lineTo(hw - 2, m); });              
    drawSeg(0x0800, () => { ctx.moveTo(hw + 2, m); ctx.lineTo(w - 2, m); });          
    drawSeg(0x0100, () => { ctx.moveTo(2, 2); ctx.lineTo(hw - 2, m - 2); });          
    drawSeg(0x0200, () => { ctx.moveTo(hw, 2); ctx.lineTo(hw, m - 3); });             
    drawSeg(0x0400, () => { ctx.moveTo(w - 2, 2); ctx.lineTo(hw + 2, m - 2); });      
    drawSeg(0x4000, () => { ctx.moveTo(2, h - 2); ctx.lineTo(hw - 2, m + 2); });      
    drawSeg(0x1000, () => { ctx.moveTo(w - 2, h - 2); ctx.lineTo(hw + 2, m + 2); });  
    drawSeg(0x2000, () => { ctx.moveTo(hw, h - 4); ctx.lineTo(hw, m + 3); });         
    drawSeg(0x0080, () => { ctx.moveTo(w + 2, h); ctx.lineTo(w + 6, h + 8); });       
    drawSeg(0x8000, () => { ctx.arc(w + 4, h, 2, 0, Math.PI*2); });                   
    ctx.restore();
}

startEmulation();