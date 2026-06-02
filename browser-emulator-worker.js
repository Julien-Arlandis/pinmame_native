// browser-emulator-worker.js
// Worker wrapper that delegates emulator logic to emulator-core.js.

self.window = self;
importScripts('emulator-core.js');

const emulator = createEmulator();

self.onmessage = function(event) {
    const { type, payload } = event.data;
    emulator.sendMessage(type, payload);
};
