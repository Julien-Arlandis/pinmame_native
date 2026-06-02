/**
 * =========================================================================
 * 🎮 PINMAME WASM - BROWSER ADAPTER LOGIC (browser-adapter.js)
 * 🏷️ VERSION : BROWSER-ADAPTER-V1.1
 * =========================================================================
 * Ce bloc contient la logique d'interface et de communication
 * avec le worker et l’émulateur WebAssembly côté navigateur.
 */

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

let masquesVFDLocaux = new Uint16Array(40);
let octetsLampesLocaux = new Uint8Array(12);

let ancienEtatLampesIndividuelles = new Uint8Array(96).fill(0);

function logToTerminal(msg) { 
    termEl.textContent += "\n" + msg; 
    termEl.scrollTop = termEl.scrollHeight; 
}

const chkInput = document.getElementById('chkInput');
const chkDriver = document.getElementById('chkDriver');
const chkDisplay = document.getElementById('chkDisplay');
const btnCopyLogs = document.getElementById('btnCopyLogs');

btnCopyLogs.onclick = function() {
    navigator.clipboard.writeText(termEl.textContent).then(() => {
        const oldText = btnCopyLogs.textContent;
        btnCopyLogs.textContent = "✔ Copié !";
        btnCopyLogs.style.background = "#004411";
        setTimeout(() => {
            btnCopyLogs.textContent = oldText;
            btnCopyLogs.style.background = "#1f1f1f";
        }, 1200);
    });
};

function logHardwareTraffic(expediteur, destinataire, commande, categorie) {
    if (categorie === 'INPUT' && !chkInput.checked) return;
    if (categorie === 'DRIVER' && !chkDriver.checked) return;
    if (categorie === 'DISPLAY' && !chkDisplay.checked) return;
    
    const logLine = `[${expediteur} ➔ ${destinataire}] ${commande.trim()}`;
    logToTerminal(logLine);
}

const flipperWorker = new Worker('browser-emulator-worker.js');

