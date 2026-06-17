// display/gottlieb-80.js — Afficheur Gottlieb System 80
// 7 segments, disposition typique : 4 joueurs × 6 chiffres + 2 (crédits/BIP)
// 26 cellules au total — layout 2 rangées × 13
// Protocole : !display:action=raw&data=<N×4 hex chars>  (uint16, seul octet bas utilisé)

class GottliebDisplay80 {
    // Masque 7 segments (octet bas du uint16 PinMAME)
    // a=0x01 b=0x02 c=0x04 d=0x08 e=0x10 f=0x20 g=0x40 dp=0x80
    static DIGIT = {
        ' ':0x00,'0':0x3F,'1':0x06,'2':0x5B,'3':0x4F,'4':0x66,
        '5':0x6D,'6':0x7D,'7':0x07,'8':0x7F,'9':0x6F,
        'A':0x77,'B':0x7C,'C':0x39,'D':0x5E,'E':0x79,'F':0x71,
        'G':0x3D,'H':0x76,'I':0x06,'J':0x1E,'L':0x38,'N':0x54,
        'O':0x3F,'P':0x73,'R':0x50,'S':0x6D,'T':0x78,'U':0x3E,
        '-':0x40,'_':0x08,'.':0x80,
    };

    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        if (!this.canvas) throw new Error(`Canvas '${canvasId}' introuvable`);
        this.ctx = this.canvas.getContext('2d');
        this.CELLS      = 26; // 4 × 6 scores + 2 crédits
        this.COLS       = 13; // colonnes par rangée
        this.CHAR_WIDTH = 32; this.CHAR_HEIGHT = 56; this.SPACING = 8;
        this.cells      = new Uint8Array(this.CELLS);
        this._dirty     = false;
        this._startRenderLoop();
    }

    decodeRaw(hex) {
        let s = '';
        for (let i = 0; i < this.CELLS; i++) {
            const mask = parseInt(hex.slice(i * 4, i * 4 + 4), 16) & 0xFF;
            s += mask === 0 ? ' ' : `[${mask.toString(16)}]`;
        }
        return s;
    }

    parseCommand(cmd) {
        if (!cmd || !cmd.startsWith('!display:')) return;
        const params = new URLSearchParams(cmd.slice(9));
        switch (params.get('action')) {
            case 'raw': {
                const data = params.get('data') || '';
                for (let i = 0; i < this.CELLS; i++)
                    this.cells[i] = parseInt(data.slice(i * 4, i * 4 + 4), 16) & 0xFF;
                break;
            }
            case 'clear': this.cells.fill(0); break;
        }
        this._dirty = true;
    }

    // Stub override (interface uniforme avec 80B)
    enableOverride()  {}
    disableOverride() { this._dirty = true; }

    _drawDigit(x, y, mask) {
        const ctx = this.ctx, w = this.CHAR_WIDTH, h = this.CHAR_HEIGHT, m = h / 2;
        ctx.save(); ctx.translate(x, y);
        ctx.lineWidth = 3; ctx.lineCap = 'butt';
        const seg = (bit, fn) => {
            ctx.strokeStyle = (mask & bit) ? '#ff8800' : '#1a0a00';
            ctx.shadowBlur  = (mask & bit) ? 8 : 0;
            ctx.shadowColor = '#ff8800';
            ctx.beginPath(); fn(); ctx.stroke();
        };
        seg(0x01,()=>{ctx.moveTo(3,0);ctx.lineTo(w-3,0)});          // a haut
        seg(0x02,()=>{ctx.moveTo(w,3);ctx.lineTo(w,m-3)});           // b haut-droit
        seg(0x04,()=>{ctx.moveTo(w,m+3);ctx.lineTo(w,h-3)});         // c bas-droit
        seg(0x08,()=>{ctx.moveTo(3,h);ctx.lineTo(w-3,h)});           // d bas
        seg(0x10,()=>{ctx.moveTo(0,m+3);ctx.lineTo(0,h-3)});         // e bas-gauche
        seg(0x20,()=>{ctx.moveTo(0,3);ctx.lineTo(0,m-3)});           // f haut-gauche
        seg(0x40,()=>{ctx.moveTo(3,m);ctx.lineTo(w-3,m)});           // g milieu
        seg(0x80,()=>{ctx.arc(w+4,h,2.5,0,Math.PI*2);ctx.fill()}); // dp
        ctx.restore();
    }

    _render() {
        const { CHAR_WIDTH: cw, CHAR_HEIGHT: ch, SPACING: sp, COLS, ctx, canvas } = this;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        for (let i = 0; i < this.CELLS; i++) {
            const col = i % COLS, row = Math.floor(i / COLS);
            const x = 20 + col * (cw + sp);
            const y = 20 + row * (ch + 20);
            this._drawDigit(x, y, this.cells[i]);
        }
    }

    _startRenderLoop() {
        const loop = () => { if (this._dirty) { this._dirty = false; this._render(); } requestAnimationFrame(loop); };
        requestAnimationFrame(loop);
    }
}
