/* global Essentia */
/**
 * Audio analysis worker (classic worker, not a module).
 * Loads the Essentia WASM backend from /public and computes the app's
 * feature vector off the main thread. Kept as plain JS because it uses
 * importScripts and UMD globals, which bundlers handle badly.
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

// Band edges must match FREQUENCY_BANDS in src/lib/types.ts
const BAND_EDGES = [20, 60, 250, 500, 2000, 4000, 8000, 20000];
const FRAME_SIZE = 4096;
const HOP_SIZE = 2048;
// Tempo estimation is expensive; a centered slice is plenty for BPM.
const TEMPO_SLICE_SECONDS = 60;

const essentiaReady = runtimeReady.then(() => new Essentia(self.Module));

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

// Note: essentia.js's FrequencyBands wrapper has a bug (iterates an empty
// vector when converting band edges), so we use EnergyBand per band instead.
function computeBandEnergies(essentia, mono, sampleRate) {
  const nyquist = sampleRate / 2;
  const sums = new Array(BAND_EDGES.length - 1).fill(0);
  const frames = essentia.FrameGenerator(mono, FRAME_SIZE, HOP_SIZE);
  const frameCount = frames.size();

  for (let i = 0; i < frameCount; i++) {
    const frame = frames.get(i);
    const windowed = essentia.Windowing(frame, true, FRAME_SIZE, "hann");
    const spectrum = essentia.Spectrum(windowed.frame, FRAME_SIZE);
    for (let b = 0; b < sums.length; b++) {
      const low = BAND_EDGES[b];
      const high = Math.min(BAND_EDGES[b + 1], nyquist);
      if (low >= nyquist) break;
      const band = essentia.EnergyBand(spectrum.spectrum, sampleRate, low, high);
      sums[b] += band.energyBand;
    }
    windowed.frame.delete();
    spectrum.spectrum.delete();
  }
  frames.delete();

  const total = sums.reduce((acc, v) => acc + v, 0);
  if (total === 0) return sums;
  return sums.map((v) => v / total);
}

function computeTempo(essentia, mono, sampleRate) {
  const sliceLength = Math.min(mono.length, TEMPO_SLICE_SECONDS * sampleRate);
  const start = Math.max(0, Math.floor((mono.length - sliceLength) / 2));
  const slice = mono.subarray(start, start + sliceLength);
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

// Onset events per second (rhythmic density), from the same centered slice
// as tempo. OnsetRate assumes 44.1 kHz internally, so rescale for other rates.
function computeOnsetRate(essentia, mono, sampleRate) {
  const sliceLength = Math.min(mono.length, TEMPO_SLICE_SECONDS * sampleRate);
  const start = Math.max(0, Math.floor((mono.length - sliceLength) / 2));
  const slice = mono.subarray(start, start + sliceLength);
  const sliceVector = essentia.arrayToVector(slice);
  const result = essentia.OnsetRate(sliceVector);
  sliceVector.delete();
  if (result.onsets && typeof result.onsets.delete === "function") {
    result.onsets.delete();
  }
  return result.onsetRate * (sampleRate / 44100);
}

self.onmessage = async (event) => {
  const { left, right, sampleRate } = event.data;
  try {
    const essentia = await essentiaReady;

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

    const featureVector = {
      integratedLoudnessLufs: loudness.integratedLoudness,
      loudnessRangeDb: loudness.loudnessRange,
      frequencyBandEnergies: computeBandEnergies(essentia, mono, sampleRate),
      tempoBpm: computeTempo(essentia, mono, sampleRate),
      stereoWidth: computeStereoWidth(left, right),
      plrDb: Number.isFinite(peakDb)
        ? peakDb - loudness.integratedLoudness
        : 0,
      onsetRate: computeOnsetRate(essentia, mono, sampleRate),
    };

    self.postMessage({ type: "result", featureVector });
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
