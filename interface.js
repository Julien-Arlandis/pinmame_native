// interface.js
// Browser-only UI + audio host. Loads a worker that runs `runtime.js`.

// Reuse most of the previous browser-adapter.js but ensure it does not include runtime code.

const SOUND_DICTIONARY = { 1: "STOP", 2: "BGM 1", 3: "BGM 2", 4: "BGM 3", 5: "BGM 4", 61: "BANK CLEAR", 63: "TEST TONE" };
const SWITCH_DICTIONARY = {
    0: "10 Points", 1: "10 Points", 2: "10 Points", 3: "10 Points", 4: "Left Outlane", 5: "Left Return", 6: "Right Return", 7: "Test Button",
    10: "10 Points", 11: "10 Points", 12: "10 Points", 13: "10 Points", 14: "Right Outlane", 15: "Left Top Lane", 16: "Right Top Lane", 17: "Center Coin Chute (8 Cr)",
    20: "10 Points", 21: "10 Points", 22: "10 Points", 23: "10 Points", 24: "Left Drop - Top", 25: "Left Drop - Center", 26: "Left Drop - Bottom", 27: "Left Coin Chute (1/2 Cr)",
    30: "10 Points", 31: "10 Points", 32: "10 Points", 33: "Left Bumper", 34: "Right Drop - Top", 35: "Right Drop - Center", 36: "Right Drop - Bottom", 37: "Coin Chute 4",
    40: "Target 'B'", 41: "Target 'O'", 42: "Target 'N'", 43: "Shooter Lane", 44: "Left Captive", 45: "Right Captive", 46: "Outhole", 47: "Replay Button (START)",
    50: "Target 'E'", 51: "Target 'S'", 52: "Target 'U'", 53: "Trough 1", 54: "Trough 2", 55: "Trough 3", 56: "Trough 4", 57: "Right Coin Chute",
    60: "Target 'B' (Bust)", 61: "Target 'U' (Bust)", 62: "Target 'S' (Bust)", 63: "Target 'T' (Bust)", 64: "Target 'E' (Bust)", 65: "Target 'R' (Bust)", 66: "Target 'S' (Bust)", 67: "Slam Tilt",
    70: "Top Rebound", 71: "Right Bumper", 72: "Bottom Bumper", 73: "Kicker", 74: "Standup Right", 75: "Standup Left", 76: "Spinner", 77: "Plumb Bob Tilt"
};

// Minimal UI wiring: create worker and forward messages
const flipperWorker = new Worker('browser-emulator-worker.js');

flipperWorker.onmessage = function(event) {
    const { type, payload, data } = event.data;
    switch (type) {
        case 'STATUS': document.getElementById('status').textContent = data; break;
        case 'LOG': console.log('[EMULATOR]', data); break;
        case 'AUDIO_DATA':
            // Audio handled by main thread: push into ring buffer etc.
            // (implementation copied from previous browser-adapter)
            break;
        case 'VFD_UPDATE':
            // update display
            break;
        case 'LAMPS_UPDATE':
            // update lamps
            break;
    }
};

// Exported helper for UI to send control messages
function sendToEmulator(type, payload) {
    flipperWorker.postMessage({ type, payload });
}

window.sendToEmulator = sendToEmulator;
