/* global EssentiaModel, tf */
/**
 * Discogs-EffNet genre tagging worker (classic worker).
 * Mel features via Essentia TensorflowInputMusiCNN; 400-class head via TF.js
 * GraphModel under /models/discogs-genre/ (see scripts/download-discogs-tfjs.sh).
 * TF.js UMD is self-hosted at /vendor/tf.min.js (see scripts/vendor-tfjs.sh).
 */

const RUNTIME_TIMEOUT_MS = 20_000;

// UMD wasm ends with `exports.EssentiaWASM = Module`; workers have no exports.
self.exports = {};

// Load TF.js before Essentia model helpers (they expect global `tf`).
importScripts(
  "/vendor/tf.min.js",
  "/essentia/essentia-wasm.umd.js",
  "/essentia/essentia.js-core.js",
  "/essentia/essentia.js-model.umd.js",
);

function getEssentiaWasm() {
  const wasm =
    (self.exports && self.exports.EssentiaWASM) || self.EssentiaWASM || null;
  if (!wasm) {
    throw new Error("Essentia WASM module missing after importScripts");
  }
  return wasm;
}

/**
 * Resolve once Emscripten has finished init (sync or async).
 * Prefer the exported EssentiaWASM instance over a pre-seeded Module hook.
 */
function waitForEssentiaRuntime(wasm) {
  if (wasm.calledRun) return Promise.resolve(wasm);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Essentia WASM initialization timed out"));
    }, RUNTIME_TIMEOUT_MS);

    const previous = wasm.onRuntimeInitialized;
    wasm.onRuntimeInitialized = () => {
      clearTimeout(timer);
      try {
        if (typeof previous === "function") previous();
      } finally {
        resolve(wasm);
      }
    };

    // Init finished between the calledRun check and the hook install.
    if (wasm.calledRun) {
      clearTimeout(timer);
      resolve(wasm);
    }
  });
}

const essentiaWasmReady = (() => {
  try {
    return waitForEssentiaRuntime(getEssentiaWasm());
  } catch (error) {
    return Promise.reject(error);
  }
})();

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
    labelsPromise = fetch(LABELS_URL).then((r) => {
      if (!r.ok) {
        throw new Error(
          "Discogs labels missing — run scripts/download-discogs-tfjs.sh",
        );
      }
      return r.json();
    });
  }
  return labelsPromise;
}

/**
 * Mirror EssentiaTFInputExtractor.downsampleAudioBuffer: OfflineAudioContext
 * resamples with the browser's anti-aliased converter.
 * Not available in dedicated workers today — callers fall back to software.
 */
async function downsampleWithOfflineContext(mono, sampleRate) {
  const OfflineCtx = self.OfflineAudioContext || self.webkitOfflineAudioContext;
  const durationSec = mono.length / sampleRate;
  const frames = Math.max(1, Math.ceil(durationSec * TARGET_SR));
  const ctx = new OfflineCtx(1, frames, TARGET_SR);
  const buffer = ctx.createBuffer(1, mono.length, sampleRate);
  buffer.copyToChannel(mono, 0);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.start(0);
  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0);
}

/**
 * Software anti-aliased resample when Web Audio is unavailable in-worker.
 * Downsample: average each input bucket (box low-pass) to kill aliases above
 * TARGET_SR/2. Upsample: linear interpolation.
 */
function downsampleSoftware(mono, sampleRate) {
  const ratio = sampleRate / TARGET_SR;
  const outLen = Math.max(1, Math.floor(mono.length / ratio));
  const out = new Float32Array(outLen);

  if (sampleRate > TARGET_SR) {
    let offset = 0;
    for (let i = 0; i < outLen; i++) {
      const next = Math.min(mono.length, Math.round((i + 1) * ratio));
      let sum = 0;
      for (let j = offset; j < next; j++) sum += mono[j];
      const count = next - offset;
      out[i] = count > 0 ? sum / count : 0;
      offset = next;
    }
    return out;
  }

  for (let i = 0; i < outLen; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(mono.length - 1, i0 + 1);
    const t = src - i0;
    out[i] = mono[i0] * (1 - t) + mono[i1] * t;
  }
  return out;
}

async function downsampleTo16k(mono, sampleRate) {
  if (sampleRate === TARGET_SR) return mono;

  // Dedicated workers lack OfflineAudioContext (same API Essentia vendors);
  // try it anyway for environments that expose it, else software anti-alias.
  const OfflineCtx = self.OfflineAudioContext || self.webkitOfflineAudioContext;
  if (typeof OfflineCtx === "function") {
    try {
      return await downsampleWithOfflineContext(mono, sampleRate);
    } catch {
      /* fall through */
    }
  }
  return downsampleSoftware(mono, sampleRate);
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
  const EssentiaWASM = await essentiaWasmReady;
  const [model, labels] = await Promise.all([loadModel(), loadLabels()]);

  const audio = centerSlice(await downsampleTo16k(mono, sampleRate), TARGET_SR);
  const extractor = new EssentiaModel.EssentiaTFInputExtractor(
    EssentiaWASM,
    "musicnn",
    false,
  );
  let features;
  try {
    // MusiCNN frame features need ≥512 samples (frame size); reject early.
    if (audio.length < 512) {
      throw new Error("Audio too short for Discogs genre model");
    }
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

  // Penultimate flatten is 512-d (before MatMul → 400 classes). Average across
  // mel patches and L2-normalize for a free embedding from the same forward pass.
  const EMBED_CANDIDATES = [
    "PartitionedCall/flatten/Reshape",
    "PartitionedCall/flatten/Reshape:0",
  ];
  const ACTIVATION_CANDIDATES = ["Identity", "Identity:0", "activations"];

  const { predRows, embedRows } = await tf.tidy(() => {
    const input = tf.tensor3d(patches); // [N, 128, 96]
    let activations = null;
    let embeddings = null;

    for (const embedName of EMBED_CANDIDATES) {
      for (const actName of ACTIVATION_CANDIDATES) {
        try {
          const outs = model.execute(
            { melspectrogram: input },
            [actName, embedName],
          );
          const list = Array.isArray(outs) ? outs : [outs];
          activations = list[0];
          embeddings = list[1] ?? null;
          break;
        } catch {
          /* try next name pair */
        }
      }
      if (activations) break;
    }

    if (!activations) {
      activations = model.execute({ melspectrogram: input });
      if (Array.isArray(activations)) activations = activations[0];
    }

    return {
      predRows: activations.arraySync(),
      embedRows: embeddings ? embeddings.arraySync() : null,
    };
  });

  const mean = averagePredictions(predRows);
  const top = topK(mean, labels, 5);

  let embedding = null;
  if (Array.isArray(embedRows) && embedRows.length > 0) {
    const meanEmbed = averagePredictions(embedRows);
    let norm = 0;
    for (let i = 0; i < meanEmbed.length; i++) norm += meanEmbed[i] * meanEmbed[i];
    norm = Math.sqrt(norm);
    if (norm > 1e-12) {
      embedding = Array.from(meanEmbed, (v) => v / norm);
    }
  }

  return {
    discogsLabel: top[0]?.label ?? null,
    confidence: top[0]?.score ?? 0,
    topDiscogs: top,
    embedding,
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
