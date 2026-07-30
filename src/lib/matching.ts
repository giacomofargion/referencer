import { FREQUENCY_BANDS, type FeatureVector, type StoredFingerprint } from "@/lib/types";
import {
  getAggregateFeatures,
  getEmbedding,
  getFeatureWindows,
} from "@/lib/feature-vector";

export interface RankedMatch<T> {
  item: T;
  distance: number;
  features: FeatureVector;
  fingerprint: StoredFingerprint;
}

interface Weights {
  loudness: number;
  dynamicRange: number;
  plr: number;
  tempo: number;
  onsets: number;
  stereoWidth: number;
  band: number;
  /** Timbre (MFCC + spectral shape). */
  timbre: number;
  /** Harmonic / chroma. */
  chroma: number;
  /** Rhythm histogram + flux/zcr. */
  rhythm: number;
  /** Crest / dynamic complexity / RMS. */
  dynamicsExt: number;
}

/**
 * Extra multipliers for specific bands on top of `weights.band`.
 * Sub and bass are highly genre-diagnostic for electronic/bass music.
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
    timbre: 1.2,
    chroma: 0.9,
    rhythm: 0.8,
    dynamicsExt: 0.7,
  },
  tone: {
    loudness: 0.5,
    dynamicRange: 0.6,
    plr: 0.5,
    tempo: 0.8,
    onsets: 0.6,
    stereoWidth: 0.8,
    band: 2.6,
    timbre: 2.0,
    chroma: 1.4,
    rhythm: 0.5,
    dynamicsExt: 0.4,
  },
  loudness: {
    loudness: 2.4,
    dynamicRange: 1.8,
    plr: 1.8,
    tempo: 0.6,
    onsets: 0.5,
    stereoWidth: 0.5,
    band: 0.8,
    timbre: 0.5,
    chroma: 0.3,
    rhythm: 0.4,
    dynamicsExt: 1.6,
  },
};

export const WEIGHT_PRESET_LABELS: Record<WeightPreset, string> = {
  balanced: "Balanced",
  tone: "Match tone",
  loudness: "Match loudness",
};

/** Fusion weights when both sides have a Discogs embedding. */
const SONIC_ALPHA = 0.7;
const EMBED_BETA = 0.3;

export type WeightMultipliers = Partial<Record<keyof Weights, number>>;

function tempoDistance(a: number, b: number): number {
  const direct = Math.abs(a - b);
  const half = Math.abs(a - b / 2);
  const double = Math.abs(a - b * 2);
  return Math.min(direct, half, double);
}

function isNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clampMultiplier(value: number): number {
  return Math.min(1.3, Math.max(0.7, value));
}

function applyMultipliers(
  base: Weights,
  multipliers?: WeightMultipliers,
): Weights {
  if (!multipliers) return base;
  const out = { ...base };
  (Object.keys(base) as Array<keyof Weights>).forEach((key) => {
    const m = multipliers[key];
    if (typeof m === "number" && Number.isFinite(m)) {
      out[key] = base[key] * clampMultiplier(m);
    }
  });
  return out;
}

