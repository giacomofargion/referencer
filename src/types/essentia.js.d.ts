declare module "essentia.js" {
  // essentia.js ships JS + a core_api.d.ts that isn't wired to the package entry.
  // Minimal typings for the algorithms we use server-side.
  type Vec = { delete: () => void };

  export class Essentia {
    constructor(wasmModule: unknown, isDebug?: boolean);
    arrayToVector(input: Float32Array | number[]): Vec;
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
    ): { frame: Vec };
    Spectrum(
      frame: unknown,
      size?: number,
    ): { spectrum: Vec };
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
    ): { audio: Vec };
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
      onsets: Vec;
    };
    RMS(array: unknown): { rms: number };
    ZeroCrossingRate(
      signal: unknown,
      threshold?: number,
    ): { zeroCrossingRate: number };
    Centroid(array: unknown, range?: number): { centroid: number };
    RollOff(
      spectrum: unknown,
      cutoff?: number,
      sampleRate?: number,
    ): { rollOff: number };
    Flatness(array: unknown): { flatness: number };
    Crest(array: unknown): { crest: number };
    MFCC(
      spectrum: unknown,
      dctType?: number,
      highFrequencyBound?: number,
      inputSize?: number,
      liftering?: number,
      logType?: string,
      lowFrequencyBound?: number,
      normalize?: string,
      numberBands?: number,
      numberCoefficients?: number,
      sampleRate?: number,
      silenceThreshold?: number,
      type?: string,
      warpingFormula?: string,
      weighting?: string,
    ): { mfcc: Vec; bands: Vec };
    SpectralContrast(
      spectrum: unknown,
      frameSize?: number,
      highFrequencyBound?: number,
      lowFrequencyBound?: number,
      neighbourRatio?: number,
      numberBands?: number,
      sampleRate?: number,
      staticDistribution?: number,
    ): { spectralContrast: Vec; spectralValley: Vec };
    SpectralPeaks(
      spectrum: unknown,
      magnitudeThreshold?: number,
      maxFrequency?: number,
      maxPeaks?: number,
      minFrequency?: number,
      orderBy?: string,
      sampleRate?: number,
    ): { frequencies: Vec; magnitudes: Vec };
    HPCP(
      frequencies: unknown,
      magnitudes: unknown,
      bandPreset?: boolean,
      bandSplitFrequency?: number,
      harmonics?: number,
      maxFrequency?: number,
      maxShifted?: boolean,
      minFrequency?: number,
      nonLinear?: boolean,
      normalized?: string,
      referenceFrequency?: number,
      sampleRate?: number,
      size?: number,
      weightType?: string,
      windowSize?: number,
    ): { hpcp: Vec };
    RhythmDescriptors(signal: unknown): {
      first_peak_bpm: number;
      first_peak_weight: number;
      second_peak_bpm: number;
      second_peak_weight: number;
      beats_position?: Vec;
      bpm_estimates?: Vec;
      bpm_intervals?: Vec;
      histogram?: Vec;
    };
  }

  export const EssentiaWASM: unknown;
}
