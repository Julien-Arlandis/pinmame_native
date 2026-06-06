// audio.js — Sortie audio navigateur (thread principal uniquement)
// Ring buffer alimenté par le Worker via feedAudioRingBuffer(),
// lu par un ScriptProcessor connecté à l'AudioContext.

const RING_BUFFER_SIZE = 131072;
const ringBufferL = new Float32Array(RING_BUFFER_SIZE);
const ringBufferR = new Float32Array(RING_BUFFER_SIZE);
let audioWritePtr = 0, audioReadPtr = 0;
let lastSampleL = 0, lastSampleR = 0;
let audioCtx = null, audioNode = null;
let isBufferWarming = false;

function feedAudioRingBuffer(left, right) {
    let inL = left, inR = right;
    if (audioCtx && audioCtx.sampleRate !== 44100) {
        const ratio = 44100 / audioCtx.sampleRate;
        const n = Math.round(left.length / ratio);
        inL = new Float32Array(n);
        inR = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            const src = i * ratio;
            const i0  = src | 0;
            const i1  = i0 + 1 < left.length ? i0 + 1 : i0;
            const f   = src - i0;
            inL[i] = left[i0]  * (1 - f) + left[i1]  * f;
            inR[i] = right[i0] * (1 - f) + right[i1] * f;
        }
    }
    for (let i = 0; i < inL.length; i++) {
        ringBufferL[audioWritePtr] = inL[i];
        ringBufferR[audioWritePtr] = inR[i];
        audioWritePtr = (audioWritePtr + 1) % RING_BUFFER_SIZE;
    }
}

function resetAudioRead() {
    audioReadPtr = audioWritePtr;
    isBufferWarming = true;
}

function unlockAudio(master) {
    if (audioCtx) {
        if (audioCtx.state === 'suspended') audioCtx.resume().then(resetAudioRead).catch(() => {});
        return;
    }
    try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)(); // pas de sampleRate forcé — Android choisit sa fréquence native
        logToTerminal(`📊 Audio: ${audioCtx.sampleRate}Hz, état: ${audioCtx.state}`);
        resetAudioRead();
        if (audioCtx.state === 'suspended') {
            audioCtx.resume().catch(() => {});
        }

        audioNode = audioCtx.createScriptProcessor(4096, 1, 2);
        // Oscillateur silencieux : force Android à activer le ScriptProcessor (sans entrée active il reste muet)
        const dummyOsc = audioCtx.createOscillator();
        dummyOsc.connect(audioNode);
        dummyOsc.start();

        audioNode.onaudioprocess = function(e) {
            const outL = e.outputBuffer.getChannelData(0);
            const outR = e.outputBuffer.getChannelData(1);
            const distance = (audioWritePtr - audioReadPtr + RING_BUFFER_SIZE) % RING_BUFFER_SIZE;
            if (isBufferWarming) {
                if (distance >= 4096) isBufferWarming = false;
                for (let i = 0; i < outL.length; i++) outL[i] = outR[i] = 0;
                return;
            }
            for (let i = 0; i < outL.length; i++) {
                if (audioReadPtr !== audioWritePtr) {
                    lastSampleL = ringBufferL[audioReadPtr];
                    lastSampleR = ringBufferR[audioReadPtr];
                    audioReadPtr = (audioReadPtr + 1) % RING_BUFFER_SIZE;
                } else { lastSampleL *= 0.90; lastSampleR *= 0.90; }
                outL[i] = lastSampleL; outR[i] = lastSampleR;
            }
            // Overflow : sauter en avant pour éviter la corruption du ring buffer
            if (distance > 32768) audioReadPtr = (audioWritePtr - 8192 + RING_BUFFER_SIZE) % RING_BUFFER_SIZE;
        };
        audioNode.connect(audioCtx.destination);
        logToTerminal('🔊 Flux audio connecté.');
    } catch (err) { logToTerminal(`❌ Erreur audio: ${err.message}`); }
}
