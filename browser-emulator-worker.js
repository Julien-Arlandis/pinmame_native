// browser-emulator-worker.js
// Charge runtime.js qui gère lui-même l'initialisation du worker et le handler onmessage.

self.window = self;
importScripts('runtime.js');
