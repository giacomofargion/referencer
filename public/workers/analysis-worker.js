/* global Essentia */
/**
 * Audio analysis worker (classic worker, not a module).
 * Loads the Essentia WASM backend from /public and computes a multi-window
 * FeatureFingerprint off the main thread. Kept as plain JS because it uses
 * importScripts and UMD globals, which bundlers handle badly.
 *
 * Keep algorithms in sync with src/lib/extract-features.ts.
 */

// The UMD build's Emscripten runtime initializes asynchronously; hook the
// callback before importScripts so we never race it.
let resolveRuntime;
const runtimeReady = new Promise((resolve) => {
  resolveRuntime = resolve;
});
self.Module = { onRuntimeInitialized: () => resolveRuntime() };
// The UMD build ends with `exports.EssentiaWASM = Module`, and workers
// have no `exports` global — provide one so the assignment doesn't throw.
self.exports = {};

importScripts(
  "/essentia/essentia-wasm.umd.js",
  "/essentia/essentia.js-core.js",
);

if (self.Module.calledRun) resolveRuntime();

// Must match FREQUENCY_BANDS / extract-features.ts / server analysis.
const BAND_EDGES = [20, 60, 250, 500, 2000, 4000, 8000, 20000];
const FRAME_SIZE = 4096;
const HOP_SIZE = 2048;
// Client can afford a longer tempo slice than the server (30s) — full tracks.
const TEMPO_SLICE_SECONDS = 60;
const MIN_WINDOW_SECONDS = 8;
const TARGET_WINDOW_SECONDS = 20;
const MAX_WINDOWS = 5;
const MFCC_COEFFS = 13;
const HPCP_BINS = 12;
const SPECTRAL_CONTRAST_BANDS = 6;
const BEAT_HIST_PEAKS = 2;

const essentiaReady = runtimeReady.then(() => new Essentia(self.Module));

function safeDelete(obj) {
  if (obj && typeof obj.delete === "function") obj.delete();
}

