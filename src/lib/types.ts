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

/**
 * Sonic fingerprint shared by client uploads and reference tracks.
 * frequencyBandEnergies holds relative energy per band (sums to 1), in FREQUENCY_BANDS order.
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
   * Optional: vectors analyzed before this field existed don't have it.
   */
  plrDb?: number;
  /**
   * Onset events per second — rhythmic density. Separates a busy DnB drop
   * from an ambient piece at the same BPM. Optional, same reason as plrDb.
   */
  onsetRate?: number;
}