/** Flatten a FeatureVector into weighted scalar dims for distance math. */
function flattenFeatures(
  f: FeatureVector,
  weights: Weights,
): { values: number[]; weights: number[] } {
  const values: number[] = [];
  const wts: number[] = [];

  const push = (value: number | undefined, weight: number) => {
    if (!isNumber(value)) {
      values.push(Number.NaN); // marked missing — filled after pool stats
      wts.push(weight);
      return;
    }
    values.push(value);
    wts.push(weight);
  };

  push(f.integratedLoudnessLufs, weights.loudness);
  push(f.loudnessRangeDb, weights.dynamicRange);
  push(f.plrDb, weights.plr);
  push(f.tempoBpm, weights.tempo);
  push(f.onsetRate, weights.onsets);
  push(f.stereoWidth, weights.stereoWidth);

  for (let i = 0; i < FREQUENCY_BANDS.length; i++) {
    push(
      f.frequencyBandEnergies[i] ?? 0,
      weights.band * (BAND_EMPHASIS[i] ?? 1),
    );
  }

  const mfccMean = f.mfccMean;
  if (mfccMean) {
    for (const c of mfccMean) push(c, weights.timbre / 13);
  } else {
    for (let i = 0; i < 13; i++) push(undefined, weights.timbre / 13);
  }
  const mfccStd = f.mfccStd;
  if (mfccStd) {
    for (const c of mfccStd) push(c, (weights.timbre * 0.5) / 13);
  } else {
    for (let i = 0; i < 13; i++) push(undefined, (weights.timbre * 0.5) / 13);
  }

  push(f.spectralCentroid, weights.timbre);
  push(f.spectralRolloff, weights.timbre);
  push(f.spectralFlux, weights.rhythm);
  push(f.spectralFlatness, weights.timbre);
  const contrast = f.spectralContrast;
  if (contrast) {
    for (const c of contrast) push(c, weights.timbre / contrast.length);
  } else {
    for (let i = 0; i < 6; i++) push(undefined, weights.timbre / 6);
  }
  push(f.zeroCrossingRate, weights.rhythm);

  const hpcp = f.hpcp;
  if (hpcp) {
    for (const c of hpcp) push(c, weights.chroma / hpcp.length);
  } else {
    for (let i = 0; i < 12; i++) push(undefined, weights.chroma / 12);
  }

  const beatBpms = f.beatHistBpms;
  const beatWts = f.beatHistWeights;
  if (beatBpms && beatWts) {
    for (let i = 0; i < 2; i++) {
      push(beatBpms[i], weights.rhythm * 0.5);
      push(beatWts[i], weights.rhythm * 0.5);
    }
  } else {
    for (let i = 0; i < 4; i++) push(undefined, weights.rhythm * 0.5);
  }

  push(f.rmsMean, weights.dynamicsExt);
  push(f.rmsStd, weights.dynamicsExt);
  push(f.crestFactor, weights.dynamicsExt);
  push(f.dynamicComplexity, weights.dynamicsExt);

  return { values, weights: wts };
}

function poolMeanStd(column: number[]): { mean: number; std: number } {
  const present = column.filter((v) => Number.isFinite(v));
  if (present.length === 0) return { mean: 0, std: 1 };
  let sum = 0;
  for (const v of present) sum += v;
  const mean = sum / present.length;
  let varSum = 0;
  for (const v of present) {
    const d = v - mean;
    varSum += d * d;
  }
  const std = Math.sqrt(varSum / present.length);
  return { mean, std: std > 1e-9 ? std : 1 };
}

function zscoreRow(
  values: number[],
  stats: Array<{ mean: number; std: number }>,
): number[] {
  return values.map((v, i) => {
    const { mean, std } = stats[i];
    if (!Number.isFinite(v)) return 0; // missing → pool center
    return (v - mean) / std;
  });
}

function weightedCosineDistance(
  a: number[],
  b: number[],
  weights: number[],
): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const w = Math.sqrt(Math.max(weights[i], 0));
    const av = a[i] * w;
    const bv = b[i] * w;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na < 1e-12 || nb < 1e-12) return 1;
  const cos = dot / (Math.sqrt(na) * Math.sqrt(nb));
  return 1 - Math.max(-1, Math.min(1, cos));
}

function weightedEuclideanDistance(
  a: number[],
  b: number[],
  weights: number[],
): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += weights[i] * d * d;
  }
  return Math.sqrt(sum);
}

function embeddingCosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na < 1e-12 || nb < 1e-12) return 1;
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Distance between two fingerprints: average aligned window distance,
 * falling back to aggregate when window counts differ wildly.
 */
