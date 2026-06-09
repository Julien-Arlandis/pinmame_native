// audio.js — Pipeline audio JS : mélange DAC, pushWasmAudio, pacing wall-clock

function createAudioProcessor({ pinmameInstance, sendAudio, generation, getEmulatorGeneration }) {
    const lastFrameDacOut = [0.0, 0.0];
    let samplesProduced = 0;
    let firstAudioTime  = null;
    let _pacingInterval = null;

    function pushWasmAudio(ptr, count, callerGen) {
        if (callerGen !== generation) return;
        if (!pinmameInstance) return;
        if (firstAudioTime === null) firstAudioTime = Date.now();

        const ptr16  = ptr >> 1;
        const frames = count / 2;
        const left   = new Float32Array(frames);
        const right  = new Float32Array(frames);

        for (let i = 0, idx = 0; i < count; i += 2, idx++) {
            left[idx]  = pinmameInstance.HEAP16[ptr16 + i]     / 32768.0;
            right[idx] = pinmameInstance.HEAP16[ptr16 + i + 1] / 32768.0;
        }

        // Mixer la contribution DAC (jeux sans YM2151 : Robowars, B2…)
        for (let chip = 0; chip < 2; chip++) {
            const n = pinmameInstance._api_get_dac_count(chip);
            if (n === 0) continue;

            const dacPtr32 = pinmameInstance._api_get_dac_buffer(chip) >>> 2;
            // Valeurs déjà traitées par l'intégrateur DC-offset dans audio.cpp.
            const processed = new Float32Array(n);
            for (let i = 0; i < n; i++) {
                processed[i] = pinmameInstance.HEAP32[dacPtr32 + i] / 32768.0;
            }

            // Redistribuer n samples DAC sur `frames` sorties par interpolation linéaire.
            // Le dernier sample de la frame précédente sert de point de départ →
            // continuité inter-frames sans discontinuité visible.
            const prevVal = lastFrameDacOut[chip];
            const scale   = n / (frames - 1);
            for (let s = 0; s < frames; s++) {
                const pos  = s * scale;
                const i0   = pos | 0;
                const i1   = i0 + 1 <= n ? i0 + 1 : i0;
                const frac = pos - i0;
                const v0   = i0 === 0 ? prevVal : processed[i0 - 1];
                const v1   = i1 === 0 ? prevVal : processed[i1 - 1];
                const dac  = v0 * (1 - frac) + v1 * frac;
                left[s]  = Math.max(-1, Math.min(1, left[s]  + dac));
                right[s] = Math.max(-1, Math.min(1, right[s] + dac));
            }
            lastFrameDacOut[chip] = processed[n - 1];

            pinmameInstance._api_reset_dac_buffer(chip);
        }

        sendAudio(left, right);
        samplesProduced += frames;
    }

    function installGlobals() {
        globalThis.pushWasmAudio = pushWasmAudio;
    }

    // Démarre le pacing wall-clock (intervalle 32 ms).
    // Calcule la distance entre samples produits et temps réel écoulé,
    // puis envoie @audio:distance=N au WASM pour réguler la vitesse d'émulation.
    function startPacing(handleLine) {
        samplesProduced = 0;
        firstAudioTime  = null;
        _pacingInterval = setInterval(() => {
            if (generation !== getEmulatorGeneration()) {
                clearInterval(_pacingInterval);
                return;
            }
            const dist = firstAudioTime !== null
                ? Math.max(0, samplesProduced - Math.floor((Date.now() - firstAudioTime) / 1000 * 44100))
                : 0;
            handleLine(`@audio:distance=${dist}`);
        }, 32);
    }

    return { installGlobals, startPacing };
}

// Rend createAudioProcessor disponible globalement pour importScripts et require
globalThis.createAudioProcessor = createAudioProcessor;
if (typeof module !== 'undefined') module.exports = { createAudioProcessor };
