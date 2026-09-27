import {
  genreLabelAffinity,
  inferPreferredGenre,
} from "@/lib/genres";
import { FREQUENCY_BANDS, type FeatureVector, type StoredFingerprint } from "@/lib/types";
import {
  getAggregateFeatures,
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
    // Loudness stays small: an unmastered mix is supposed to sit under a master.
    loudness: 0.3,
    dynamicRange: 0.55,
    plr: 0.5,
    tempo: 0.45,
    onsets: 0.35,
    stereoWidth: 0.55,
    band: 4.4,
    timbre: 2.2,
    chroma: 0.35,
    rhythm: 0.4,
    dynamicsExt: 0.4,
  },
  tone: {
    loudness: 0.15,
    dynamicRange: 0.25,
    plr: 0.2,
    tempo: 0.3,
    onsets: 0.2,
    stereoWidth: 0.45,
    band: 5.2,
    timbre: 2.6,
    chroma: 0.7,
    rhythm: 0.2,
    dynamicsExt: 0.15,
  },
  loudness: {
    loudness: 2.4,
    dynamicRange: 1.6,
    plr: 1.6,
    tempo: 0.35,
    onsets: 0.25,
    stereoWidth: 0.35,
    band: 1.4,
    timbre: 0.6,
    chroma: 0.2,
    rhythm: 0.25,
    dynamicsExt: 1.2,
  },
};

export const WEIGHT_PRESET_LABELS: Record<WeightPreset, string> = {
  balanced: "Balanced",
  tone: "Match tone",
  loudness: "Match loudness",
};

export type WeightMultipliers = Partial<Record<keyof Weights, number>>;

/**
 * Share of the published score that is genre closeness rather than tone.
 * A perfect tone match in a broader genre still sorts behind a decent
 * match that was actually searched in the requested style.
 */
export const GENRE_FIT_WEIGHT = 0.62;

/**
 * Reject a candidate when either axis is past these caps.
 * Genre is capped on its own so a tone twin from a far genre cannot
 * sneak in by having a tiny sonic distance. Tone is capped on its own
 * so the right genre cannot excuse a different record.
 */
export const MAX_SONIC_DISTANCE = 0.24;
export const MAX_GENRE_CLOSENESS = 0.62;

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

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

function unitDistance(delta: number, scale: number): number {
  if (!Number.isFinite(delta) || scale <= 0) return 1;
  return Math.min(1, Math.abs(delta) / scale);
}

function meanAbsOverlap(
  a: number[] | undefined,
  b: number[] | undefined,
): number | null {
  if (!a || !b || a.length === 0 || b.length === 0) return null;
  const n = Math.min(a.length, b.length);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (!isNumber(a[i]) || !isNumber(b[i])) continue;
    sum += Math.abs(a[i] - b[i]);
    count += 1;
  }
  return count === 0 ? null : sum / count;
}

/**
 * One sonic axis on a fixed scale (0 = same, 1 = far).
 * Scales are in the feature's own units so a cutoff means the same
 * thing on every search. Pool z-scoring cannot do that: a weak pool
 * shrinks its own distances and everything looks acceptable.
 */
function pushAxis(
  axes: Array<{ distance: number; weight: number }>,
  distance: number | null,
  weight: number,
) {
  if (distance == null || !Number.isFinite(distance) || weight <= 0) return;
  axes.push({ distance: clamp01(distance), weight });
}

function bandDistance(a: number[], b: number[]): number {
  let weighted = 0;
  let weightSum = 0;
  const n = Math.min(FREQUENCY_BANDS.length, a.length, b.length);
  for (let i = 0; i < n; i++) {
    const emphasis = BAND_EMPHASIS[i] ?? 1;
    weighted += emphasis * Math.abs((a[i] ?? 0) - (b[i] ?? 0));
    weightSum += emphasis;
  }
  if (weightSum === 0) return 0;
  // 0.18 average absolute band share is a different tonal balance.
  return unitDistance(weighted / weightSum, 0.18);
}

