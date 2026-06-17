'use strict';
// transport/usb-host.js — USB hôte série (Node.js, @serialport/serialport)
// Retourne un transport { send, onMessage, onConnect, onDisconnect, open, close }

function createUsbHostTransport({ path, baudRate = 115200, log }) {
    let SerialPort, ReadlineParser;
    try {
        ({ SerialPort } = require('@serialport/serialport'));
        ({ ReadlineParser } = require('@serialport/parser-readline'));
    } catch {
        log('⚠️  USB indisponible — npm install @serialport/serialport @serialport/parser-readline');
        return null;
    }

    let _onMessage    = null;
    let _onConnect    = null;
    let _onDisconnect = null;
    let port          = null;

    function send(line) {
        if (!port?.isOpen) return;
        port.write(line + '\n', err => { if (err) log(`⚠️  USB write: ${err.message}`); });
    }

    async function open(devicePath) {
        const p = devicePath || path;
        if (!p) throw new Error('Aucun chemin de port série fourni');
        port = new SerialPort({ path: p, baudRate, autoOpen: false });
        const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));
        parser.on('data', line => {
            const l = line.trim();
            if (l) _onMessage?.(l);
        });
        port.on('open',  () => { log(`  USB      : ${p} @ ${baudRate}`); _onConnect?.(); });
        port.on('close', () => { log('  [USB] déconnecté');               _onDisconnect?.(); });
        port.on('error', e => log(`⚠️  USB: ${e.message}`));
        await new Promise((resolve, reject) => port.open(err => err ? reject(err) : resolve()));
    }

    function close() {
        port?.close();
    }

    return {
        name: `USB ${path || '(auto)'}`,
        send,
        onMessage(cb)    { _onMessage    = cb; },
        onConnect(cb)    { _onConnect    = cb; },
        onDisconnect(cb) { _onDisconnect = cb; },
        open,
        close,
        isOpen() { return !!port?.isOpen; },
    };
}

async function listUsbPorts() {
    try {
        const { SerialPort } = require('@serialport/serialport');
        return await SerialPort.list();
    } catch { return []; }
}

module.exports = { createUsbHostTransport, listUsbPorts };
