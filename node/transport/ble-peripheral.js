'use strict';
// transport/ble-peripheral.js — BLE périphérique (Node.js, @abandonware/bleno)
// Retourne un transport { send, onMessage, onConnect, onDisconnect, available }

const BLE_SVC = 'ab120001b5a3f393e0a9e50e24dcca9e';
const BLE_OUT = 'ab120002b5a3f393e0a9e50e24dcca9e';
const BLE_IN  = 'ab120003b5a3f393e0a9e50e24dcca9e';
const NAME    = 'flip-g80-node';

function createBlePeripheralTransport(log) {
    let bleno;
    try { bleno = require('@abandonware/bleno'); }
    catch { log('⚠️  BLE indisponible — npm install @abandonware/bleno  (ou --no-ble)'); return null; }

    let _onMessage    = null;
    let _onConnect    = null;
    let _onDisconnect = null;
    let bleNotify     = null;
    let bleMtu        = 20;
    let bleInBuf      = '';

    function send(line) {
        if (!bleNotify) return;
        const buf = Buffer.from(line + '\n');
        for (let off = 0; off < buf.length; off += bleMtu - 1) {
            const chunk  = buf.slice(off, off + bleMtu - 1);
            const isLast = off + bleMtu - 1 >= buf.length;
            const packet = Buffer.alloc(1 + chunk.length);
            packet[0] = isLast ? 0x01 : 0x00;
            chunk.copy(packet, 1);
            bleNotify(packet);
        }
    }

    const outChar = new bleno.Characteristic({
        uuid: BLE_OUT,
        properties: ['notify'],
        onSubscribe(maxValueSize, cb) {
            bleMtu = maxValueSize; bleNotify = cb;
            log('  [BLE] client connecté');
            _onConnect?.();
        },
        onUnsubscribe() {
            bleNotify = null;
            log('  [BLE] client déconnecté');
            _onDisconnect?.();
        }
    });

    const inChar = new bleno.Characteristic({
        uuid: BLE_IN,
        properties: ['write', 'writeWithoutResponse'],
        onWriteRequest(data, offset, withoutResponse, cb) {
            const isLast = data[0] === 0x01;
            bleInBuf += data.slice(1).toString('utf8');
            if (isLast) {
                const line = bleInBuf.trim(); bleInBuf = '';
                if (line) _onMessage?.(line);
            }
            cb(bleno.Characteristic.RESULT_SUCCESS);
        }
    });

    const service = new bleno.PrimaryService({ uuid: BLE_SVC, characteristics: [outChar, inChar] });

    bleno.on('stateChange', state => {
        if (state === 'poweredOn') bleno.startAdvertising(NAME, [BLE_SVC]);
        else bleno.stopAdvertising();
    });
    bleno.on('advertisingStart', err => {
        if (!err) { bleno.setServices([service]); log(`  BLE      : advertising ${NAME}`); }
    });

    return {
        name: NAME,
        send,
        onMessage(cb)    { _onMessage    = cb; },
        onConnect(cb)    { _onConnect    = cb; },
        onDisconnect(cb) { _onDisconnect = cb; },
        isConnected()    { return bleNotify !== null; },
    };
}

module.exports = { createBlePeripheralTransport };
