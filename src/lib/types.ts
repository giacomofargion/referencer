/** Band edges in Hz: sub, bass, low-mid, mid, high-mid, presence, air */
export const FREQUENCY_BANDS = [
  { name: "sub", low: 20, high: 60 },
  { name: "bass", low: 60, high: 250 },
  { name: "low-mid", low: 250, high: 500 },
  { name: "mid", low: 500, high: 2000 },
  { name: "high-mid", low: 2000, high: 4000 },
  { name: "presence", low: 4000, high: 8000 },
  { name: "air", low: 8000, high: 20000 },
] as const;

export type FrequencyBandName = (typeof FREQUENCY_BANDS)[number]["name"];

export const MFCC_COEFFS = 13;
export const HPCP_BINS = 12;
export const SPECTRAL_CONTRAST_BANDS = 6;
export const BEAT_HIST_PEAKS = 2;
export const DISCOGS_EMBEDDING_DIM = 512;

/**
 * Sonic fingerprint shared by client uploads and reference tracks.
 * frequencyBandEnergies holds relative energy per band (sums to 1), in FREQUENCY_BANDS order.
 * Newer optional fields are filled by v2 analysis; older rows omit them.
 */
export interface FeatureVector {
  integratedLoudnessLufs: number;
  loudnessRangeDb: number;
  frequencyBandEnergies: number[];
  tempoBpm: number;
  /** 0 = mono, 1 = fully wide (side energy / mid+side energy) */
  stereoWidth: number;
  /**
   * Peak-to-loudness ratio in dB (sample peak dBFS − integrated LUFS).
   * The key mastering dynamics number: low = dense/limited, high = punchy.
   */
  plrDb?: number;
  /** Onset events per second — rhythmic density. */
  onsetRate?: number;

  /** MFCC mean (13 coeffs). */
  mfccMean?: number[];
  /** MFCC std (13 coeffs). */
  mfccStd?: number[];
  /** Spectral centroid mean (Hz). */
  spectralCentroid?: number;
  /** Spectral rolloff mean (Hz). */
  spectralRolloff?: number;
  /** Mean frame-to-frame spectral flux. */
  spectralFlux?: number;
  /** Mean spectral flatness (0–1-ish). */
  spectralFlatness?: number;
  /** Mean spectral contrast coefficients. */
  spectralContrast?: number[];
  /** Mean zero-crossing rate. */
  zeroCrossingRate?: number;
  /** Mean HPCP / chroma (12 bins). */
  hpcp?: number[];
  /** Top beat-histogram peak BPMs. */
  beatHistBpms?: number[];
  /** Top beat-histogram peak weights. */
  beatHistWeights?: number[];
  /** Frame RMS mean. */
  rmsMean?: number;
  /** Frame RMS std. */
  rmsStd?: number;
  /** Mean spectral crest factor. */
  crestFactor?: number;
  /** Envelope fluctuation (RMS coeff of variation) — dynamic complexity. */
  dynamicComplexity?: number;
}

/**
 * Versioned fingerprint envelope. v1 rows in jsonb are bare FeatureVector objects;
 * v2 wraps multi-window analysis (+ optional Discogs embedding).
 */
export interface FeatureFingerprint {
  version: 2;
  /** Mean across windows — primary vector for UI / legacy callers. */
  aggregate: FeatureVector;
  /** Equal-duration sections (1–5). */
  windows: FeatureVector[];
  /** L2-normalized Discogs penultimate embedding (browser only today). */
  embedding?: number[];
}

export type StoredFingerprint = FeatureVector | FeatureFingerprint;