function meanStd(values) {
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

function columnMeanStd(rows, fallbackDim) {
  if (rows.length === 0) {
    return {
      mean: new Array(fallbackDim).fill(0),
      std: new Array(fallbackDim).fill(0),
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

function computeStereoWidth(left, right) {
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

function computeSamplePeakDb(left, right) {
  let peak = 0;
  for (let i = 0; i < left.length; i++) {
    const l = Math.abs(left[i]);
    const r = Math.abs(right[i]);
    if (l > peak) peak = l;
    if (r > peak) peak = r;
  }
  return peak === 0 ? -Infinity : 20 * Math.log10(peak);
}

function centerSlice(mono, sampleRate, seconds) {
  const sliceLength = Math.min(mono.length, Math.floor(seconds * sampleRate));
  const start = Math.max(0, Math.floor((mono.length - sliceLength) / 2));
  return mono.subarray(start, start + sliceLength);
}

function computeOnsetRate(essentia, mono, sampleRate) {
  const slice = centerSlice(mono, sampleRate, TEMPO_SLICE_SECONDS);
  const sliceVector = essentia.arrayToVector(slice);
  const result = essentia.OnsetRate(sliceVector);
  sliceVector.delete();
  safeDelete(result.onsets);
  // OnsetRate assumes 44.1 kHz internally; rescale for other rates.
  return result.onsetRate * (sampleRate / 44100);
}

function computeTempo(essentia, mono, sampleRate) {
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
  return result.bpm;
}

function computeBeatHistogram(essentia, mono, sampleRate) {
  const zeros = {
    bpms: new Array(BEAT_HIST_PEAKS).fill(0),
    weights: new Array(BEAT_HIST_PEAKS).fill(0),
  };
  try {
    // Cap at 20s — RhythmDescriptors is heavy; min(TEMPO_SLICE, 20).
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
 * FrameGenerator frames are owned by the generator — only delete Windowing /
 * Spectrum (and algorithm-owned vectors) per frame, matching extract-features.ts.
 */
function computeFrameDescriptors(essentia, mono, sampleRate) {
  const nyquist = sampleRate / 2;
  const bandSums = new Array(BAND_EDGES.length - 1).fill(0);
  const mfccRows = [];
  const centroids = [];
  const rolloffs = [];
  const fluxes = [];
  const flatnesses = [];
  const contrastRows = [];
  const zcrs = [];
  const hpcpSums = new Array(HPCP_BINS).fill(0);
  let hpcpCount = 0;
  const rmsValues = [];
  const crests = [];

  let prevSpectrum = null;
  const frames = essentia.FrameGenerator(mono, FRAME_SIZE, HOP_SIZE);
  const frameCount = frames.size();
  const spectrumSize = FRAME_SIZE / 2 + 1;

  for (let i = 0; i < frameCount; i++) {
    const frame = frames.get(i);

    const rms = essentia.RMS(frame);
    rmsValues.push(rms.rms);

    const zcr = essentia.ZeroCrossingRate(frame);
    zcrs.push(zcr.zeroCrossingRate);

    const windowed = essentia.Windowing(frame, true, FRAME_SIZE, "hann");
    const spectrum = essentia.Spectrum(windowed.frame, FRAME_SIZE);
    const specArr = essentia.vectorToArray(spectrum.spectrum);

    for (let b = 0; b < bandSums.length; b++) {
      const low = BAND_EDGES[b];
      const high = Math.min(BAND_EDGES[b + 1], nyquist);
      if (low >= nyquist) break;
      // FrequencyBands UMD wrapper is buggy; EnergyBand per band instead.
      const band = essentia.EnergyBand(
        spectrum.spectrum,
        sampleRate,
        low,
        high,
      );
      bandSums[b] += band.energyBand;
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
      centroids.push(centroid.centroid);
    } catch {
      /* skip */
    }

    try {
      const rolloff = essentia.RollOff(spectrum.spectrum, 0.85, sampleRate);
      rolloffs.push(rolloff.rollOff);
    } catch {
      /* skip */
    }

    try {
      const flat = essentia.Flatness(spectrum.spectrum);
      flatnesses.push(flat.flatness);
    } catch {
      /* skip */
    }

    try {
      const crest = essentia.Crest(spectrum.spectrum);
      crests.push(crest.crest);
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

  const bandTotal = bandSums.reduce((a, v) => a + v, 0);
  const frequencyBandEnergies =
    bandTotal === 0 ? bandSums : bandSums.map((v) => v / bandTotal);

  const mfccStats = columnMeanStd(mfccRows, MFCC_COEFFS);
  const contrastStats = columnMeanStd(
    contrastRows.length > 0
      ? contrastRows
      : [new Array(SPECTRAL_CONTRAST_BANDS).fill(0)],
    SPECTRAL_CONTRAST_BANDS,
  );
  const rmsStats = meanStd(rmsValues);
  const dynamicComplexity =
    rmsStats.mean > 1e-12 ? rmsStats.std / rmsStats.mean : 0;

  const hpcp =
    hpcpCount === 0
      ? new Array(HPCP_BINS).fill(0)
      : hpcpSums.map((v) => v / hpcpCount);

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
function extractFeatures(essentia, left, right, sampleRate) {
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
  // Keep in sync with src/lib/extract-features.ts.
  const rawIntegrated = loudness.integratedLoudness;
  const integratedLoudness = Number.isFinite(rawIntegrated)
    ? rawIntegrated
    : -70; // EBU R128 absolute gate
  const rawRange = loudness.loudnessRange;
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
function planAnalysisWindows(durationSec) {
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

/** Mean-aggregate window vectors (mirrors buildFingerprint / aggregateFeatureVectors). */
function aggregateFeatureVectors(windows) {
  if (windows.length === 0) {
    throw new Error("Cannot aggregate empty feature windows");
  }
  if (windows.length === 1) return windows[0];

  const n = windows.length;
  const meanScalar = (pick) =>
    windows.reduce((s, w) => s + pick(w), 0) / n;
  const meanArray = (pick, length) => {
    const out = new Array(length).fill(0);
    for (const w of windows) {
      const row = pick(w);
      for (let i = 0; i < length; i++) out[i] += row[i];
    }
    return out.map((v) => v / n);
  };

  return {
    integratedLoudnessLufs: meanScalar((w) => w.integratedLoudnessLufs),
    loudnessRangeDb: meanScalar((w) => w.loudnessRangeDb),
    frequencyBandEnergies: meanArray((w) => w.frequencyBandEnergies, 7),
    tempoBpm: meanScalar((w) => w.tempoBpm),
    stereoWidth: meanScalar((w) => w.stereoWidth),
    plrDb: meanScalar((w) => w.plrDb),
    onsetRate: meanScalar((w) => w.onsetRate),
    mfccMean: meanArray((w) => w.mfccMean, MFCC_COEFFS),
    mfccStd: meanArray((w) => w.mfccStd, MFCC_COEFFS),
    spectralCentroid: meanScalar((w) => w.spectralCentroid),
    spectralRolloff: meanScalar((w) => w.spectralRolloff),
    spectralFlux: meanScalar((w) => w.spectralFlux),
    spectralFlatness: meanScalar((w) => w.spectralFlatness),
    spectralContrast: meanArray(
      (w) => w.spectralContrast,
      SPECTRAL_CONTRAST_BANDS,
    ),
    zeroCrossingRate: meanScalar((w) => w.zeroCrossingRate),
    hpcp: meanArray((w) => w.hpcp, HPCP_BINS),
    beatHistBpms: meanArray((w) => w.beatHistBpms, BEAT_HIST_PEAKS),
    beatHistWeights: meanArray((w) => w.beatHistWeights, BEAT_HIST_PEAKS),
    rmsMean: meanScalar((w) => w.rmsMean),
    rmsStd: meanScalar((w) => w.rmsStd),
    crestFactor: meanScalar((w) => w.crestFactor),
    dynamicComplexity: meanScalar((w) => w.dynamicComplexity),
  };
}

function buildFingerprint(windows) {
  return {
    version: 2,
    aggregate: aggregateFeatureVectors(windows),
    windows,
  };
}

function extractFingerprint(essentia, left, right, sampleRate) {
  const n = Math.min(left.length, right.length);
  const durationSec = n / sampleRate;
  const { count, windowSec } = planAnalysisWindows(durationSec);
  const windowSamples = Math.max(1, Math.floor(windowSec * sampleRate));
  const windows = [];

  for (let w = 0; w < count; w++) {
    const start = Math.min(n - 1, Math.floor(w * windowSamples));
    const end = Math.min(n, start + windowSamples);
    if (end - start < sampleRate * 0.5) continue;
    windows.push(
      extractFeatures(
        essentia,
        left.subarray(start, end),
        right.subarray(start, end),
        sampleRate,
      ),
    );
  }

  if (windows.length === 0) {
    windows.push(extractFeatures(essentia, left, right, sampleRate));
  }

  return buildFingerprint(windows);
}

self.onmessage = async (event) => {
  const { left, right, sampleRate } = event.data;
  try {
    const essentia = await essentiaReady;
    const fingerprint = extractFingerprint(
      essentia,
      left,
      right,
      sampleRate,
    );
    self.postMessage({ type: "result", fingerprint });
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
