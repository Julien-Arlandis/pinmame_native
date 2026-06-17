'use strict';
// transport/ws-server.js — WebSocket serveur (Node.js, zéro dépendance)
// Retourne un transport broadcast { send, onMessage, onConnect, onDisconnect, listen }

const crypto = require('node:crypto');
const http   = require('node:http');

class _WS {
    constructor(socket) {
        this.socket = socket; this.readyState = 1;
        this._ev = {}; this._buf = Buffer.alloc(0);
        socket.on('data',  d => this._onData(d));
        socket.on('close', () => { this.readyState = 3; this._emit('close'); });
        socket.on('error', e => this._emit('error', e));
    }
    on(e, cb) { (this._ev[e] = this._ev[e] || []).push(cb); return this; }
    _emit(e, ...a) { (this._ev[e] || []).forEach(cb => cb(...a)); }
    send(msg) {
        if (this.readyState !== 1) return;
        const d = Buffer.from(msg); const n = d.length;
        let h;
        if (n < 126)      { h = Buffer.alloc(2);  h[0]=0x81; h[1]=n; }
        else if (n<65536) { h = Buffer.alloc(4);  h[0]=0x81; h[1]=126; h.writeUInt16BE(n,2); }
        else              { h = Buffer.alloc(10); h[0]=0x81; h[1]=127; h.writeBigUInt64BE(BigInt(n),2); }
        try { this.socket.write(Buffer.concat([h, d])); } catch {}
    }
    _onData(chunk) {
        this._buf = Buffer.concat([this._buf, chunk]);
        while (this._buf.length >= 2) {
            const b0=this._buf[0], b1=this._buf[1];
            const masked=!!(b1&0x80); let len=b1&0x7f, off=2;
            if (len===126){ if(this._buf.length<4)return; len=this._buf.readUInt16BE(2); off=4; }
            else if(len===127){ if(this._buf.length<10)return; len=Number(this._buf.readBigUInt64BE(2)); off=10; }
            const need=off+(masked?4:0)+len;
            if(this._buf.length<need)return;
            let payload;
            if (masked) {
                const mask=this._buf.slice(off,off+4); off+=4;
                payload=Buffer.alloc(len);
                for(let i=0;i<len;i++) payload[i]=this._buf[off+i]^mask[i%4];
            } else { payload=this._buf.slice(off,off+len); }
            this._buf=this._buf.slice(off+len);
            const op=b0&0x0f;
            if(op===1||op===2) this._emit('message', payload);
            else if(op===8){ this.readyState=3; this.socket.end(); this._emit('close'); }
        }
    }
}

function createWsServerTransport(port, log) {
    const clients     = new Set();
    let _onMessage    = null;
    let _onConnect    = null;
    let _onDisconnect = null;

    function send(line) {
        for (const ws of clients) if (ws.readyState === 1) ws.send(line);
    }

    const server = http.createServer();
    server.on('error', e => log(`⚠️  WebSocket: ${e.message}`));
    server.on('upgrade', (req, socket) => {
        const key = req.headers['sec-websocket-key'];
        if (!key) { socket.end(); return; }
        const accept = crypto.createHash('sha1')
            .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        socket.write(
            'HTTP/1.1 101 Switching Protocols\r\n' +
            'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
            `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
        );
        const ws = new _WS(socket);
        clients.add(ws);
        ws.send('@master:name=flip-g80-node&version=1');
        _onConnect?.(line => ws.send(line));
        ws.on('message', data => _onMessage?.(data.toString().trim(), line => ws.send(line)));
        const disconnect = () => {
            if (!clients.has(ws)) return;
            clients.delete(ws);
            log('  [WS]      déconnecté');
            _onDisconnect?.();
        };
        ws.on('close', disconnect);
        ws.on('error', disconnect);
    });

    function listen() {
        server.listen(port);
        log(`  WebSocket: ws://localhost:${port}`);
    }

    return {
        name: `WS :${port}`,
        send,
        onMessage(cb)    { _onMessage    = cb; },
        onConnect(cb)    { _onConnect    = cb; },
        onDisconnect(cb) { _onDisconnect = cb; },
        listen,
        clientCount()    { return clients.size; },
    };
}

module.exports = { createWsServerTransport };
