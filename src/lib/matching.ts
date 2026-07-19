import { FREQUENCY_BANDS, type FeatureVector } from "@/lib/types";

export interface RankedMatch<T> {
  item: T;
  distance: number;
  features: FeatureVector;
}

interface Weights {
  loudness: number;
  dynamicRange: number;
  /** Peak-to-loudness ratio — density/punch of the master. */
  plr: number;
  tempo: number;
  /** Onset rate — rhythmic density. */
  onsets: number;
  stereoWidth: number;
  /** Per-band weight — frequency balance is the main mastering signal. */
  band: number;
}

/**
 * Extra multipliers for specific bands on top of `weights.band`.
 * Sub and bass are highly genre-diagnostic for electronic/bass music,
 * so they pull ranking harder than presence/air.
 */
const BAND_EMPHASIS: number[] = [
  1.6, // sub
  1.4, // bass
  1.0, // low-mid
  1.0, // mid
  1.0, // high-mid
  0.9, // presence
  0.8, // air
];

export type WeightPreset = "balanced" | "tone" | "loudness";

export const WEIGHT_PRESETS: Record<WeightPreset, Weights> = {
  balanced: {
    loudness: 1.2,
    dynamicRange: 1.0,
    plr: 1.0,
    tempo: 1.0,
    onsets: 0.8,
    stereoWidth: 0.8,
    band: 1.4,
  },
  // Frequency balance first — for tonal/EQ referencing.
  tone: {
    loudness: 0.5,
    dynamicRange: 0.6,
    plr: 0.5,
    tempo: 0.8,
    onsets: 0.6,
    stereoWidth: 0.8,
    band: 2.6,
  },
  // Level and dynamics first — for limiting/loudness-target referencing.
  loudness: {
    loudness: 2.4,
    dynamicRange: 1.8,
    plr: 1.8,
    tempo: 0.6,
    onsets: 0.5,
    stereoWidth: 0.5,
    band: 0.8,
  },
};

export const WEIGHT_PRESET_LABELS: Record<WeightPreset, string> = {
  balanced: "Balanced",
  tone: "Match tone",
  loudness: "Match loudness",
};

function tempoDistance(a: number, b: number): number {
  // Beat trackers often report half/double tempo — take the closest octave.
  const direct = Math.abs(a - b);
  const half = Math.abs(a - b / 2);
  const double = Math.abs(a - b * 2);
  return Math.min(direct, half, double);
}

/**
 * Weighted Euclidean distance after per-feature min-max normalization
 * across the candidate pool (genre-filtered).
 */
export function rankBySonicSimilarity<T>(
  query: FeatureVector,
  candidates: Array<{ item: T; features: FeatureVector }>,
  preset: WeightPreset = "balanced",
): RankedMatch<T>[] {
  if (candidates.length === 0) return [];

  const weights = WEIGHT_PRESETS[preset];
  const all = [query, ...candidates.map((c) => c.features)];

  const loudRange = extent(all.map((f) => f.integratedLoudnessLufs));
  const dynRange = extent(all.map((f) => f.loudnessRangeDb));
  const tempoRange = extent(all.map((f) => f.tempoBpm));
  // Tempo distances use absolute BPM before normalize; scale by pool span.
  const tempoSpan = Math.max(tempoRange.max - tempoRange.min, 1);
  const widthRange = extent(all.map((f) => f.stereoWidth));

  // Optional dims (plr, onsets) may be missing on vectors analyzed before
  // they existed. Extents come from present values only; missing values
  // substitute the pool midpoint so old references get a neutral penalty
  // rather than a free pass.
  const plrRange = extent(all.map((f) => f.plrDb).filter(isNumber));
  const onsetRange = extent(all.map((f) => f.onsetRate).filter(isNumber));

  const bandExtents = FREQUENCY_BANDS.map((_, i) =>
    extent(all.map((f) => f.frequencyBandEnergies[i] ?? 0)),
  );

  return candidates
    .map(({ item, features }) => {
      const loud =
        normalize(query.integratedLoudnessLufs, loudRange) -
        normalize(features.integratedLoudnessLufs, loudRange);
      const dyn =
        normalize(query.loudnessRangeDb, dynRange) -
        normalize(features.loudnessRangeDb, dynRange);
      const plr =
        normalizeOptional(query.plrDb, plrRange) -
        normalizeOptional(features.plrDb, plrRange);
      const tempo =
        tempoDistance(query.tempoBpm, features.tempoBpm) / tempoSpan;
      const onsets =
        normalizeOptional(query.onsetRate, onsetRange) -
        normalizeOptional(features.onsetRate, onsetRange);
      const width =
        normalize(query.stereoWidth, widthRange) -
        normalize(features.stereoWidth, widthRange);

      let bandSq = 0;
      for (let i = 0; i < FREQUENCY_BANDS.length; i++) {
        const d =
          normalize(query.frequencyBandEnergies[i] ?? 0, bandExtents[i]) -
          normalize(features.frequencyBandEnergies[i] ?? 0, bandExtents[i]);
        const emphasis = BAND_EMPHASIS[i] ?? 1;
        bandSq += emphasis * d * d;
      }

      const distance = Math.sqrt(
        weights.loudness * loud * loud +
          weights.dynamicRange * dyn * dyn +
          weights.plr * plr * plr +
          weights.tempo * tempo * tempo +
          weights.onsets * onsets * onsets +
          weights.stereoWidth * width * width +
          weights.band * bandSq,
      );

      return { item, features, distance };
    })
    .sort((a, b) => a.distance - b.distance);
}

function isNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeOptional(
  value: number | undefined,
  range: { min: number; max: number },
): number {
  return isNumber(value) ? normalize(value, range) : 0.5;
}

function extent(values: number[]): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    return { min: 0, max: 1 };
  }
  return { min, max };
}

function normalize(value: number, range: { min: number; max: number }): number {
  return (value - range.min) / (range.max - range.min);
}

/** Per-dimension deltas for the match card readout (reference − client). */
export interface FeatureDeltas {
  loudnessLu: number;
  dynamicRangeDb: number;
  plrDb: number | null;
  tempoBpm: number;
  stereoWidth: number;
  onsetRate: number | null;
}

export function computeFeatureDeltas(
  client: FeatureVector,
  reference: FeatureVector,
): FeatureDeltas {
  return {
    loudnessLu:
      reference.integratedLoudnessLufs - client.integratedLoudnessLufs,
    dynamicRangeDb: reference.loudnessRangeDb - client.loudnessRangeDb,
    plrDb:
      isNumber(client.plrDb) && isNumber(reference.plrDb)
        ? reference.plrDb - client.plrDb
        : null,
    tempoBpm: reference.tempoBpm - client.tempoBpm,
    stereoWidth: reference.stereoWidth - client.stereoWidth,
    onsetRate:
      isNumber(client.onsetRate) && isNumber(reference.onsetRate)
        ? reference.onsetRate - client.onsetRate
        : null,
  };
}
