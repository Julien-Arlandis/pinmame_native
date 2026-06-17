// transport/ble-central.js — BLE central (navigateur, Web Bluetooth)
// Retourne un transport { send, onMessage, onDisconnect, disconnect, name }

const BLE_SVC_UUID = 'ab120001-b5a3-f393-e0a9-e50e24dcca9e';
const BLE_OUT_UUID = 'ab120002-b5a3-f393-e0a9-e50e24dcca9e'; // notify → navigateur
const BLE_IN_UUID  = 'ab120003-b5a3-f393-e0a9-e50e24dcca9e'; // write  ← navigateur

const BLE_SEND_CHUNK = 511; // 512 bytes max BLE MTU - 1 octet flag

// ─── Player audio BLE — paquet 0x02 = PCM mono uint8 11025 Hz ────────────────
// L'ESP32 envoie des paquets avec data[0]=0x02 suivi d'échantillons PCM mono
// 8-bit non signé (0x80 = silence) sous-échantillonnés à 11025 Hz.
// On les joue via Web Audio en les empilant bout à bout avec un buffer de 60ms.
let _bleAudioCtx   = null;
let _bleAudioPlayAt = 0;

function _playBleAudio(samples) {
    if (!_bleAudioCtx) {
        _bleAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        _bleAudioPlayAt = 0;
    }
    const ctx = _bleAudioCtx;
    if (ctx.state === 'suspended') ctx.resume();
    const n = samples.length;
    if (!n) return;
    // createBuffer à 11025 Hz : le navigateur rééchantillonne vers son taux natif
    const buf = ctx.createBuffer(1, n, 11025);
    const ch  = buf.getChannelData(0);
    for (let i = 0; i < n; i++) ch[i] = (samples[i] - 128) / 128.0;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const now = ctx.currentTime;
    // Si on est en retard, on repart 60ms devant le curseur actuel
    if (_bleAudioPlayAt < now + 0.020) _bleAudioPlayAt = now + 0.060;
    src.start(_bleAudioPlayAt);
    _bleAudioPlayAt += n / 11025;
}

async function createBleCentralTransport() {
    // Créer (ou déverrouiller) l'AudioContext ici : on est dans le handler du clic BLE,
    // c'est la seule gesture utilisateur disponible pour autoriser l'audio sur Chrome/mobile.
    if (!_bleAudioCtx) {
        _bleAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } else {
        _bleAudioCtx.resume();
    }

    const device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: 'flip-g80' }, { services: [BLE_SVC_UUID] }],
        optionalServices: [BLE_SVC_UUID]
    });

    let _onMessage    = null;
    let _onDisconnect = null;
    let inChar        = null;
    let fragBuf       = '';
    const decoder     = new TextDecoder();

    function onNotification(e) {
        const data = new Uint8Array(e.target.value.buffer);
        // Paquets audio : data[0] = 0x02, reste = PCM mono uint8 11025 Hz
        if (data[0] === 0x02) {
            _playBleAudio(data.subarray(1));
            return;
        }
        // Paquets texte : 0x00 = suite, 0x01 = dernier chunk
        const isLast = data[0] === 0x01;
        fragBuf     += decoder.decode(data.slice(1));
        if (isLast) {
            for (const line of fragBuf.split('\n')) {
                const l = line.trim();
                if (l) _onMessage?.(l);
            }
            fragBuf = '';
        }
    }

    async function gattConnect() {
        fragBuf       = '';
        const server  = await device.gatt.connect();
        const service = await server.getPrimaryService(BLE_SVC_UUID);
        const out     = await service.getCharacteristic(BLE_OUT_UUID);
        inChar        = await service.getCharacteristic(BLE_IN_UUID);
        out.addEventListener('characteristicvaluechanged', onNotification);
        await out.startNotifications();
    }

    device.addEventListener('gattserverdisconnected', async () => {
        for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 1500));
            try {
                await gattConnect();
                send('@connect:input=1&display=1&driver=1');
                return;
            } catch {}
        }
        _onDisconnect?.();
    });

    async function send(line) {
        const encoded = new TextEncoder().encode(line);
        for (let off = 0; off < encoded.length; off += BLE_SEND_CHUNK) {
            const chunk  = encoded.subarray(off, off + BLE_SEND_CHUNK);
            const isLast = off + BLE_SEND_CHUNK >= encoded.length;
            const packet = new Uint8Array(1 + chunk.length);
            packet[0]    = isLast ? 0x01 : 0x00;
            packet.set(chunk, 1);
            await inChar.writeValueWithoutResponse(packet);
        }
    }

    await gattConnect();

    return {
        name: device.name || 'flip-g80 BLE',
        send(line)       { send(line).catch(() => {}); },
        onMessage(cb)    { _onMessage    = cb; },
        onDisconnect(cb) { _onDisconnect = cb; },
        disconnect()     { try { device.gatt.disconnect(); } catch {} },
    };
}
