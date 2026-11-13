// Shared fingerprinting engine: plain TypeScript, no Node or DOM APIs,
// so the backend (indexing) and the browser (live listening) run identical code.
export { engineConfig } from './config.js';
export { FFT } from './fft.js';
export { SpectrumAnalyzer } from './spectrum-analyzer.js';
export { Fingerprinter } from './fingerprinter.js';
export type { Peak, Fingerprint, Match } from './types.js';
