// transport/ws-client.js — WebSocket client (navigateur)
// Retourne un transport { send, onMessage, onDisconnect, disconnect, name }

function createWsClientTransport(ws, name) {
    let _onMessage    = null;
    let _onDisconnect = null;

    ws.onmessage = ({ data }) => _onMessage?.(data.trim());
    ws.onclose   = ()         => _onDisconnect?.();
    ws.onerror   = ()         => _onDisconnect?.();

    return {
        name,
        send(line)       { if (ws.readyState === WebSocket.OPEN) ws.send(line); },
        onMessage(cb)    { _onMessage    = cb; },
        onDisconnect(cb) { _onDisconnect = cb; },
        disconnect()     { try { ws.close(); } catch {} },
    };
}

// Tente une connexion WS et attend le handshake @master:name=…
// Retourne un transport ou null après timeout
async function tryWsTransport(url, timeoutMs = 1500) {
    return new Promise(resolve => {
        let ws, timer;
        const done = r => { clearTimeout(timer); resolve(r); };
        timer = setTimeout(() => { try { ws?.close(); } catch {} done(null); }, timeoutMs);
        try { ws = new WebSocket(url); } catch { done(null); return; }
        ws.onmessage = ({ data }) => {
            const line = data.trim();
            if (line.startsWith('@master:')) {
                const name = new URLSearchParams(line.slice(8)).get('name') || url;
                done(createWsClientTransport(ws, name));
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
