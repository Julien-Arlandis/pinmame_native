// node-adapter.js
// Node.js adapter entry for the shared emulator core.

const { createEmulator } = require('./emulator-core.js');
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const options = {};
for (const arg of args) {
    if (arg.startsWith('--rom=')) options.rom = arg.split('=')[1];
    else if (arg.startsWith('--custom-rom=')) options.customRom = arg.split('=')[1];
    else if (arg.startsWith('--audio-out=')) options.audioOut = arg.split('=')[1];
}

const romName = options.rom || 'bonebstr';
let customRomBytes = null;
let customRomName = null;

if (options.customRom) {
    const romPath = path.resolve(process.cwd(), options.customRom);
    if (!fs.existsSync(romPath)) {
        console.error(`Le fichier ROM personnalisé est introuvable : ${romPath}`);
        process.exit(1);
    }
    const bytes = fs.readFileSync(romPath);
    customRomBytes = new Uint8Array(bytes).buffer;
    customRomName = path.basename(romPath);
}

const audioOutputStream = options.audioOut ? fs.createWriteStream(path.resolve(process.cwd(), options.audioOut)) : null;
let speaker = null;
try {
    const Speaker = require('speaker');
    speaker = new Speaker({ channels: 2, bitDepth: 16, sampleRate: 44100, signed: true });
    console.log('🔊 Speaker module détecté : sortie audio activée.');
} catch (err) {
    if (options.audioOut) console.log(`📝 Audio écrit dans ${options.audioOut}`);
    else console.log('⚠️ Pas de module speaker installé. Le son sera désactivé.');
}

function floatTo16BitPCM(left, right) {
    const buffer = Buffer.alloc(left.length * 4);
    for (let i = 0; i < left.length; i++) {
        let sampleL = Math.max(-1, Math.min(1, left[i]));
        let sampleR = Math.max(-1, Math.min(1, right[i]));
        buffer.writeInt16LE(Math.round(sampleL * 0x7fff), i * 4);
        buffer.writeInt16LE(Math.round(sampleR * 0x7fff), i * 4 + 2);
    }
    return buffer;
}

globalThis.onEmulatorMessage = function(message) {
    switch (message.type) {
        case 'STATUS':
            console.log(message.data);
            break;
        case 'LOG':
            console.log('[EMULATOR]', message.data);
            break;
        case 'ENGINE_READY':
            console.log(`✅ Engine ready: ${message.payload.romName}`);
            break;
        case 'AUDIO_CMD_LOG':
            console.log(`[AUDIO CMD] ${message.payload.cmdId}`);
            break;
        case 'AUDIO_DATA': {
            const { left, right } = message.payload;
            const pcm = floatTo16BitPCM(left, right);
            if (speaker) speaker.write(pcm);
            if (audioOutputStream) audioOutputStream.write(pcm);
            break;
        }
        case 'VFD_UPDATE':
            console.log('[VFD_UPDATE] segments reçus');
            break;
        case 'LAMPS_UPDATE':
            console.log('[LAMPS_UPDATE] lampes reçues');
            break;
        case 'DRIVER_ORDER':
            console.log(`[DRIVER_ORDER] id=${message.payload.id} state=${message.payload.state}`);
            break;
        default:
            console.log('[EMULATOR MESSAGE]', message.type, message.payload);
    }
};

(async () => {
    const emulator = createEmulator();
    await emulator.sendMessage('INIT_ENGINE', {
        customRomBytes,
        customRomName: customRomName || romName
    });

    console.log('🎛️  Démarrage de l’émulateur Node.js...');
})();
