// display/gottlieb-80b.js — Afficheur Gottlieb System 80B
// 14 segments alphanumériques, 2 lignes × 20 caractères (40 cellules)
// Protocole : !display:action=raw&data=<160 hex chars>  (uint16 par cellule)

class GottliebDisplay80B {
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        if (!this.canvas) throw new Error(`Canvas '${canvasId}' introuvable`);
        this.ctx = this.canvas.getContext('2d');
        this.CHAR_WIDTH = 40; this.CHAR_HEIGHT = 70; this.SPACING = 15;
        this.CELLS = 40; this.COLS = 20;
        this.vfdCells = new Uint16Array(this.CELLS);
        this.cursorPosition = 0;
        this._dirty = false;
        this._overrideActive = false;
        this._overrideL1 = '';
        this._overrideL2 = '';
        this._overrideDirL1 = 'none';
        this._overrideDirL2 = 'none';
        this._overrideOffsetL1 = 0;
        this._overrideOffsetL2 = 0;
        this._overrideTimerL1 = null;
        this._overrideTimerL2 = null;
        // ASCII → masque 14 segments PinMAME
        // Bits : a=0x0001 b=0x0002 c=0x0004 d=0x0008 e=0x0010 f=0x0020
        //        g1=0x0040 g2=0x0800 i=0x0100 j=0x0200 k=0x0400
        //        l=0x1000 m=0x2000 n=0x4000 dp=0x0080
        const _a2s = {
            ' ':0x0000,'!':0x0006,'"':0x0202,'#':0x0A8D,'$':0x086D,
            '%':0x1CE8,'&':0x2AF5,'\'':0x0200,'(':0x0039,')':0x000F,
            '*':0x7F40,'+':0x2A40,',':0x4000,'-':0x0840,'.':0x0080,
            '/':0x4400,':':0x2200,';':0x4200,'<':0x1400,'=':0x0849,
            '>':0x0500,'?':0x2203,'@':0x2A3F,'[':0x0039,'\\':0x1100,
            ']':0x000F,'^':0x0500,'_':0x0008,'`':0x0100,'{':0x2240,
            '|':0x2200,'}':0x0A09,'~':0x0840,
            '0':0x003F,'1':0x0006,'2':0x085B,'3':0x084F,'4':0x0866,
            '5':0x086D,'6':0x087D,'7':0x0007,'8':0x087F,'9':0x086F,
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
        for (let i = 0; i < this.CELLS; i++) {
            const mask = parseInt(hex.slice(i * 4, i * 4 + 4), 16) || 0;
            if (mask === 0) { s += ' '; continue; }
            const ch = this.gottlieb2ascii.get(mask);
            s += ch !== undefined ? ch : `[${mask.toString(16)}]`;
        }
        return s;
    }

    _enableOverrideLine(n, text, dir, speedMs, resetOffset = true) {
        const tKey = `_overrideTimerL${n}`, oKey = `_overrideOffsetL${n}`, dKey = `_overrideDirL${n}`, lKey = `_overrideL${n}`;
        this[lKey] = (text || '').toUpperCase();
        this[dKey] = dir || 'none';
        if (resetOffset) {
            if ((dir || 'none') === 'none') {
                const len = Math.min((text || '').length, this.COLS);
                this[oKey] = this.COLS - Math.floor((this.COLS - len) / 2);
            } else {
                this[oKey] = 0;
            }
        }
        if (this[tKey]) { clearInterval(this[tKey]); this[tKey] = null; }
        this._applyOverride();
        if (this[dKey] !== 'none') {
            this[tKey] = setInterval(() => {
                if (this[dKey] === 'left') this[oKey]++;
                else this[oKey]--;
                this._applyOverride();
            }, speedMs || 100);
        }
    }

    enableOverride(l1, l2, dirL1, dirL2, speedMs) {
        this._overrideActive = true;
        this._enableOverrideLine(1, l1, dirL1, speedMs);
        this._enableOverrideLine(2, l2, dirL2, speedMs);
    }

    disableOverride() {
        this._overrideActive = false;
        if (this._overrideTimerL1) { clearInterval(this._overrideTimerL1); this._overrideTimerL1 = null; }
        if (this._overrideTimerL2) { clearInterval(this._overrideTimerL2); this._overrideTimerL2 = null; }
        this._dirty = true;
    }

    _getScrollWindow(text, offset) {
        if (!text) return ' '.repeat(this.COLS);
        const total = text.length + this.COLS;
        const o = ((offset % total) + total) % total;
        const padded = ' '.repeat(this.COLS) + text + ' '.repeat(this.COLS);
        const doubled = padded + padded;
        return doubled.slice(o, o + this.COLS).padEnd(this.COLS, ' ');
    }

    _applyOverride() {
        const w1 = this._getScrollWindow(this._overrideL1, this._overrideOffsetL1);
        const w2 = this._getScrollWindow(this._overrideL2, this._overrideOffsetL2);
        for (let i = 0; i < this.COLS; i++) {
            this.vfdCells[i]            = this.ascii2gottlieb[w1.charCodeAt(i) & 0x7F] || 0;
            this.vfdCells[this.COLS + i] = this.ascii2gottlieb[w2.charCodeAt(i) & 0x7F] || 0;
        }
        this._dirty = true;
    }

    parseCommand(cmd) {
        if (!cmd || !cmd.startsWith('!display:')) return;
        if (this._overrideActive) return;
        const params = new URLSearchParams(cmd.slice(9));
        switch (params.get('action')) {
            case 'raw': {
                const data = params.get('data') || '';
                for (let i = 0; i < this.CELLS; i++)
                    this.vfdCells[i] = parseInt(data.slice(i * 4, i * 4 + 4), 16) || 0;
                break;
            }
            case 'clear': this.vfdCells.fill(0); this.cursorPosition = 0; break;
            case 'move': {
                const p = parseInt(params.get('pos'), 10);
                if (p >= 0 && p < this.CELLS) this.cursorPosition = p;
                break;
            }
            case 'write': {
                const posParam = params.get('pos');
                if (posParam !== null) this.cursorPosition = parseInt(posParam, 10);
                const text = params.get('text') || '';
                for (let i = 0; i < text.length && this.cursorPosition < this.CELLS; i++) {
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

    _drawDigit(x, y, mask) {
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
        for (let i = 0; i < this.COLS; i++) {
            this._drawDigit(30 + i * (this.CHAR_WIDTH + this.SPACING), 40,  this.vfdCells[i]);
            this._drawDigit(30 + i * (this.CHAR_WIDTH + this.SPACING), 140, this.vfdCells[this.COLS + i]);
        }
    }

    _startRenderLoop() {
        const loop = () => { if (this._dirty) { this._dirty = false; this._render(); } requestAnimationFrame(loop); };
        requestAnimationFrame(loop);
    }
}
