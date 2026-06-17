// transport/worker.js — Web Worker local (flip-g80 embarqué)
// Retourne un transport { send, onMessage, onAudio, onCapture, onScope, onDisconnect, disconnect, name }

async function createWorkerTransport() {
    const resp = await fetch('flip-g80', { cache: 'no-store' });
    const bytes = new Uint8Array(await resp.arrayBuffer());

    const markerBytes = new TextEncoder().encode('\n/* __WASM__\n');
    let markerPos = -1;
    outer: for (let i = bytes.length - markerBytes.length; i >= 0; i--) {
        for (let j = 0; j < markerBytes.length; j++) {
            if (bytes[i + j] !== markerBytes[j]) continue outer;
        }
        markerPos = i; break;
    }

    const jsBytes = markerPos !== -1 ? bytes.subarray(0, markerPos) : bytes;
    let wasmBytes  = null;

    if (markerPos !== -1) {
        const endMarker = new TextEncoder().encode('\n*/');
        let endPos = -1;
        outer2: for (let i = bytes.length - endMarker.length; i > markerPos; i--) {
            for (let j = 0; j < endMarker.length; j++) {
                if (bytes[i + j] !== endMarker[j]) continue outer2;
            }
            endPos = i; break;
        }
        if (endPos !== -1) {
            const raw = bytes.subarray(markerPos + markerBytes.length, endPos);
            const out = new Uint8Array(raw.length);
            let oi = 0;
            for (let i = 0; i < raw.length; i++) {
                if (raw[i] === 0x2A && raw[i+1] === 0x5C && raw[i+2] === 0x2F) {
                    out[oi++] = 0x2A; out[oi++] = 0x2F; i += 2;
                } else { out[oi++] = raw[i]; }
            }
            wasmBytes = out.subarray(0, oi);
        }
    }

    const blob   = new Blob([new TextDecoder().decode(jsBytes)], { type: 'application/javascript' });
    const worker = new Worker(URL.createObjectURL(blob));

    let _onMessage    = null;
    let _onAudio      = null;
    let _onCapture    = null;
    let _onScope      = null;
    let _onDisconnect = null;

    if (wasmBytes) {
        const buf = wasmBytes.buffer.slice(wasmBytes.byteOffset, wasmBytes.byteOffset + wasmBytes.byteLength);
        worker.postMessage({ type: 'WASM_BINARY', data: buf }, [buf]);
    }

    worker.onmessage = ({ data: msg }) => {
        if      (msg.channel === 'audio')   _onAudio?.(msg.left, msg.right);
        else if (msg.channel === 'capture') _onCapture?.(msg);
        else if (msg.channel === 'scope')   _onScope?.(msg);
        else if (msg.line)                  _onMessage?.(msg.line);
    };

    const customRomBytes = sessionStorage.getItem('custom_rom_bytes') || null;
    const customRomName  = sessionStorage.getItem('custom_rom_filename')
        || new URLSearchParams(location.search).get('rom')
        || null;
    worker.postMessage({ type: 'INIT_ENGINE', payload: { customRomBytes, customRomName, baseUrl: location.href } });

    return {
        name: 'Local (Worker)',
        isLocal: true,
        send(line)         { worker.postMessage({ channel: 'input', line }); },
        onMessage(cb)      { _onMessage    = cb; },
        onAudio(cb)        { _onAudio      = cb; },
        onCapture(cb)      { _onCapture    = cb; },
        onScope(cb)        { _onScope      = cb; },
        onDisconnect(cb)   { _onDisconnect = cb; },
        disconnect()       { worker.terminate(); _onDisconnect?.(); },
    };
}
