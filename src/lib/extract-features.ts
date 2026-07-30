import { Essentia, EssentiaWASM } from "essentia.js";

import { buildFingerprint } from "@/lib/feature-vector";
import {
  DEFAULT_LOUDEST_WINDOW_SECONDS,
  findLoudestWindowStartSeconds,
  mixToMono,
} from "@/lib/loudest-window";
import {
  BEAT_HIST_PEAKS,
  HPCP_BINS,
  MFCC_COEFFS,
  SPECTRAL_CONTRAST_BANDS,
  type FeatureFingerprint,
  type FeatureVector,
} from "@/lib/types";

// Keep in sync with public/workers/analysis-worker.js
const BAND_EDGES = [20, 60, 250, 500, 2000, 4000, 8000, 20000];
const FRAME_SIZE = 4096;
const HOP_SIZE = 2048;
const TEMPO_SLICE_SECONDS = 30;
const MIN_WINDOW_SECONDS = 8;
const TARGET_WINDOW_SECONDS = 20;
const MAX_WINDOWS = 5;

type EssentiaInstance = InstanceType<typeof Essentia>;

let essentiaSingleton: EssentiaInstance | null = null;

function getEssentia(): EssentiaInstance {
  if (!essentiaSingleton) {
    essentiaSingleton = new Essentia(EssentiaWASM);
  }
  return essentiaSingleton;
}

function safeDelete(obj: { delete?: () => void } | null | undefined) {
  if (obj && typeof obj.delete === "function") obj.delete();
}

function meanStd(values: number[]): { mean: number; std: number } {
  if (values.length === 0) return { mean: 0, std: 0 };
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / values.length;
  let varSum = 0;
  for (const v of values) {
    const d = v - mean;
    varSum += d * d;
  }
  return { mean, std: Math.sqrt(varSum / values.length) };
}

function columnMeanStd(rows: number[][]): { mean: number[]; std: number[] } {
  if (rows.length === 0) {
    return {
      mean: new Array(MFCC_COEFFS).fill(0),
      std: new Array(MFCC_COEFFS).fill(0),
    };
  }
  const dim = rows[0].length;
  const mean = new Array(dim).fill(0);
  for (const row of rows) {
    for (let i = 0; i < dim; i++) mean[i] += row[i];
  }
  for (let i = 0; i < dim; i++) mean[i] /= rows.length;
  const std = new Array(dim).fill(0);
  for (const row of rows) {
    for (let i = 0; i < dim; i++) {
      const d = row[i] - mean[i];
      std[i] += d * d;
    }
  }
  for (let i = 0; i < dim; i++) std[i] = Math.sqrt(std[i] / rows.length);
  return { mean, std };
}

function computeStereoWidth(left: Float32Array, right: Float32Array): number {
  let midEnergy = 0;
  let sideEnergy = 0;
  for (let i = 0; i < left.length; i++) {
    const mid = (left[i] + right[i]) * 0.5;
    const side = (left[i] - right[i]) * 0.5;
    midEnergy += mid * mid;
    sideEnergy += side * side;
  }
  const total = midEnergy + sideEnergy;
  return total === 0 ? 0 : sideEnergy / total;
}

function computeSamplePeakDb(left: Float32Array, right: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < left.length; i++) {
    const l = Math.abs(left[i]);
    const r = Math.abs(right[i]);
    if (l > peak) peak = l;
    if (r > peak) peak = r;
  }
  return peak === 0 ? -Infinity : 20 * Math.log10(peak);
}

function centerSlice(
  mono: Float32Array,
  sampleRate: number,
  seconds: number,
): Float32Array {
  const sliceLength = Math.min(mono.length, Math.floor(seconds * sampleRate));
  const start = Math.max(0, Math.floor((mono.length - sliceLength) / 2));
  return mono.subarray(start, start + sliceLength);
}

function computeOnsetRate(
  essentia: EssentiaInstance,
  mono: Float32Array,
  sampleRate: number,
): number {
  const slice = centerSlice(mono, sampleRate, TEMPO_SLICE_SECONDS);
  const sliceVector = essentia.arrayToVector(slice);
  const result = essentia.OnsetRate(sliceVector);
  sliceVector.delete();
  safeDelete(result.onsets);
  return result.onsetRate * (sampleRate / 44100);
}

