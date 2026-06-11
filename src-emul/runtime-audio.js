function createAudioProcessor({ pinmameInstance: P, sendAudio, sendCapture, sendScope, generation: G, getEmulatorGeneration: GEG }) {

    let coeff_CHIP = 1.0;
    let coeff_DAC  = 1.0;
    let sep_mode   = false;
    let K1 = 3/6; let K2 = 2/6; let K3 = 1/6; // 3-point moving average coefficients
    let scopeThrottle = 0;

    globalThis.setAudioMix = (chip, dac) => { coeff_CHIP = chip; coeff_DAC = dac; };
    globalThis.setAudioSep = (s)         => { sep_mode = s; };

    let prod = 0, t0 = null;
    let dacPrev1 = 0, dacPrev2 = 0;

    let capBuf = null;
    globalThis.startCapture = () => { capBuf = { ym_L: [], ym_R: [], dac: [] }; };
    globalThis.stopCapture  = () => {
        if (!capBuf) return;
        const result = { ym_L: new Float32Array(capBuf.ym_L), ym_R: new Float32Array(capBuf.ym_R), dac: new Float32Array(capBuf.dac) };
        capBuf = null;
        sendCapture?.(result);
    };

    function pushWasmAudio(ptr, count, gen) {
        if (gen !== G || !P) return;
        if (!t0) t0 = Date.now();
        const n = count >> 1, h = ptr >> 1;

        const ym_L = new Float32Array(n), ym_R = new Float32Array(n);
        for (let j = 0; j < n; j++) {
            ym_L[j] = P.HEAP16[h + j * 2]     / 32768;
            ym_R[j] = P.HEAP16[h + j * 2 + 1] / 32768;
        }

        const dac = new Float32Array(n);
        for (let c = 0; c < 2; c++) {
            const nd = P._api_get_dac_count(c);
            if (!nd) continue;
            const b = P._api_get_dac_buffer(c) >>> 2, sc = nd / n;
            for (let i = 0; i < n; i++) {
                const idx = i * sc, i0 = 0 | idx, i1 = Math.min(i0 + 1, nd - 1), frac = idx - i0;
                const raw = (P.HEAP32[b + i0] * (1 - frac) + P.HEAP32[b + i1] * frac) / 65536;
                dac[i] = (raw * K1 + dacPrev1 * K2 + dacPrev2 * K3);
                dacPrev2 = dacPrev1; dacPrev1 = raw;
            }
            P._api_reset_dac_buffer(c);
        }

        const L = new Float32Array(n), R = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            if (sep_mode) {
                L[i] = coeff_CHIP * (ym_L[i] + ym_R[i]) / 2;
                R[i] = coeff_DAC  * dac[i];
            } else {
                L[i] = (coeff_CHIP * (ym_L[i] + ym_R[i]) / 2 + coeff_DAC * dac[i]) / 2;
                R[i] = L[i];
            }
        }

        sendAudio(L, R);
        prod += n;

        if (sendScope && globalThis._scopeActive && ++scopeThrottle >= 4) {
            scopeThrottle = 0;
            sendScope({ ym_L: ym_L.slice(), ym_R: ym_R.slice(), dac: dac.slice(), spk_L: L.slice(), spk_R: R.slice() });
        }

        if (capBuf) {
            for (let i = 0; i < n; i++) {
                capBuf.ym_L.push(ym_L[i]);
                capBuf.ym_R.push(ym_R[i]);
                capBuf.dac.push(dac[i]);
            }
        }
    }

    function startPacing(h) {
        prod = 0; t0 = null;
        let iv = setInterval(() => {
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