// 🚀 CENTRALISATION ET CAPTURE DU CONTEXTE AUDIO EN AMONT
function unlockAudio() {
    try {
        if (!audioCtx) {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (!AudioContext) {
                logToTerminal("❌ Web Audio API non disponible sur cet appareil.");
                return;
            }
            
            const requestedSampleRate = 44100;
            audioCtx = new AudioContext({ sampleRate: requestedSampleRate });
            logToTerminal(`📊 Contexte Audio créé : ${audioCtx.sampleRate}Hz (demandé ${requestedSampleRate}Hz), état: ${audioCtx.state}`);
            if (audioCtx.sampleRate !== requestedSampleRate) {
                logToTerminal(`⚠️ La fréquence souhaitée n'a pas pu être appliquée. Résultat : ${audioCtx.sampleRate}Hz`);
            }
            
            // 🔥 CRITIQUE : Résumer immédiatement le contexte sur mobile
            if (audioCtx.state === 'suspended') {
                audioCtx.resume().then(() => {
                    logToTerminal("✅ Contexte Audio repris (resumed)");
                }).catch(err => {
                    logToTerminal(`⚠️ Erreur lors de resume(): ${err.message}`);
                });
            }
            
            audioNode = audioCtx.createScriptProcessor(4096, 1, 2); // 2. Ajoute 1 canal d'entrée virtuel
            
            // 3. HACK ANDROID : On connecte un oscillateur silencieux pour forcer le réveil de la puce
            const reveilAudio = audioCtx.createOscillator();
            reveilAudio.frequency.value = 0; // Fréquence 0 = silencieux
            reveilAudio.connect(audioNode);
            reveilAudio.start(0);
            
            // Arrêter l'oscillateur après 500ms pour éviter une fuite mémoire
            setTimeout(() => {
                try {
                    reveilAudio.stop();
                    logToTerminal("🛑 Oscillateur d'accès arrêté");
                } catch (e) {
                    // L'oscillateur est peut-être déjà arrêté
                }
            }, 500);
            
            audioNode.onaudioprocess = function(e) {
                const outL = e.outputBuffer.getChannelData(0); const outR = e.outputBuffer.getChannelData(1);
                let distance = (audioWritePtr - audioReadPtr + RING_BUFFER_SIZE) % RING_BUFFER_SIZE;
                flipperWorker.postMessage({ type: 'UPDATE_AUDIO_DISTANCE', payload: { distance: distance } });
                if (isBufferWarming && distance >= 8192) {
                    isBufferWarming = false;
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
            logToTerminal("🔊 Flux audio stéréo débloqué et connecté.");
        } else if (audioCtx.state === 'suspended') {
            // Si le contexte existe déjà mais est suspendu, le reprendre
            audioCtx.resume().then(() => {
                logToTerminal("✅ Contexte Audio repris (était suspendu)");
            }).catch(err => {
                logToTerminal(`⚠️ Erreur lors de resume(): ${err.message}`);
            });
        }
    } catch (err) {
        logToTerminal(`❌ Erreur lors de l'initialisation Audio: ${err.message}`);
    }
}

// 🎯 CORRECTIF : Attache immédiate dès le premier pixel touché sur le DOM
// NE PAS supprimer les écouteurs - ils peuvent être nécessaires si le contexte audio se suspend à nouveau
document.body.addEventListener('click', unlockAudio, { passive: true });
document.body.addEventListener('touchstart', unlockAudio, { passive: true });
window.addEventListener('resume', unlockAudio, { passive: true }); // Pour les apps hybrides

// Tentative initiale après 500ms si aucun geste n'a été détecté
setTimeout(unlockAudio, 500);

flipperWorker.onmessage = function(event) {
    const { type, payload, data } = event.data;

    switch (type) {
        case 'STATUS': statusEl.textContent = data; break;
        case 'LOG': logToTerminal(data); break;
        
        case 'AUDIO_CMD_LOG':
            const desc = SOUND_DICTIONARY[payload.cmdId] || "SFX";
            logHardwareTraffic("EMULATEUR", "AUDIO_DAC", `!sound:cmd=0x${payload.cmdId.toString(16).toUpperCase()}&desc=${desc}`, "DRIVER");
            break;

        case 'AUDIO_DATA':
            if (!audioCtx) {
                unlockAudio();
                if (!audioCtx) return;
            }
            const left = payload.left; const right = payload.right;
            for (let i = 0; i < left.length; i++) {
                ringBufferL[audioWritePtr] = left[i]; ringBufferR[audioWritePtr] = right[i];
                audioWritePtr = (audioWritePtr + 1) % RING_BUFFER_SIZE;
            }
            break;

        case 'VFD_UPDATE':
            masquesVFDLocaux = payload.masques;
            logHardwareTraffic("EMULATEUR", "VIRTUAL_DISPLAY", `!display:event=RAW_DATA_BURST`, "DISPLAY");
            break;

        case 'LAMPS_UPDATE':
            octetsLampesLocaux = payload.bytes;
            for (let col = 0; col < 12; col++) {
                let colByte = octetsLampesLocaux[col];
                for (let row = 0; row < 8; row++) {
                    let lampId = (col * 8) + row;
                    let nouvelEtatLamp = (colByte & (1 << row)) !== 0 ? 1 : 0;
                    
                    if (lampCells[lampId]) {
                        if (nouvelEtatLamp === 1) lampCells[lampId].classList.add('lamp-on');
                        else lampCells[lampId].classList.remove('lamp-on');
                    }
                    
                    if (nouvelEtatLamp !== ancienEtatLampesIndividuelles[lampId]) {
                        logHardwareTraffic("EMULATEUR", "VIRTUAL_DRIVER", `!set:id=${lampId + 1}&state=${nouvelEtatLamp}`, "DRIVER");
                        ancienEtatLampesIndividuelles[lampId] = nouvelEtatLamp;
                    }
                }
            }
            break;

        case 'DRIVER_ORDER':
            if (solCells[payload.id]) {
                if (payload.state === 1) solCells[payload.id].classList.add('sol-on');
                else solCells[payload.id].classList.remove('sol-on');
            }
            logHardwareTraffic("EMULATEUR", "VIRTUAL_DRIVER", `!set:id=${payload.id}&state=${payload.state}`, "DRIVER");
            break;

        case 'ENGINE_READY':
            if (sessionStorage.getItem('custom_rom_bytes')) {
                romNameDisplay.textContent = sessionStorage.getItem('custom_rom_filename');
                romNameDisplay.style.color = "var(--neon-green)"; clearRomBtn.style.display = "inline-block";
            }
            statusEl.textContent = "🟢 PinMAME Workbench V200.27 - AUDIO RUNNING";
            statusEl.style.color = "#00ffcc";
            setupButtons(); setupSystemHandlers();
            
            // 🚀 APPEL DE FORCE : Vérifier et reprendre le contexte audio à ce stade
            unlockAudio();
            if (audioCtx && audioCtx.state === 'suspended') {
                logToTerminal("⏳ Tentative supplémentaire de reprise audio...");
                audioCtx.resume().then(() => {
                    logToTerminal("✅ Audio repris après ENGINE_READY");
                }).catch(err => {
                    logToTerminal(`⚠️ Audio en attente d'interaction utilisateur: ${err.message}`);
                });
            }
            requestAnimationFrame(renderFrame);
            break;
    }
};

function notifierChangementInput(id, state) {
    userSwitchStates[id] = (state === 1);
    logHardwareTraffic("VIRTUAL_INPUT", "EMULATEUR", `@set:id=${id}&state=${state}`, "INPUT");
    flipperWorker.postMessage({ type: 'INJECT_INPUT', payload: { id: id, state: state } });
}

const swGridEl = document.getElementById('swGrid');
for (let i = 0; i < 80; i++) {
    const cell = document.createElement('div'); cell.className = 'cell'; 
    const swDesc = SWITCH_DICTIONARY[i] || `Contact ${String(i).padStart(2, '0')}`;
    cell.title = swDesc;
    cell.innerHTML = `<span class="sw-num-text">${String(i).padStart(2, '0')}</span><svg class="mini-loader-svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"></circle></svg>`;
    let holdTimer = null; let isLocked = false; let isPressed = false;

    const pressDown = (e) => { 
        if(e.type.startsWith('touch')) e.preventDefault();
        if (isLocked) {
            isLocked = false; cell.classList.remove('sw-locked'); notifierChangementInput(i, 0);
            isPressed = false; if(holdTimer) clearTimeout(holdTimer); return;
        }
        if (!isPressed) {
            isPressed = true; notifierChangementInput(i, 1);
            cell.classList.remove('sw-user'); void cell.offsetWidth; cell.classList.add('sw-user'); 
            holdTimer = setTimeout(() => {
                if (isPressed) { isLocked = true; cell.classList.remove('sw-user'); cell.classList.add('sw-locked'); }
            }, 500); 
        }
    };
    const releaseUp = (e, forceRelease = false) => {
        if(e && e.type.startsWith('touch')) e.preventDefault();
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
        if ((isPressed && !isLocked) || forceRelease) { isPressed = false; notifierChangementInput(i, 0); cell.classList.remove('sw-user'); }
    };
    cell.addEventListener('mousedown', pressDown); cell.addEventListener('touchstart', pressDown, {passive: false});
    cell.addEventListener('mouseup', releaseUp); cell.addEventListener('touchend', releaseUp, {passive: false});
    cell.addEventListener('mouseleave', releaseUp); cell.addEventListener('touchcancel', releaseUp, {passive: false});
    swGridEl.appendChild(cell); swCells.push(cell);
}

const cmdGridEl = document.getElementById('cmd-grid');
for (let i = 1; i <= 64; i++) {
    const cell = document.createElement('div'); cell.className = 'cell cell-cmd'; const description = SOUND_DICTIONARY[i] || "SFX";
    cell.innerHTML = `<div class="cell-cmd-num">${String(i).padStart(2, '0')}</div><div class="cell-cmd-desc">${description}</div>`;
    const triggerAudioCmd = (e) => {
        if(e.type.startsWith('touch')) e.preventDefault();
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
        const toggle = document.createElement('div'); toggle.className = 'dip-toggle'; if (userDipStates[dipId]) toggle.classList.add('dip-on');

        const toggleDip = (e) => {
            if(e.type.startsWith('touch')) e.preventDefault(); userDipStates[dipId] = !userDipStates[dipId];
            if (userDipStates[dipId]) toggle.classList.add('dip-on'); else toggle.classList.remove('dip-on');
            flipperWorker.postMessage({ type: 'UPDATE_DIPS', payload: { dips: userDipStates } }); localStorage.setItem('pinmame_dips', JSON.stringify(userDipStates));
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

function renderFrame() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
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
        const pDown = (e) => { if(e.type.startsWith('touch')) e.preventDefault(); swCells[id].classList.add('sw-user'); notifierChangementInput(id, 1); };
        const pUp = (e) => { if(e.type.startsWith('touch')) e.preventDefault(); swCells[id].classList.remove('sw-user'); notifierChangementInput(id, 0); };
        btn.addEventListener('mousedown', pDown); btn.addEventListener('touchstart', pDown, {passive: false});
        btn.addEventListener('mouseup', pUp); btn.addEventListener('touchend', pUp, {passive: false});
        btn.addEventListener('mouseleave', pUp); btn.addEventListener('touchcancel', pUp, {passive: false});
    };
    attachBtn(coinBtn, COIN_ID); attachBtn(startBtn, START_ID); attachBtn(testBtn, TEST_ID);
}

function drawGottlieb14Segment(ctx, x, y, mask) {
    ctx.save(); ctx.translate(x, y); ctx.transform(1, 0, -0.15, 1, 0, 0); ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
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

}
