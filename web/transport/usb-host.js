// transport/usb-host.js — USB hôte série (navigateur, WebSerial API)
// Retourne un transport { send, onMessage, onConnect, onDisconnect, disconnect, name }

async function createUsbHostTransport({ baudRate = 115200 } = {}) {
    if (!navigator.serial) throw new Error('WebSerial non supporté (Chrome/Edge requis)');

    const port = await navigator.serial.requestPort();
    await port.open({ baudRate });

    let _onMessage    = null;
    let _onDisconnect = null;
    let _running      = true;

    const writer  = port.writable.getWriter();
    const encoder = new TextEncoder();

    async function send(line) {
        try { await writer.write(encoder.encode(line + '\n')); } catch {}
    }

    async function readLoop() {
        const decoder = new TextDecoder();
        let lineBuffer = '';
        const reader = port.readable.getReader();
        try {
            while (_running) {
                const { value, done } = await reader.read();
                if (done) break;
                lineBuffer += decoder.decode(value);
                const parts = lineBuffer.split('\n');
                lineBuffer  = parts.pop();
                for (const l of parts) {
                    const trimmed = l.trim();
                    if (trimmed) _onMessage?.(trimmed);
                }
            }
        } catch {
            // port fermé ou erreur
        } finally {
            reader.releaseLock();
            _onDisconnect?.();
        }
    }

    readLoop();

    port.addEventListener('disconnect', () => {
        _running = false;
        _onDisconnect?.();
    });

    const info = await port.getInfo();
    const name = info.usbVendorId
        ? `USB 0x${info.usbVendorId.toString(16)}:0x${(info.usbProductId ?? 0).toString(16)}`
        : 'USB Série';

    async function disconnect() {
        _running = false;
        try { writer.releaseLock(); await port.close(); } catch {}
    }

    return {
        name,
        send,
        onMessage(cb)    { _onMessage    = cb; },
        onDisconnect(cb) { _onDisconnect = cb; },
        disconnect,
    };
}
