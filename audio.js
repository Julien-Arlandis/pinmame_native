function feedAudioRingBuffer() {}

function unlockAudio() {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctx.resume();
    let t = 0;
    feedAudioRingBuffer = (left, right) => {
        const s = ctx.createBufferSource();
        s.buffer = ctx.createBuffer(2, left.length, 44100);
        s.buffer.getChannelData(0).set(left);
        s.buffer.getChannelData(1).set(right);
        s.connect(ctx.destination);
        s.start(t = Math.max(t, ctx.currentTime + left.length / 44100));
        t += left.length / 44100;
    };
    unlockAudio = () => ctx.resume();
}
