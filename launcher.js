<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <title>PinMAME WASM - Gottlieb System 80B</title>
    <style>
        body { 
            background-color: #050505; 
            color: #fff; 
            font-family: monospace; 
            display: flex; 
            flex-direction: column; 
            align-items: center; 
            justify-content: center; 
            height: 100vh; 
            margin: 0; 
            overflow: hidden; 
        }
        canvas { 
            background-color: #0a1111; 
            border: 4px solid #222; 
            border-radius: 10px; 
            box-shadow: 0 0 30px rgba(0, 255, 255, 0.15); 
            image-rendering: pixelated; 
            margin-top: 20px; 
        }
        #status { 
            color: #ffcc00; 
            font-size: 1.2rem; 
            text-transform: uppercase; 
            letter-spacing: 2px; 
            margin-bottom: 10px;
        }
        #error-log { 
            color: #ff0055; 
            background: #222; 
            padding: 15px; 
            border-radius: 5px; 
            white-space: pre-wrap; 
            display: none; 
            font-size: 1rem; 
            max-width: 800px; 
            text-align: left; 
            border: 1px solid #ff0055;
        }
        /* Style du panneau de contrôle Arcade */
        .arcade-panel {
            display: flex;
            gap: 30px;
            margin-top: 30px;
            background: #111;
            padding: 20px 40px;
            border-radius: 15px;
            border: 2px solid #333;
            box-shadow: inset 0 0 10px rgba(0,0,0,0.8);
        }
        .btn {
            padding: 15px 25px;
            font-size: 1.1rem;
            font-weight: bold;
            font-family: monospace;
            text-transform: uppercase;
            border: none;
            border-radius: 50px;
            cursor: pointer;
            box-shadow: 0 5px #000, 0 8px 10px rgba(0,0,0,0.5);
            transition: all 0.1s ease;
            user-select: none;
        }
        .btn:active, .btn.forced-active {
            transform: translateY(4px);
            box-shadow: 0 1px #000, 0 3px 5px rgba(0,0,0,0.5);
        }
        .btn-coin {
            background-color: #ffcc00;
            color: #000;
            text-shadow: 0 1px rgba(255,255,255,0.3);
        }
        .btn-start {
            background-color: #ff0044;
            color: #fff;
            box-shadow: 0 5px #700, 0 8px 10px rgba(0,0,0,0.5);
        }
        .btn-start:active, .btn-start.forced-active {
            box-shadow: 0 1px #400, 0 3px 5px rgba(0,0,0,0.5);
        }
        .instructions {
            margin-top: 15px;
            color: #666;
            font-size: 0.85rem;
        }
    </style>