function computeTempo(
  essentia: EssentiaInstance,
  mono: Float32Array,
  sampleRate: number,
): number {
  const slice = centerSlice(mono, sampleRate, TEMPO_SLICE_SECONDS);
  const sliceVector = essentia.arrayToVector(slice);
  const result = essentia.PercivalBpmEstimator(
    sliceVector,
    1024,
    2048,
    128,
    128,
    210,
    50,
    sampleRate,
  );
  sliceVector.delete();
  return result.bpm as number;
}

function computeBeatHistogram(
  essentia: EssentiaInstance,
  mono: Float32Array,
  sampleRate: number,
): { bpms: number[]; weights: number[] } {
  const zeros = {
    bpms: new Array(BEAT_HIST_PEAKS).fill(0),
    weights: new Array(BEAT_HIST_PEAKS).fill(0),
  };
  try {
    const slice = centerSlice(
      mono,
      sampleRate,
      Math.min(TEMPO_SLICE_SECONDS, 20),
    );
    if (slice.length < sampleRate * 4) return zeros;
    const sliceVector = essentia.arrayToVector(slice);
    const result = essentia.RhythmDescriptors(sliceVector);
    sliceVector.delete();
    safeDelete(result.beats_position);
    safeDelete(result.bpm_estimates);
    safeDelete(result.bpm_intervals);
    safeDelete(result.histogram);
    return {
      bpms: [
        Number(result.first_peak_bpm) || 0,
        Number(result.second_peak_bpm) || 0,
      ],
      weights: [
        Number(result.first_peak_weight) || 0,
        Number(result.second_peak_weight) || 0,
      ],
    };
  } catch {
    return zeros;
  }
}

/**
 * Single-pass frame loop: bands, MFCC, spectral descriptors, HPCP, RMS, ZCR.
 */
