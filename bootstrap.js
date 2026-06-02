// bootstrap.js
// Unified runtime launcher: loads browser or Node adapter without sharing browser-specific logic into Node.

const isNode = typeof process !== 'undefined' && process.versions?.node;
const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';

if (isNode) {
    require('./node-adapter.js');
} else if (isBrowser) {
    import('./browser-adapter.js').catch(err => { console.error(err); throw err; });
} else {
    throw new Error('Unsupported runtime environment for bootstrap.js');
}