function fingerprintDistance(
  query: StoredFingerprint,
  candidate: StoredFingerprint,
  weights: Weights,
  metric: "cosine" | "euclidean",
  poolStats: Array<{ mean: number; std: number }>,
  dimWeights: number[],
): number {
  const qWindows = getFeatureWindows(query);
  const cWindows = getFeatureWindows(candidate);
  const n = Math.min(qWindows.length, cWindows.length);

  const pairDistance = (qf: FeatureVector, cf: FeatureVector) => {
    const qFlat = flattenFeatures(qf, weights);
    const cFlat = flattenFeatures(cf, weights);
    const qz = zscoreRow(qFlat.values, poolStats);
    const cz = zscoreRow(cFlat.values, poolStats);
    // Tempo uses octave-aware distance injected into the tempo slot (index 3).
    const tempoIdx = 3;
    const tDist =
      tempoDistance(qf.tempoBpm, cf.tempoBpm) /
      Math.max(poolStats[tempoIdx]?.std ?? 1, 1);
    qz[tempoIdx] = 0;
    cz[tempoIdx] = tDist;

    return metric === "cosine"
      ? weightedCosineDistance(qz, cz, dimWeights)
      : weightedEuclideanDistance(qz, cz, dimWeights);
  };

  if (n <= 0) {
    return pairDistance(
      getAggregateFeatures(query),
      getAggregateFeatures(candidate),
    );
  }

  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += pairDistance(qWindows[i], cWindows[i]);
  }
  return sum / n;
}

/**
 * Rank candidates by sonic similarity.
 * - `balanced` (default): pool z-score + weighted cosine
 * - `tone` / `loudness`: weighted Euclidean on the same scaled dims (A/B presets)
 */
export function rankBySonicSimilarity<T>(
  query: StoredFingerprint,
  candidates: Array<{ item: T; features: StoredFingerprint }>,
  preset: WeightPreset = "balanced",
  multipliers?: WeightMultipliers,
): RankedMatch<T>[] {
  if (candidates.length === 0) return [];

  const weights = applyMultipliers(WEIGHT_PRESETS[preset], multipliers);
  const metric: "cosine" | "euclidean" =
    preset === "balanced" ? "cosine" : "euclidean";

  // Build pool stats from aggregates (stable across window counts).
  const allAggregates = [
    getAggregateFeatures(query),
    ...candidates.map((c) => getAggregateFeatures(c.features)),
  ];
  const flatAll = allAggregates.map((f) => flattenFeatures(f, weights));
  const dim = flatAll[0].values.length;
  const dimWeights = flatAll[0].weights;
  const poolStats: Array<{ mean: number; std: number }> = [];
  for (let i = 0; i < dim; i++) {
    poolStats.push(poolMeanStd(flatAll.map((row) => row.values[i])));
  }

  const queryEmbed = getEmbedding(query);

  return candidates
    .map(({ item, features }) => {
      let distance = fingerprintDistance(
        query,
        features,
        weights,
        metric,
        poolStats,
        dimWeights,
      );

      const candEmbed = getEmbedding(features);
      if (queryEmbed && candEmbed) {
        const embedDist = embeddingCosineDistance(queryEmbed, candEmbed);
        distance = SONIC_ALPHA * distance + EMBED_BETA * embedDist;
      }

      return {
        item,
        features: getAggregateFeatures(features),
        fingerprint: features,
        distance,
      };
    })
    .sort((a, b) => a.distance - b.distance);
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
  client: FeatureVector | StoredFingerprint,
  reference: FeatureVector | StoredFingerprint,
): FeatureDeltas {
  const ca = getAggregateFeatures(client as StoredFingerprint);
  const ra = getAggregateFeatures(reference as StoredFingerprint);

  return {
    loudnessLu: ra.integratedLoudnessLufs - ca.integratedLoudnessLufs,
    dynamicRangeDb: ra.loudnessRangeDb - ca.loudnessRangeDb,
    plrDb:
      isNumber(ca.plrDb) && isNumber(ra.plrDb) ? ra.plrDb - ca.plrDb : null,
    tempoBpm: ra.tempoBpm - ca.tempoBpm,
    stereoWidth: ra.stereoWidth - ca.stereoWidth,
    onsetRate:
      isNumber(ca.onsetRate) && isNumber(ra.onsetRate)
        ? ra.onsetRate - ca.onsetRate
        : null,
  };
}