function computeFrameDescriptors(
  essentia: EssentiaInstance,
  mono: Float32Array,
  sampleRate: number,
): {
  frequencyBandEnergies: number[];
  mfccMean: number[];
  mfccStd: number[];
  spectralCentroid: number;
  spectralRolloff: number;
  spectralFlux: number;
  spectralFlatness: number;
  spectralContrast: number[];
  zeroCrossingRate: number;
  hpcp: number[];
  rmsMean: number;
  rmsStd: number;
  crestFactor: number;
  dynamicComplexity: number;
} {
  const nyquist = sampleRate / 2;
  const bandSums = new Array(BAND_EDGES.length - 1).fill(0);
  const mfccRows: number[][] = [];
  const centroids: number[] = [];
  const rolloffs: number[] = [];
  const fluxes: number[] = [];
  const flatnesses: number[] = [];
  const contrastRows: number[][] = [];
  const zcrs: number[] = [];
  const hpcpSums = new Array(HPCP_BINS).fill(0);
  let hpcpCount = 0;
  const rmsValues: number[] = [];
  const crests: number[] = [];

  let prevSpectrum: Float32Array | null = null;
  const frames = essentia.FrameGenerator(mono, FRAME_SIZE, HOP_SIZE);
  const frameCount = frames.size() as number;
  const spectrumSize = FRAME_SIZE / 2 + 1;

  for (let i = 0; i < frameCount; i++) {
    const frame = frames.get(i);

    const rms = essentia.RMS(frame);
    rmsValues.push(rms.rms as number);

    const zcr = essentia.ZeroCrossingRate(frame);
    zcrs.push(zcr.zeroCrossingRate as number);

    const windowed = essentia.Windowing(frame, true, FRAME_SIZE, "hann");
    const spectrum = essentia.Spectrum(windowed.frame, FRAME_SIZE);
    const specArr = essentia.vectorToArray(spectrum.spectrum);

    for (let b = 0; b < bandSums.length; b++) {
      const low = BAND_EDGES[b];
      const high = Math.min(BAND_EDGES[b + 1], nyquist);
      if (low >= nyquist) break;
      const band = essentia.EnergyBand(
        spectrum.spectrum,
        sampleRate,
        low,
        high,
      );
      bandSums[b] += band.energyBand as number;
    }

    try {
      const mfcc = essentia.MFCC(
        spectrum.spectrum,
        2,
        Math.min(11000, nyquist - 1),
        spectrumSize,
        0,
        "dbamp",
        0,
        "unit_sum",
        40,
        MFCC_COEFFS,
        sampleRate,
        1e-10,
        "power",
        "htkMel",
        "warping",
      );
      const mfccArr = Array.from(essentia.vectorToArray(mfcc.mfcc));
      if (mfccArr.length === MFCC_COEFFS) mfccRows.push(mfccArr);
      safeDelete(mfcc.mfcc);
      safeDelete(mfcc.bands);
    } catch {
      // MFCC can throw on silent frames
    }

    try {
      const centroid = essentia.Centroid(spectrum.spectrum, nyquist);
      centroids.push(centroid.centroid as number);
    } catch {
      /* skip */
    }

    try {
      const rolloff = essentia.RollOff(spectrum.spectrum, 0.85, sampleRate);
      rolloffs.push(rolloff.rollOff as number);
    } catch {
      /* skip */
    }

    try {
      const flat = essentia.Flatness(spectrum.spectrum);
      flatnesses.push(flat.flatness as number);
    } catch {
      /* skip */
    }

    try {
      const crest = essentia.Crest(spectrum.spectrum);
      crests.push(crest.crest as number);
    } catch {
      /* skip */
    }

    try {
      const contrast = essentia.SpectralContrast(
        spectrum.spectrum,
        FRAME_SIZE,
        Math.min(11000, nyquist - 1),
        20,
        0.4,
        SPECTRAL_CONTRAST_BANDS,
        sampleRate,
        0.15,
      );
      const coeffs = Array.from(
        essentia.vectorToArray(contrast.spectralContrast),
      );
      if (coeffs.length === SPECTRAL_CONTRAST_BANDS) contrastRows.push(coeffs);
      safeDelete(contrast.spectralContrast);
      safeDelete(contrast.spectralValley);
    } catch {
      /* skip */
    }

    if (prevSpectrum && prevSpectrum.length === specArr.length) {
      let flux = 0;
      for (let k = 0; k < specArr.length; k++) {
        const d = specArr[k] - prevSpectrum[k];
        flux += d * d;
      }
      fluxes.push(Math.sqrt(flux));
    }
    prevSpectrum = new Float32Array(specArr);

    try {
      const peaks = essentia.SpectralPeaks(
        spectrum.spectrum,
        0,
        Math.min(5000, nyquist - 1),
        100,
        40,
        "frequency",
        sampleRate,
      );
      const hpcp = essentia.HPCP(
        peaks.frequencies,
        peaks.magnitudes,
        true,
        500,
        0,
        Math.min(5000, nyquist - 1),
        false,
        40,
        false,
        "unitMax",
        440,
        sampleRate,
        HPCP_BINS,
        "squaredCosine",
        1,
      );
      const hpcpArr = essentia.vectorToArray(hpcp.hpcp);
      if (hpcpArr.length === HPCP_BINS) {
        for (let h = 0; h < HPCP_BINS; h++) hpcpSums[h] += hpcpArr[h];
        hpcpCount += 1;
      }
      safeDelete(peaks.frequencies);
      safeDelete(peaks.magnitudes);
      safeDelete(hpcp.hpcp);
    } catch {
      /* skip */
    }

    windowed.frame.delete();
    spectrum.spectrum.delete();
  }
  frames.delete();

  const bandTotal = bandSums.reduce((a: number, v: number) => a + v, 0);
  const frequencyBandEnergies =
    bandTotal === 0
      ? bandSums
      : bandSums.map((v: number) => v / bandTotal);

  const mfccStats = columnMeanStd(mfccRows);
  const contrastStats = columnMeanStd(
    contrastRows.length > 0
      ? contrastRows
      : [new Array(SPECTRAL_CONTRAST_BANDS).fill(0)],
  );
  const rmsStats = meanStd(rmsValues);
  const dynamicComplexity =
    rmsStats.mean > 1e-12 ? rmsStats.std / rmsStats.mean : 0;

  const hpcp =
    hpcpCount === 0
      ? new Array(HPCP_BINS).fill(0)
      : hpcpSums.map((v: number) => v / hpcpCount);

  return {
    frequencyBandEnergies,
    mfccMean: mfccStats.mean,
    mfccStd: mfccStats.std,
    spectralCentroid: meanStd(centroids).mean,
    spectralRolloff: meanStd(rolloffs).mean,
    spectralFlux: meanStd(fluxes).mean,
    spectralFlatness: meanStd(flatnesses).mean,
    spectralContrast: contrastStats.mean,
    zeroCrossingRate: meanStd(zcrs).mean,
    hpcp,
    rmsMean: rmsStats.mean,
    rmsStd: rmsStats.std,
    crestFactor: meanStd(crests).mean,
    dynamicComplexity,
  };
}

