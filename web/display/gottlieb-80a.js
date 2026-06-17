// display/gottlieb-80a.js — Afficheur Gottlieb System 80A
// 7 segments comme le System 80, mais 20 cellules (layout 2 × 10)
// Certains jeux 80A ont un afficheur d'état supplémentaire sur la ligne 3.
// Protocole : !display:action=raw&data=<N×4 hex chars>  (uint16, seul octet bas utilisé)

class GottliebDisplay80A {
    // Même encodage 7 segments que GottliebDisplay80
    static DIGIT = GottliebDisplay80.DIGIT;

    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        if (!this.canvas) throw new Error(`Canvas '${canvasId}' introuvable`);
        this.ctx = this.canvas.getContext('2d');
        this.CELLS      = 20; // 4 × 5 chiffres (certains jeux 80A ont 6 : ajuster ici)
        this.COLS       = 10;
        this.CHAR_WIDTH = 36; this.CHAR_HEIGHT = 62; this.SPACING = 10;
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

    enableOverride()  {}
    disableOverride() { this._dirty = true; }

    _drawDigit(x, y, mask) {
        const ctx = this.ctx, w = this.CHAR_WIDTH, h = this.CHAR_HEIGHT, m = h / 2;
        ctx.save(); ctx.translate(x, y);
        ctx.lineWidth = 3; ctx.lineCap = 'butt';
        const seg = (bit, fn) => {
            ctx.strokeStyle = (mask & bit) ? '#ffcc00' : '#1a1000';
            ctx.shadowBlur  = (mask & bit) ? 8 : 0;
            ctx.shadowColor = '#ffcc00';
            ctx.beginPath(); fn(); ctx.stroke();
        };
        seg(0x01,()=>{ctx.moveTo(3,0);ctx.lineTo(w-3,0)});
        seg(0x02,()=>{ctx.moveTo(w,3);ctx.lineTo(w,m-3)});
        seg(0x04,()=>{ctx.moveTo(w,m+3);ctx.lineTo(w,h-3)});
        seg(0x08,()=>{ctx.moveTo(3,h);ctx.lineTo(w-3,h)});
        seg(0x10,()=>{ctx.moveTo(0,m+3);ctx.lineTo(0,h-3)});
        seg(0x20,()=>{ctx.moveTo(0,3);ctx.lineTo(0,m-3)});
        seg(0x40,()=>{ctx.moveTo(3,m);ctx.lineTo(w-3,m)});
        seg(0x80,()=>{ctx.arc(w+4,h,2.5,0,Math.PI*2);ctx.fill()});
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
