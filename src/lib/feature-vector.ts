import {
  BEAT_HIST_PEAKS,
  DISCOGS_EMBEDDING_DIM,
  HPCP_BINS,
  MFCC_COEFFS,
  SPECTRAL_CONTRAST_BANDS,
  type FeatureFingerprint,
  type FeatureVector,
  type StoredFingerprint,
} from "@/lib/types";

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNumberArray(value: unknown, length: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

/** Narrow unknown JSON (from Neon jsonb) to a bare FeatureVector. */
export function isFeatureVector(value: unknown): value is FeatureVector {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  // v2 envelope also has aggregate with these fields — reject by version key.
  if (v.version === 2) return false;
  return (
    isNumber(v.integratedLoudnessLufs) &&
    isNumber(v.loudnessRangeDb) &&
    isNumber(v.tempoBpm) &&
    isNumber(v.stereoWidth) &&
    Array.isArray(v.frequencyBandEnergies) &&
    v.frequencyBandEnergies.length === 7 &&
    v.frequencyBandEnergies.every((n) => typeof n === "number")
  );
}

export function isFeatureFingerprint(
  value: unknown,
): value is FeatureFingerprint {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.version !== 2) return false;
  if (!isFeatureVector(v.aggregate)) return false;
  if (!Array.isArray(v.windows) || v.windows.length === 0) return false;
  if (!v.windows.every((w) => isFeatureVector(w))) return false;
  // Invalid embedding length is ignored at the type-guard level; callers
  // should strip it rather than rejecting the whole fingerprint.
  return true;
}

/** Accepts v1 FeatureVector or v2 FeatureFingerprint. */
export function isStoredFingerprint(
  value: unknown,
): value is StoredFingerprint {
  return isFeatureFingerprint(value) || isFeatureVector(value);
}

/** Primary vector for UI / explanations. */
export function getAggregateFeatures(
  stored: StoredFingerprint,
): FeatureVector {
  return isFeatureFingerprint(stored) ? stored.aggregate : stored;
}

/** Section vectors for multi-window ranking (single-element for v1). */
export function getFeatureWindows(
  stored: StoredFingerprint,
): FeatureVector[] {
  return isFeatureFingerprint(stored) ? stored.windows : [stored];
}

export function getEmbedding(
  stored: StoredFingerprint,
): number[] | undefined {
  return isFeatureFingerprint(stored) ? stored.embedding : undefined;
}

/** Mean-aggregate a list of window vectors for UI / storage. */
export function aggregateFeatureVectors(
  windows: FeatureVector[],
): FeatureVector {
  if (windows.length === 0) {
    throw new Error("Cannot aggregate empty feature windows");
  }
  if (windows.length === 1) return windows[0];

  const meanScalar = (pick: (f: FeatureVector) => number | undefined) => {
    const vals = windows.map(pick).filter(isNumber);
    if (vals.length === 0) return undefined;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  };

  const meanArray = (
    pick: (f: FeatureVector) => number[] | undefined,
    length: number,
  ): number[] | undefined => {
    const rows = windows.map(pick).filter((r): r is number[] =>
      Array.isArray(r) && r.length === length
    );
    if (rows.length === 0) return undefined;
    const out = new Array(length).fill(0);
    for (const row of rows) {
      for (let i = 0; i < length; i++) out[i] += row[i];
    }
    return out.map((v) => v / rows.length);
  };

  const bands = new Array(7).fill(0);
  for (const w of windows) {
    for (let i = 0; i < 7; i++) {
      bands[i] += w.frequencyBandEnergies[i] ?? 0;
    }
  }
  for (let i = 0; i < 7; i++) bands[i] /= windows.length;

  const aggregate: FeatureVector = {
    integratedLoudnessLufs:
      windows.reduce((s, w) => s + w.integratedLoudnessLufs, 0) /
      windows.length,
    loudnessRangeDb:
      windows.reduce((s, w) => s + w.loudnessRangeDb, 0) / windows.length,
    frequencyBandEnergies: bands,
    tempoBpm:
      windows.reduce((s, w) => s + w.tempoBpm, 0) / windows.length,
    stereoWidth:
      windows.reduce((s, w) => s + w.stereoWidth, 0) / windows.length,
  };

  const plr = meanScalar((f) => f.plrDb);
  if (plr !== undefined) aggregate.plrDb = plr;
  const onsets = meanScalar((f) => f.onsetRate);
  if (onsets !== undefined) aggregate.onsetRate = onsets;
  const mfccMean = meanArray((f) => f.mfccMean, MFCC_COEFFS);
  if (mfccMean) aggregate.mfccMean = mfccMean;
  const mfccStd = meanArray((f) => f.mfccStd, MFCC_COEFFS);
  if (mfccStd) aggregate.mfccStd = mfccStd;
  const centroid = meanScalar((f) => f.spectralCentroid);
  if (centroid !== undefined) aggregate.spectralCentroid = centroid;
  const rolloff = meanScalar((f) => f.spectralRolloff);
  if (rolloff !== undefined) aggregate.spectralRolloff = rolloff;
  const flux = meanScalar((f) => f.spectralFlux);
  if (flux !== undefined) aggregate.spectralFlux = flux;
  const flatness = meanScalar((f) => f.spectralFlatness);
  if (flatness !== undefined) aggregate.spectralFlatness = flatness;
  const contrast = meanArray((f) => f.spectralContrast, SPECTRAL_CONTRAST_BANDS);
  if (contrast) aggregate.spectralContrast = contrast;
  const zcr = meanScalar((f) => f.zeroCrossingRate);
  if (zcr !== undefined) aggregate.zeroCrossingRate = zcr;
  const hpcp = meanArray((f) => f.hpcp, HPCP_BINS);
  if (hpcp) aggregate.hpcp = hpcp;
  const beatBpms = meanArray((f) => f.beatHistBpms, BEAT_HIST_PEAKS);
  if (beatBpms) aggregate.beatHistBpms = beatBpms;
  const beatWeights = meanArray((f) => f.beatHistWeights, BEAT_HIST_PEAKS);
  if (beatWeights) aggregate.beatHistWeights = beatWeights;
  const rmsMean = meanScalar((f) => f.rmsMean);
  if (rmsMean !== undefined) aggregate.rmsMean = rmsMean;
  const rmsStd = meanScalar((f) => f.rmsStd);
  if (rmsStd !== undefined) aggregate.rmsStd = rmsStd;
  const crest = meanScalar((f) => f.crestFactor);
  if (crest !== undefined) aggregate.crestFactor = crest;
  const dyn = meanScalar((f) => f.dynamicComplexity);
  if (dyn !== undefined) aggregate.dynamicComplexity = dyn;

  return aggregate;
}

export function buildFingerprint(
  windows: FeatureVector[],
  embedding?: number[],
): FeatureFingerprint {
  const fp: FeatureFingerprint = {
    version: 2,
    aggregate: aggregateFeatureVectors(windows),
    windows,
  };
  if (embedding && isNumberArray(embedding, DISCOGS_EMBEDDING_DIM)) {
    fp.embedding = embedding;
  }
  return fp;
}