/** Extract a full FeatureVector from decoded stereo channels. */
export function extractFeatures(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
): FeatureVector {
  const essentia = getEssentia();
  const leftVector = essentia.arrayToVector(left);
  const rightVector = essentia.arrayToVector(right);

  const loudness = essentia.LoudnessEBUR128(
    leftVector,
    rightVector,
    0.1,
    sampleRate,
    false,
  );

  const monoResult = essentia.MonoMixer(leftVector, rightVector);
  const mono = essentia.vectorToArray(monoResult.audio);
  monoResult.audio.delete();
  leftVector.delete();
  rightVector.delete();

  const peakDb = computeSamplePeakDb(left, right);
  // LoudnessEBUR128 can yield non-finite values on silent/near-silent windows.
  const rawIntegrated = loudness.integratedLoudness as number;
  const integratedLoudness = Number.isFinite(rawIntegrated)
    ? rawIntegrated
    : -70; // EBU R128 absolute gate
  const rawRange = loudness.loudnessRange as number;
  const loudnessRangeDb = Number.isFinite(rawRange) ? rawRange : 0;
  // Existing safe fallback when peak or integrated loudness is unusable.
  const plrDb =
    Number.isFinite(peakDb) && Number.isFinite(rawIntegrated)
      ? peakDb - rawIntegrated
      : 0;
  const frame = computeFrameDescriptors(essentia, mono, sampleRate);
  const beat = computeBeatHistogram(essentia, mono, sampleRate);

  return {
    integratedLoudnessLufs: integratedLoudness,
    loudnessRangeDb,
    frequencyBandEnergies: frame.frequencyBandEnergies,
    tempoBpm: computeTempo(essentia, mono, sampleRate),
    stereoWidth: computeStereoWidth(left, right),
    plrDb,
    onsetRate: computeOnsetRate(essentia, mono, sampleRate),
    mfccMean: frame.mfccMean,
    mfccStd: frame.mfccStd,
    spectralCentroid: frame.spectralCentroid,
    spectralRolloff: frame.spectralRolloff,
    spectralFlux: frame.spectralFlux,
    spectralFlatness: frame.spectralFlatness,
    spectralContrast: frame.spectralContrast,
    zeroCrossingRate: frame.zeroCrossingRate,
    hpcp: frame.hpcp,
    beatHistBpms: beat.bpms,
    beatHistWeights: beat.weights,
    rmsMean: frame.rmsMean,
    rmsStd: frame.rmsStd,
    crestFactor: frame.crestFactor,
    dynamicComplexity: frame.dynamicComplexity,
  };
}

/**
 * How many equal sections to analyze: up to 5, each at least ~8s when possible.
 * Short previews collapse to 1–2 windows instead of forcing empty slices.
 */
export function planAnalysisWindows(
  durationSec: number,
): { count: number; windowSec: number } {
  if (durationSec <= MIN_WINDOW_SECONDS * 1.5) {
    return { count: 1, windowSec: durationSec };
  }
  const byTarget = Math.max(
    1,
    Math.round(durationSec / TARGET_WINDOW_SECONDS),
  );
  const byMin = Math.max(1, Math.floor(durationSec / MIN_WINDOW_SECONDS));
  const count = Math.min(MAX_WINDOWS, byTarget, byMin);
  return { count, windowSec: durationSec / count };
}

/** Multi-window fingerprint (equal segments) + loudest-window seek offset. */
export function extractFingerprint(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  embedding?: number[],
): { fingerprint: FeatureFingerprint; loudestStartSec: number } {
  const n = Math.min(left.length, right.length);
  const durationSec = n / sampleRate;
  const { count, windowSec } = planAnalysisWindows(durationSec);
  const windowSamples = Math.max(1, Math.floor(windowSec * sampleRate));
  const windows: FeatureVector[] = [];

  for (let w = 0; w < count; w++) {
    const start = Math.min(n - 1, Math.floor(w * windowSamples));
    const end = Math.min(n, start + windowSamples);
    if (end - start < sampleRate * 0.5) continue;
    windows.push(
      extractFeatures(
        left.subarray(start, end),
        right.subarray(start, end),
        sampleRate,
      ),
    );
  }

  if (windows.length === 0) {
    windows.push(extractFeatures(left, right, sampleRate));
  }

  const mono = mixToMono(left, right);
  const loudestStartSec = findLoudestWindowStartSeconds(
    mono,
    sampleRate,
    Math.min(DEFAULT_LOUDEST_WINDOW_SECONDS, durationSec),
  );

  return {
    fingerprint: buildFingerprint(windows, embedding),
    loudestStartSec,
  };
}
