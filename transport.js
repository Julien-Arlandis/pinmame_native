// transport.js
// Transport layer — WorkerTransport (local runtime.js) and SerialTransport (WebSerial hardware)
//
// Protocol lines:
//   INPUT  channel (hardware → master): @set:id=X&state=Y  |  @dip:id=X&state=Y
//   DRIVER channel (master → hardware): !set:id=X&state=Y  |  !lamp:col=X&mask=Y
//   DISPLAY channel (master → hardware): !display:action=write&pos=X&text=Y
//   STATUS channel (master → UI): @status:state=ready&rom=X
//
// Handshake: on connect, hardware sends "@device:type=input&version=1\n"

// ── WorkerTransport ──────────────────────────────────────────────────────────

class WorkerTransport {
    constructor() {
        this._worker = new Worker('runtime.js');
        this._callbacks = [];
        this._worker.onmessage = (e) => {
            const msg = e.data;
            if (msg.channel) {
                for (const cb of this._callbacks) cb(msg.channel, msg.line || null, msg);
            }
        };
    }

    send(channel, line) {
        this._worker.postMessage({ channel, line });
    }

    onMessage(cb) { this._callbacks.push(cb); }

    get type() { return 'worker'; }
    get connectedTypes() { return { input: 1, driver: 1, display: 1 }; }
}

// ── SerialTransport ──────────────────────────────────────────────────────────

async function* readSerialLines(port) {
    const decoder = new TextDecoder();
    let buffer = '';
    const reader = port.readable.getReader();
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let nl;
            while ((nl = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, nl).trim();
                buffer = buffer.slice(nl + 1);
                if (line) yield line;
            }
        }
    } finally {
        reader.releaseLock();
    }
}

class SerialTransport {
    constructor() {
        this._ports   = { input: [], driver: [], display: [] };
        this._writers = { input: [], driver: [], display: [] };
        this._callbacks = [];
    }

    onMessage(cb) { this._callbacks.push(cb); }

    // Send a line to all ports of a given channel
    send(channel, line) {
        const writers = this._writers[channel] || [];
        const encoded = new TextEncoder().encode(line + '\n');
        for (const writer of writers) writer.write(encoded).catch(() => {});
    }

    // Identify a port via handshake and register it
    async addPort(port) {
        try {
            await port.open({ baudRate: 115200 });
        } catch {
            if (!port.readable) return null; // already open or failed
        }

        const deviceType = await this._readHandshake(port);
        if (!deviceType || !this._ports[deviceType]) return null;

        const writer = port.writable.getWriter();
        this._ports[deviceType].push(port);
        this._writers[deviceType].push(writer);
        this._startReadLoop(port, deviceType);
        return deviceType;
    }

    async _readHandshake(port) {
        // Read up to 2 s to find "@device:type=..." line
        const decoder = new TextDecoder();
        let buf = '';
        const reader = port.readable.getReader();
        const deadline = Date.now() + 2000;
        try {
            while (Date.now() < deadline) {
                const timeout = new Promise(r => setTimeout(() => r({ value: null, done: true }), 300));
                const { value, done } = await Promise.race([reader.read(), timeout]);
                if (done || !value) break;
                buf += decoder.decode(value, { stream: true });
                const nl = buf.indexOf('\n');
                if (nl !== -1) {
                    const line = buf.slice(0, nl).trim();
                    if (line.startsWith('@device:')) {
                        const p = new URLSearchParams(line.slice(8));
                        return p.get('type'); // 'input' | 'driver' | 'display'
                    }
                    break;
                }
            }
        } finally {
            reader.releaseLock();
        }
        return null;
    }

    _startReadLoop(port, channel) {
        (async () => {
            try {
                for await (const line of readSerialLines(port)) {
                    for (const cb of this._callbacks) cb(channel, line, { channel, line });
                }
            } catch {
                console.warn(`[SerialTransport] port ${channel} déconnecté`);
                // Remove from lists
                const idx = this._ports[channel].indexOf(port);
                if (idx !== -1) {
                    this._ports[channel].splice(idx, 1);
                    this._writers[channel].splice(idx, 1);
                }
            }
        })();
    }

    get type() { return 'serial'; }

    get connectedTypes() {
        return {
            input:   this._ports.input.length,
            driver:  this._ports.driver.length,
            display: this._ports.display.length
        };
    }
}

// ── Discovery ────────────────────────────────────────────────────────────────

// Scan already-authorized ports (no user gesture needed)
async function scanAuthorizedPorts(transport) {
    if (!navigator.serial) return;
    const ports = await navigator.serial.getPorts();
    for (const port of ports) await transport.addPort(port);
}

// Request a new port — must be called from a user gesture handler
async function requestNewPort(transport) {
    if (!navigator.serial) throw new Error('WebSerial non disponible');
    const port = await navigator.serial.requestPort();
    return transport.addPort(port); // returns device type or null
}

// Main entry point: try serial hardware first, fall back to local Worker
async function createTransport() {
    if (typeof navigator !== 'undefined' && navigator.serial) {
        const serial = new SerialTransport();
        await scanAuthorizedPorts(serial);
        const ct = serial.connectedTypes;
        if (ct.input + ct.driver + ct.display > 0) return serial;
    }
    return new WorkerTransport();
}
