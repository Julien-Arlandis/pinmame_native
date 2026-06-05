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
    for (let i = 0; i < left.length; i++) {
        ringBufferL[audioWritePtr] = left[i];
        ringBufferR[audioWritePtr] = right[i];
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
        // Synchronise la fréquence réelle de l'AudioContext avec le pacing du Worker
        master.send(`@audio:samplerate=${audioCtx.sampleRate}`);
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
            if (distance > 24576) audioReadPtr = (audioWritePtr - 8192 + RING_BUFFER_SIZE) % RING_BUFFER_SIZE;
        };
        audioNode.connect(audioCtx.destination);
        logToTerminal('🔊 Flux audio connecté.');
    } catch (err) { logToTerminal(`❌ Erreur audio: ${err.message}`); }
}
