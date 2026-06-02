/**
 * =========================================================================
 * 📺 GOTTLEB SYSTEM 80B - VIRTUAL ALPHA-NUMERIC VFD DISPLAY EMULATOR
 * 🏷️ VERSION : DISPLAY-RENDER-CORE-V200.27 (SEMANTIC ASCII PARSER)
 * =========================================================================
 * * Ce module est l'unique responsable de la conversion sémantique et du rendu.
 * index.html lui envoie des trames ASCII pures, et ce script calcule les masques
 * de segments et pilote le rendu vectoriel sur le Canvas.
 */

class GottliebDisplayEmulator {
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        if (!this.canvas) throw new Error(`Canvas avec l'id '${canvasId}' introuvable.`);
        this.ctx = this.canvas.getContext('2d');
        
        // Configuration géométrique d'une cellule de caractère
        this.CHAR_WIDTH = 40;
        this.CHAR_HEIGHT = 70;
        this.SPACING = 15;

        // Mémoire vive de l'afficheur (40 cases de 16-bits physiques calculés localement)
        this.vfdCells = new Uint16Array(40); 
        this.cursorPosition = 0;             // Tête de lecture / écriture (0 à 39)

        // Table officielle Gottlieb : Convertit l'ASCII standard (7-bits) en masque 16-segments
        this.ascii2gottlieb = new Uint16Array([
            0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, // 0x00 - 0x07
            0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, // 0x08 - 0x0F
            0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, // 0x10 - 0x17
            0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, // 0x18 - 0x1F
            
            0x0000, /* Espace (Aucun segment) */
            0x000c, /* ! */
            0x0202, /* " */
            0x12bc, /* # */
            0x298d, /* $ */
            0x1248, /* % */
            0x2af5, /* & */
            0x0400, /* ' */
            0x2400, /* ( */
            0x0900, /* ) */
            0x3f3f, /* * */
            0x0b0b, /* + */
            0x0000, /* , */
            0x0909, /* - */
            0x0000, /* . */
            0x2100, /* / */

            /* Chiffres 0-9 (Index 0x30 à 0x39) */
            0x003f, 0x0006, 0x09db, 0x09cf, 0x0966, 0x09ed, 0x09fd, 0x0007, 
            0x09ff, 0x09ef, 

            0x0000, 0x0000, 0x2400, 0x0909, 0x0900, 0x2203, 0x003f, // 0x3A - 0x40

            /* Lettres Majuscules A-Z (Index 0x41 à 0x5A) */
            0x09f7, 0x2a0f, 0x0039, 0x220f, 0x0979, 0x0971, 0x01bd, 0x09f6, 
            0x2209, 0x001e, 0x2470, 0x0038, 0x0536, 0x1136, 0x003f, 0x09f3, 
            0x103f, 0x19f3, 0x09ed, 0x2201, 0x003e, 0x4430, 0x5036, 0x5500, 
            0x2500, 0x4409,

            0x0039, 0x4400, 0x000f, 0x0000, 0x0008, 0x0100, // 0x5B - 0x60

            /* Lettres Minuscules a-z (Mappées en Majuscules par sécurité d'affichage) */
            0x09f7, 0x2a0f, 0x0039, 0x220f, 0x0979, 0x0971, 0x01bd, 0x09f6, 
            0x2209, 0x001e, 0x2470, 0x0038, 0x0536, 0x1136, 0x003f, 0x09f3, 
            0x103f, 0x19f3, 0x09ed, 0x2201, 0x003e, 0x4430, 0x5036, 0x5500, 
            0x2500, 0x4409,

            0x0000, 0x0000, 0x0000, 0x0000
        ]);