</head>
<body>

    <div id="status">🟡 Initialisation du Moteur WebAssembly...</div>
    <div id="error-log"></div>

    <canvas id="vfdCanvas" width="1150" height="250"></canvas>

    <div class="arcade-panel">
        <button id="coinBtn" class="btn btn-coin">Coin 1 [Fils: 5]</button>
        <button id="startBtn" class="btn btn-start">Start Game [Fils: 1]</button>
    </div>
    <div class="instructions">💡 Astuce : Tu peux aussi appuyer directement sur les touches [5] et [1] de ton clavier !</div>

    <script>
        const statusEl = document.getElementById('status');
        const errorLog = document.getElementById('error-log');

        function triggerAlarm(msg) {
            statusEl.textContent = "🔴 CRASH DÉTECTÉ";
            statusEl.style.color = "#ff0055";
            errorLog.style.display = "block";
            errorLog.textContent += msg + "\n";
        }
        window.addEventListener('error', (e) => triggerAlarm("Erreur JS : " + e.message));
        window.addEventListener('unhandledrejection', (e) => triggerAlarm("Promesse rejetée : " + e.reason));
    </script>

    <script src="pinmame_web.js"></script>

    <script>
        const canvas = document.getElementById('vfdCanvas');
        const ctx = canvas.getContext('2d');
        const CHAR_WIDTH = 40; const CHAR_HEIGHT = 70; const SPACING = 15;

        // Références globales pour les événements asynchrones
        let pinmameInstance = null;
        let vfdMemoryPointer = 0;

        // Constantes des Keycodes Internes MAME (Spécifiques à l'architecture d'arcade)
        const MAME_KEYCODE_1 = 28; // Bouton Start 1
        const MAME_KEYCODE_5 = 32; // Insérer une pièce (Coin 1)

        async function startEmulation() {
            try {
                statusEl.textContent = "🟡 Démarrage de l'instance createPinMAME()...";
                
                const instance = await createPinMAME({
                    print: function(text) { console.log("[PinMAME] " + text); },
                    printErr: function(err) { console.error("[PinMAME ERR] " + err); },
                    locateFile: function(path, prefix) {
                        if (path.endsWith('.wasm')) return 'pinmame_web.wasm';
                        return prefix + path;
                    }
                });

                statusEl.textContent = "🟡 Téléchargement de la ROM...";
                const response = await fetch('roms/bonebstr.zip');
                if (!response.ok) throw new Error("ROM introuvable.");
                const romBuffer = await response.arrayBuffer();

                instance.FS.mkdir('/roms');
                instance.FS.writeFile('/roms/bonebstr.zip', new Uint8Array(romBuffer));

                statusEl.textContent = "🟢 Boot C++...";
                statusEl.style.color = "#00ffcc";

                instance._pinmame_web_boot();
                
                // Sauvegarde des pointeurs d'instance pour l'interactivité globale
                pinmameInstance = instance;
                vfdMemoryPointer = instance._pinmame_get_dsprom_ptr();

                function renderFrame() {
                    const vfdData = new Uint16Array(pinmameInstance.HEAPU8.buffer, vfdMemoryPointer, 40);
                    ctx.clearRect(0, 0, canvas.width, canvas.height);
                    
                    for (let i = 0; i < 20; i++) {
                        drawGottlieb14Segment(ctx, 30 + i * (CHAR_WIDTH + SPACING), 40, vfdData[i]);
                        drawGottlieb14Segment(ctx, 30 + i * (CHAR_WIDTH + SPACING), 140, vfdData[20 + i]);
                    }
                    requestAnimationFrame(renderFrame);
                }

                requestAnimationFrame(renderFrame);
                statusEl.textContent = "🟢 Borne Active ! Insère des crédits !";

                // Activation du câblage matériel des boutons
                setupInputListeners();

            } catch (err) {
                triggerAlarm(err.message);
            }
        }

        // 🌟 CABLAGE DES BOUTONS SOURIS + CLAVIER
        function setupInputListeners() {
            const coinBtn = document.getElementById('coinBtn');
            const startBtn = document.getElementById('startBtn');

            // Fonctions utilitaires d'écriture dans la RAM C++ (Offset 500)
            const setKeyState = (mameKeycode, isPressed) => {
                if (!pinmameInstance || !vfdMemoryPointer) return;
                pinmameInstance.HEAPU8[vfdMemoryPointer + 500 + mameKeycode] = isPressed ? 1 : 0;
            };

            // Événements Clavier Physiques
            window.addEventListener('keydown', (e) => {
                if (e.key === '5') { setKeyState(MAME_KEYCODE_5, true); coinBtn.classList.add('forced-active'); }
                if (e.key === '1') { setKeyState(MAME_KEYCODE_1, true); startBtn.classList.add('forced-active'); }
            });

            window.addEventListener('keyup', (e) => {
                if (e.key === '5') { setKeyState(MAME_KEYCODE_5, false); coinBtn.classList.remove('forced-active'); }
                if (e.key === '1') { setKeyState(MAME_KEYCODE_1, false); startBtn.classList.remove('forced-active'); }
            });

            // Événements Clics Boutons Souris/Tactile
            coinBtn.addEventListener('mousedown', () => setKeyState(MAME_KEYCODE_5, true));
            coinBtn.addEventListener('mouseup', () => setKeyState(MAME_KEYCODE_5, false));
            coinBtn.addEventListener('mouseleave', () => setKeyState(MAME_KEYCODE_5, false));

            startBtn.addEventListener('mousedown', () => setKeyState(MAME_KEYCODE_1, true));
            startBtn.addEventListener('mouseup', () => setKeyState(MAME_KEYCODE_1, false));
            startBtn.addEventListener('mouseleave', () => setKeyState(MAME_KEYCODE_1, false));
        }

        function drawGottlieb14Segment(ctx, x, y, mask) {
            ctx.save();
            ctx.translate(x, y);
            ctx.transform(1, 0, -0.15, 1, 0, 0); 
            ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round';

            const drawSeg = (bit, drawFn) => {
                if (mask & bit) {
                    ctx.strokeStyle = '#00ffff'; ctx.shadowBlur = 10; ctx.shadowColor = '#00ffff';
                } else {
                    ctx.strokeStyle = '#122222'; ctx.shadowBlur = 0;
                }
                ctx.beginPath(); drawFn(); ctx.stroke();
            };

            const w = CHAR_WIDTH; const h = CHAR_HEIGHT; 
            const m = h / 2; const hw = w / 2;

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
    </script>
</body>
</html>