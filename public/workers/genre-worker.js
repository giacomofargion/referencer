/* global Essentia, EssentiaModel, tf */
/**
 * Discogs-EffNet genre tagging worker (classic worker).
 * Mel features via Essentia TensorflowInputMusiCNN; 400-class head via TF.js
 * GraphModel under /models/discogs-genre/ (see scripts/download-discogs-tfjs.sh).
 */

let resolveRuntime;
const runtimeReady = new Promise((resolve) => {
  resolveRuntime = resolve;
});
self.Module = { onRuntimeInitialized: () => resolveRuntime() };
self.exports = {};

importScripts(
  "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js",
  "/essentia/essentia-wasm.umd.js",
  "/essentia/essentia.js-core.js",
  "/essentia/essentia.js-model.umd.js",
);

if (self.Module.calledRun) resolveRuntime();

const MODEL_URL = "/models/discogs-genre/model.json";
const LABELS_URL = "/models/discogs-genre/labels.json";
const TARGET_SR = 16000;
const PATCH_FRAMES = 128;
const MAX_AUDIO_SEC = 45;
const MEL_HOP = 256;

let modelPromise = null;
let labelsPromise = null;

function loadModel() {
  if (!modelPromise) {
    modelPromise = tf.loadGraphModel(MODEL_URL);
  }
  return modelPromise;
}

function loadLabels() {
  if (!labelsPromise) {
    labelsPromise = fetch(LABELS_URL)
      .then((r) => {
        if (!r.ok) throw new Error("Discogs labels missing — run scripts/download-discogs-tfjs.sh");
        return r.json();
      });
  }
  return labelsPromise;
}

function downsampleTo16k(mono, sampleRate) {
  if (sampleRate === TARGET_SR) return mono;
  const ratio = sampleRate / TARGET_SR;
  const outLen = Math.floor(mono.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    out[i] = mono[Math.min(mono.length - 1, Math.floor(i * ratio))];
  }
  return out;
}

function centerSlice(mono, sampleRate) {
  const maxSamples = Math.floor(MAX_AUDIO_SEC * sampleRate);
  if (mono.length <= maxSamples) return mono;
  const start = Math.floor((mono.length - maxSamples) / 2);
  return mono.subarray(start, start + maxSamples);
}

function averagePredictions(predArrays) {
  const dim = predArrays[0].length;
  const acc = new Float32Array(dim);
  for (const row of predArrays) {
    for (let i = 0; i < dim; i++) acc[i] += row[i];
  }
  const n = predArrays.length;
  for (let i = 0; i < dim; i++) acc[i] /= n;
  return acc;
}

function topK(activations, labels, k) {
  const indexed = [];
  for (let i = 0; i < activations.length; i++) {
    indexed.push({ i, score: activations[i] });
  }
  indexed.sort((a, b) => b.score - a.score);
  return indexed.slice(0, k).map(({ i, score }) => ({
    label: labels[i] ?? `class_${i}`,
    score,
  }));
}

async function classify(mono, sampleRate) {
  await runtimeReady;
  const [model, labels] = await Promise.all([loadModel(), loadLabels()]);

  const audio = centerSlice(downsampleTo16k(mono, sampleRate), TARGET_SR);
  const extractor = new EssentiaModel.EssentiaTFInputExtractor(
    self.Module,
    "musicnn",
    false,
  );
  let features;
  try {
    features = extractor.computeFrameWise(audio, MEL_HOP);
  } finally {
    extractor.delete();
  }

  const mel = features.melSpectrum; // Array of frames, each length 96
  if (!Array.isArray(mel) || mel.length < PATCH_FRAMES) {
    throw new Error("Audio too short for Discogs genre model");
  }

  const patches = [];
  for (let start = 0; start + PATCH_FRAMES <= mel.length; start += PATCH_FRAMES) {
    const patch = [];
    for (let f = 0; f < PATCH_FRAMES; f++) {
      patch.push(Array.from(mel[start + f]));
    }
    patches.push(patch);
  }
  if (patches.length === 0) {
    throw new Error("No mel patches for Discogs genre model");
  }

  const predRows = await tf.tidy(() => {
    const input = tf.tensor3d(patches); // [N, 128, 96]
    const out = model.execute({ melspectrogram: input });
    const tensor = Array.isArray(out) ? out[0] : out;
    return tensor.arraySync();
  });

  const mean = averagePredictions(predRows);
  const top = topK(mean, labels, 5);
  return {
    discogsLabel: top[0]?.label ?? null,
    confidence: top[0]?.score ?? 0,
    topDiscogs: top,
  };
}

self.onmessage = async (event) => {
  try {
    const { mono, sampleRate } = event.data;
    if (!(mono instanceof Float32Array) || !sampleRate) {
      throw new Error("Invalid genre worker payload");
    }
    const result = await classify(mono, sampleRate);
    self.postMessage({ type: "result", ...result });
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : "Genre tagging failed",
    });
  }
};