        // Démarre la boucle d'actualisation synchronisée à la fréquence de l'écran (60Hz)
        this.startRenderLoop();
    }

    /**
     * Interpréteur de commandes (Grammaire Query String de ton connecteur)
     * Reçoit des trames comme : "!display:action=write&text=BALLS"
     */
    parseCommand(commandString) {
        if (!commandString.startsWith('!display:')) return;

        const params = new URLSearchParams(commandString.split('!display:')[1]);
        const action = params.get('action');

        switch (action) {
            case 'clear':
                this.vfdCells.fill(0);
                this.cursorPosition = 0;
                break;

            case 'move':
                const pos = parseInt(params.get('pos'), 10);
                if (pos >= 0 && pos < 40) {
                    this.cursorPosition = pos;
                }
                break;

            case 'write': {
                const posParam = params.get('pos');
                if (posParam !== null) this.cursorPosition = parseInt(posParam, 10);
                const text = params.get('text') || "";
                for (let i = 0; i < text.length; i++) {
                    if (this.cursorPosition >= 40) break;
                    let charCode = text.charCodeAt(i);
                    let baseChar = charCode & 0x7F; // On isole les 7 bits ASCII standards
                    let mask = this.ascii2gottlieb[baseChar];
                    
                    // 🎯 TRAITEMENT DE LA PONCTUATION FUSIONNÉE :
                    // Si l'octet porte le bit 0x80 (ex: code 0xB2), le décodeur applique 
                    // automatiquement le masque physique du point décimal sur le caractère courant.
                    if (charCode & 0x80) {
                        mask |= 0x8000; 
                    }

                    this.vfdCells[this.cursorPosition] = mask;
                    this.cursorPosition++;
                }
                break;
            }
        }
    }

    /**
     * Moteur de rendu graphique vectoriel (Le "faux" HTML/CSS des segments)
     */
    drawSegmentCharacter(x, y, mask) {
        const ctx = this.ctx;
        ctx.save();
        ctx.translate(x, y);
        ctx.transform(1, 0, -0.15, 1, 0, 0); // Effet d'inclinaison italique d'origine
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        // Fonction d'allumage physique d'un filament
        const drawSeg = (bit, drawFn) => {
            if (mask & bit) {
                ctx.strokeStyle = '#00ffff';      // Couleur Gaz Cyan Néon
                ctx.shadowBlur = 10;              // Intensité du rayonnement
                ctx.shadowColor = '#00ffff';      // Teinte du halo lumineux (Glow)
            } else {
                ctx.strokeStyle = '#101a1a';      // Filament éteint résiduel (Sombre)
                ctx.shadowBlur = 0;
            }
            ctx.beginPath();
            drawFn();
            ctx.stroke();
        };

        const w = this.CHAR_WIDTH;
        const h = this.CHAR_HEIGHT;
        const m = h / 2;
        const hw = w / 2;

        // Mappage unitaire des bits physiques vers les coordonnées de traçage Canvas
        drawSeg(0x0001, () => { ctx.moveTo(2, 0); ctx.lineTo(w - 2, 0); });       // A (Horizontal Haut)
        drawSeg(0x0002, () => { ctx.moveTo(w, 2); ctx.lineTo(w, m - 2); });       // B (Vertical Haut Droit)
        drawSeg(0x0004, () => { ctx.moveTo(w, m + 2); ctx.lineTo(w, h - 2); });   // C (Vertical Bas Droit)
        drawSeg(0x0008, () => { ctx.moveTo(2, h); ctx.lineTo(w - 2, h); });       // D (Horizontal Bas)
        drawSeg(0x0010, () => { ctx.moveTo(0, m + 2); ctx.lineTo(0, h - 2); });   // E (Vertical Bas Gauche)
        drawSeg(0x0020, () => { ctx.moveTo(0, 2); ctx.lineTo(0, m - 2); });       // F (Vertical Haut Gauche)
        drawSeg(0x0040, () => { ctx.moveTo(2, m); ctx.lineTo(hw - 2, m); });       // G1 (Barre centrale Gauche)
        drawSeg(0x0800, () => { ctx.moveTo(hw + 2, m); ctx.lineTo(w - 2, m); });   // G2 (Barre centrale Droite)
        
        // Étoile interne (Diagonales et barres verticales centrales)
        drawSeg(0x0100, () => { ctx.moveTo(2, 2); ctx.lineTo(hw - 2, m - 2); });  // Diagonale Haut-Gauche
        drawSeg(0x0200, () => { ctx.moveTo(hw, 2); ctx.lineTo(hw, m - 3); });     // Verticale Haute
        drawSeg(0x0400, () => { ctx.moveTo(w - 2, 2); ctx.lineTo(hw + 2, m - 2); });// Diagonale Haut-Droite
        drawSeg(0x4000, () => { ctx.moveTo(2, h - 2); ctx.lineTo(hw - 2, m + 2); });// Diagonale Bas-Gauche
        drawSeg(0x2000, () => { ctx.moveTo(hw, h - 4); ctx.lineTo(hw, m + 3); }); // Verticale Basse
        drawSeg(0x1000, () => { ctx.moveTo(w - 2, h - 2); ctx.lineTo(hw + 2, m + 2); }); // Diagonale Bas-Droite
        
        // Attributs spéciaux hors-matrice (Ponctuations)
        drawSeg(0x0080, () => { ctx.moveTo(w + 2, h); ctx.lineTo(w + 6, h + 8); }); // Queue de la Virgule
        drawSeg(0x8000, () => { ctx.arc(w + 4, h, 2, 0, Math.PI * 2); });           // Point décimal

        ctx.restore();
    }

    /**
     * Execute le balayage graphique global
     */
    render() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        for (let i = 0; i < 20; i++) {
            // Ligne supérieure : Indices 0 à 19
            this.drawSegmentCharacter(30 + i * (this.CHAR_WIDTH + this.SPACING), 40, this.vfdCells[i]);
            // Ligne inférieure : Indices 20 à 39
            this.drawSegmentCharacter(30 + i * (this.CHAR_WIDTH + this.SPACING), 140, this.vfdCells[20 + i]);
        }
    }

    startRenderLoop() {
        const loop = () => {
            this.render();
            requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
    }
}

// Globalisation pour l'IHM
window.GottliebDisplayEmulator = GottliebDisplayEmulator;