function createAudioProcessor({ pinmameInstance: P, sendAudio, generation: G, getEmulatorGeneration: GEG }) {
    let prod = 0, t0 = null, iv = null;

    function pushWasmAudio(ptr, count, gen) {
        if (gen !== G || !P) return;
        if (!t0) t0 = Date.now();
        const n = count >> 1, h = ptr >> 1;
        const L = new Float32Array(n), R = new Float32Array(n);
        for (let i = 0, j = 0; i < count; i += 2, j++) {
            L[j] = P.HEAP16[h + i]     / 32768;
            R[j] = P.HEAP16[h + i + 1] / 32768;
        }
        for (let c = 0; c < 2; c++) {
            const nd = P._api_get_dac_count(c);
            if (!nd) continue;
            const b = P._api_get_dac_buffer(c) >>> 2, sc = nd / n;
            for (let s = 0; s < n; s++) {
                const d = P.HEAP32[b + Math.min(0 | s * sc, nd - 1)] / 32768;
                L[s] += d;
                R[s] += d;
            }
            P._api_reset_dac_buffer(c);
        }
        sendAudio(L, R);
        prod += n;
    }

    function startPacing(h) {
        prod = 0; t0 = null;
        iv = setInterval(() => {
            if (G !== GEG()) { clearInterval(iv); return; }
            const dist = t0 ? Math.max(0, prod - (0 | (Date.now() - t0) / 1000 * 44100)) : 0;
            h(`@audio:distance=${dist}`);
        }, 32);
    }

    return {
        installGlobals() { globalThis.pushWasmAudio = pushWasmAudio; },
        startPacing
    };
}

globalThis.createAudioProcessor = createAudioProcessor;
if (typeof module !== 'undefined') module.exports = { createAudioProcessor };
