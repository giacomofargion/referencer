declare module "essentia.js" {
  // essentia.js ships JS + a core_api.d.ts that isn't wired to the package entry.
  // Minimal typings for the algorithms we use server-side.
  export class Essentia {
    constructor(wasmModule: unknown, isDebug?: boolean);
    arrayToVector(input: Float32Array | number[]): { delete: () => void };
    vectorToArray(input: unknown): Float32Array;
    FrameGenerator(
      input: Float32Array,
      frameSize?: number,
      hopSize?: number,
    ): { size: () => number; get: (i: number) => unknown; delete: () => void };
    Windowing(
      frame: unknown,
      normalized?: boolean,
      size?: number,
      type?: string,
    ): { frame: { delete: () => void } };
    Spectrum(
      frame: unknown,
      size?: number,
    ): { spectrum: { delete: () => void } };
    EnergyBand(
      spectrum: unknown,
      sampleRate?: number,
      startCutoffFrequency?: number,
      stopCutoffFrequency?: number,
    ): { energyBand: number };
    LoudnessEBUR128(
      left: unknown,
      right: unknown,
      hopSize?: number,
      sampleRate?: number,
      startAtZero?: boolean,
    ): { integratedLoudness: number; loudnessRange: number };
    MonoMixer(
      left: unknown,
      right: unknown,
    ): { audio: { delete: () => void } };
    PercivalBpmEstimator(
      signal: unknown,
      frameSize?: number,
      frameSizeOSS?: number,
      hopSize?: number,
      hopSizeOSS?: number,
      maxBPM?: number,
      minBPM?: number,
      sampleRate?: number,
    ): { bpm: number };
    OnsetRate(signal: unknown): {
      onsetRate: number;
      onsets: { delete: () => void };
    };
  }

  export const EssentiaWASM: unknown;
}