function timbreDistance(a: FeatureVector, b: FeatureVector): number | null {
  const parts: number[] = [];
  const mfcc = meanAbsOverlap(a.mfccMean, b.mfccMean);
  if (mfcc != null) parts.push(unitDistance(mfcc, 12));
  const mfccStd = meanAbsOverlap(a.mfccStd, b.mfccStd);
  if (mfccStd != null) parts.push(unitDistance(mfccStd, 6));
  if (isNumber(a.spectralCentroid) && isNumber(b.spectralCentroid)) {
    parts.push(unitDistance(a.spectralCentroid - b.spectralCentroid, 1800));
  }
  if (isNumber(a.spectralRolloff) && isNumber(b.spectralRolloff)) {
    parts.push(unitDistance(a.spectralRolloff - b.spectralRolloff, 2500));
  }
  if (isNumber(a.spectralFlatness) && isNumber(b.spectralFlatness)) {
    parts.push(unitDistance(a.spectralFlatness - b.spectralFlatness, 0.25));
  }
  const contrast = meanAbsOverlap(a.spectralContrast, b.spectralContrast);
  if (contrast != null) parts.push(unitDistance(contrast, 8));
  if (parts.length === 0) return null;
  return parts.reduce((sum, value) => sum + value, 0) / parts.length;
}

function rhythmDistance(a: FeatureVector, b: FeatureVector): number | null {
  const parts: number[] = [];
  if (isNumber(a.spectralFlux) && isNumber(b.spectralFlux)) {
    parts.push(unitDistance(a.spectralFlux - b.spectralFlux, 0.08));
  }
  if (isNumber(a.zeroCrossingRate) && isNumber(b.zeroCrossingRate)) {
    parts.push(unitDistance(a.zeroCrossingRate - b.zeroCrossingRate, 0.04));
  }
  if (
    isNumber(a.beatHistBpms?.[0]) &&
    isNumber(b.beatHistBpms?.[0])
  ) {
    parts.push(
      unitDistance(tempoDistance(a.beatHistBpms[0], b.beatHistBpms[0]), 16),
    );
  }
  if (parts.length === 0) return null;
  return parts.reduce((sum, value) => sum + value, 0) / parts.length;
}

function dynamicsExtDistance(a: FeatureVector, b: FeatureVector): number | null {
  const parts: number[] = [];
  if (isNumber(a.crestFactor) && isNumber(b.crestFactor)) {
    parts.push(unitDistance(a.crestFactor - b.crestFactor, 8));
  }
  if (isNumber(a.dynamicComplexity) && isNumber(b.dynamicComplexity)) {
    parts.push(unitDistance(a.dynamicComplexity - b.dynamicComplexity, 0.35));
  }
  if (isNumber(a.rmsStd) && isNumber(b.rmsStd)) {
    parts.push(unitDistance(a.rmsStd - b.rmsStd, 0.08));
  }
  if (parts.length === 0) return null;
  return parts.reduce((sum, value) => sum + value, 0) / parts.length;
}

/**
 * Sonic distance in 0..1 using mastering-relevant axes.
 * Loudness is intentionally light: the client is unmastered, so a
 * commercial reference is supposed to be louder. Tonal balance carries
 * the timbre budget when MFCC/spectral fields are missing.
 */
export function sonicDistance(
  client: FeatureVector,
  reference: FeatureVector,
  weights: Weights,
): number {
  const axes: Array<{ distance: number; weight: number }> = [];
  const timbre = timbreDistance(client, reference);
  const toneWeight = weights.band + (timbre == null ? weights.timbre : 0);

  pushAxis(
    axes,
    unitDistance(
      client.integratedLoudnessLufs - reference.integratedLoudnessLufs,
      8,
    ),
    weights.loudness,
  );
  pushAxis(
    axes,
    unitDistance(client.loudnessRangeDb - reference.loudnessRangeDb, 6),
    weights.dynamicRange,
  );
  pushAxis(
    axes,
    isNumber(client.plrDb) && isNumber(reference.plrDb)
      ? unitDistance(client.plrDb - reference.plrDb, 6)
      : null,
    weights.plr,
  );
  pushAxis(
    axes,
    unitDistance(tempoDistance(client.tempoBpm, reference.tempoBpm), 16),
    weights.tempo,
  );
  pushAxis(
    axes,
    isNumber(client.onsetRate) && isNumber(reference.onsetRate)
      ? unitDistance(client.onsetRate - reference.onsetRate, 1.5)
      : null,
    weights.onsets,
  );
  pushAxis(
    axes,
    unitDistance(client.stereoWidth - reference.stereoWidth, 0.35),
    weights.stereoWidth,
  );
  pushAxis(
    axes,
    bandDistance(
      client.frequencyBandEnergies,
      reference.frequencyBandEnergies,
    ),
    toneWeight,
  );
  pushAxis(axes, timbre, weights.timbre);

  const chroma = meanAbsOverlap(client.hpcp, reference.hpcp);
  pushAxis(axes, chroma == null ? null : unitDistance(chroma, 0.25), weights.chroma);
  pushAxis(axes, rhythmDistance(client, reference), weights.rhythm);
  pushAxis(axes, dynamicsExtDistance(client, reference), weights.dynamicsExt);

  let weighted = 0;
  let weightSum = 0;
  for (const axis of axes) {
    weighted += axis.weight * axis.distance;
    weightSum += axis.weight;
  }
  return weightSum === 0 ? 1 : weighted / weightSum;
}

function averageWindowSonic(
  query: StoredFingerprint,
  candidate: StoredFingerprint,
  weights: Weights,
): number {
  const qWindows = getFeatureWindows(query);
  const cWindows = getFeatureWindows(candidate);
  const n = Math.min(qWindows.length, cWindows.length);
  if (n <= 0) {
    return sonicDistance(
      getAggregateFeatures(query),
      getAggregateFeatures(candidate),
      weights,
    );
  }
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += sonicDistance(qWindows[i], cWindows[i], weights);
  }
  return sum / n;
}

/** Published score: lower is a closer reference. Genre cannot be cancelled by tone. */
export function referenceFitScore(
  sonic: number,
  genreCloseness: number,
): number {
  return (
    (1 - GENRE_FIT_WEIGHT) * clamp01(sonic) +
    GENRE_FIT_WEIGHT * clamp01(genreCloseness)
  );
}

export function passesReferenceFit(
  sonic: number,
  genreCloseness: number,
): boolean {
  return (
    clamp01(sonic) <= MAX_SONIC_DISTANCE &&
    clamp01(genreCloseness) <= MAX_GENRE_CLOSENESS
  );
}

export interface RankedReference<T> extends RankedMatch<T> {
  sonicDistance: number;
  genreCloseness: number;
}

/**
 * Rank commercial references.
 * Presets change which sonic axes matter. Genre closeness is applied
 * after that, including for "Match tone", so a tone twin in a looser
 * genre still sorts behind a nearer style.
 * This does not drop weak hits — the search applies passesReferenceFit
 * so a loudness preset can reorder an already-accepted shortlist
 * without emptying it.
 */
export function rankReferences<T>(
  query: StoredFingerprint,
  candidates: Array<{
    item: T;
    features: StoredFingerprint;
    genreCloseness: number;
  }>,
  preset: WeightPreset = "balanced",
  multipliers?: WeightMultipliers,
): RankedReference<T>[] {
  if (candidates.length === 0) return [];
  const weights = applyMultipliers(WEIGHT_PRESETS[preset], multipliers);

  return candidates
    .map(({ item, features, genreCloseness }) => {
      const sonic = averageWindowSonic(query, features, weights);
      return {
        item,
        features: getAggregateFeatures(features),
        fingerprint: features,
        sonicDistance: sonic,
        genreCloseness,
        distance: referenceFitScore(sonic, genreCloseness),
      };
    })
    .sort((a, b) => a.distance - b.distance);
}

interface DisplayMatch {
  featureVector: FeatureVector;
  genre: string;
  genreCloseness?: number;
  distanceScore: number;
}

/**
 * Fresh searches already arrive in balanced order, including learned weights.
 * Tone and loudness presets reorder that shortlist without a new search.
 * Genre closeness stays in the score so "Match tone" cannot bury a nearer style.
 */
export function orderDisplayedMatches<T extends DisplayMatch>(
  client: StoredFingerprint,
  matches: T[],
  preset: WeightPreset,
): T[] {
  if (preset === "balanced" || matches.length === 0) return matches;
  const canInfer = matches.some(
    (match) => typeof match.genreCloseness !== "number",
  );
  const preferred = canInfer
    ? inferPreferredGenre(matches.map((match) => match.genre))
    : null;

  // Preset toggles only have the reference aggregate on the client,
  // so compare that to the client's aggregate instead of its first window.
  return rankReferences(
    getAggregateFeatures(client),
    matches.map((match) => ({
      item: match,
      features: match.featureVector,
      genreCloseness:
        typeof match.genreCloseness === "number"
          ? match.genreCloseness
          : preferred
            ? genreLabelAffinity(preferred, match.genre, null)
            : 0,
    })),
    preset,
  ).map((hit) => ({
    ...hit.item,
    distanceScore: hit.distance,
  }));
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
