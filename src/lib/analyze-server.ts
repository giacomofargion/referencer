import decodeAac from "@audio/decode-aac";
import decodeMp3 from "@audio/decode-mp3";
import { Essentia, EssentiaWASM } from "essentia.js";

import type { FeatureVector } from "@/lib/types";

// Band edges must match FREQUENCY_BANDS in types.ts and the browser worker.
const BAND_EDGES = [20, 60, 250, 500, 2000, 4000, 8000, 20000];
const FRAME_SIZE = 4096;
const HOP_SIZE = 2048;
const TEMPO_SLICE_SECONDS = 30;

type EssentiaInstance = InstanceType<typeof Essentia>;

let essentiaSingleton: EssentiaInstance | null = null;

function getEssentia(): EssentiaInstance {
  if (!essentiaSingleton) {
    essentiaSingleton = new Essentia(EssentiaWASM);
  }
  return essentiaSingleton;
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

function computeBandEnergies(
  essentia: EssentiaInstance,
  mono: Float32Array,
  sampleRate: number,
): number[] {
  const nyquist = sampleRate / 2;
  const sums = new Array(BAND_EDGES.length - 1).fill(0);
  const frames = essentia.FrameGenerator(mono, FRAME_SIZE, HOP_SIZE);
  const frameCount = frames.size() as number;

  for (let i = 0; i < frameCount; i++) {
    const frame = frames.get(i);
    const windowed = essentia.Windowing(frame, true, FRAME_SIZE, "hann");
    const spectrum = essentia.Spectrum(windowed.frame, FRAME_SIZE);
    for (let b = 0; b < sums.length; b++) {
      const low = BAND_EDGES[b];
      const high = Math.min(BAND_EDGES[b + 1], nyquist);
      if (low >= nyquist) break;
      const band = essentia.EnergyBand(
        spectrum.spectrum,
        sampleRate,
        low,
        high,
      );
      sums[b] += band.energyBand as number;
    }
    windowed.frame.delete();
    spectrum.spectrum.delete();
  }
  frames.delete();

  const total = sums.reduce((acc: number, v: number) => acc + v, 0);
  if (total === 0) return sums;
  return sums.map((v: number) => v / total);
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

// Onset events per second (rhythmic density). Essentia's OnsetRate assumes
// 44.1 kHz internally, so rescale for other sample rates.
function computeOnsetRate(
  essentia: EssentiaInstance,
  mono: Float32Array,
  sampleRate: number,
): number {
  const sliceLength = Math.min(mono.length, TEMPO_SLICE_SECONDS * sampleRate);
  const start = Math.max(0, Math.floor((mono.length - sliceLength) / 2));
  const slice = mono.subarray(start, start + sliceLength);
  const sliceVector = essentia.arrayToVector(slice);
  const result = essentia.OnsetRate(sliceVector);
  sliceVector.delete();
  result.onsets.delete();
  return result.onsetRate * (sampleRate / 44100);
}

function computeTempo(
  essentia: EssentiaInstance,
  mono: Float32Array,
  sampleRate: number,
): number {
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
  return result.bpm as number;
}

function looksLikeMp3(bytes: Uint8Array): boolean {
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    return true;
  }
  return bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
}

function looksLikeMp4Family(bytes: Uint8Array): boolean {
  // ISO BMFF: size(4) + 'ftyp'(4) — iTunes previews are typically M4A/AAC.
  if (bytes.length < 8) return false;
  return (
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  );
}

/**
 * Decode MP3 clips and AAC/M4A iTunes previews to PCM via WASM codecs.
 * Avoids native `node-web-audio-api` (needs libasound — missing on Vercel).
 */
export async function decodeAudioBytes(
  bytes: ArrayBuffer,
): Promise<{ left: Float32Array; right: Float32Array; sampleRate: number }> {
  const view = new Uint8Array(bytes.slice(0));
  const decoded = looksLikeMp3(view)
    ? await decodeMp3(view)
    : looksLikeMp4Family(view)
      ? await decodeAac(view)
      : await decodeAac(view).catch(async () => decodeMp3(view));

  const channels = decoded.channelData;
  if (!channels?.length || !decoded.sampleRate) {
    throw new Error("Audio decode produced no PCM");
  }
  const left = channels[0];
  const right = channels.length > 1 ? channels[1] : channels[0];
  return {
    left: new Float32Array(left),
    right: new Float32Array(right),
    sampleRate: decoded.sampleRate,
  };
}

/** Extract the shared feature vector from decoded stereo channels. */
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
  const integratedLoudness = loudness.integratedLoudness as number;

  return {
    integratedLoudnessLufs: integratedLoudness,
    loudnessRangeDb: loudness.loudnessRange as number,
    frequencyBandEnergies: computeBandEnergies(essentia, mono, sampleRate),
    tempoBpm: computeTempo(essentia, mono, sampleRate),
    stereoWidth: computeStereoWidth(left, right),
    plrDb: Number.isFinite(peakDb) ? peakDb - integratedLoudness : 0,
    onsetRate: computeOnsetRate(essentia, mono, sampleRate),
  };
}

/**
 * Trim stereo channels to the loudest contiguous window. iTunes previews
 * often start at the intro, which misrepresents a track's mastered energy —
 * the loudest stretch (usually the drop/chorus) is the mastering-relevant part.
 */
function trimToLoudestWindow(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  windowSeconds: number,
): { left: Float32Array; right: Float32Array } {
  const windowLength = Math.floor(windowSeconds * sampleRate);
  if (left.length <= windowLength) return { left, right };

  // 1-second RMS scan, then pick the best contiguous window of blocks.
  const blockLength = sampleRate;
  const blockCount = Math.floor(left.length / blockLength);
  const blockEnergies = new Array<number>(blockCount);
  for (let b = 0; b < blockCount; b++) {
    let sum = 0;
    const offset = b * blockLength;
    for (let i = 0; i < blockLength; i++) {
      const l = left[offset + i];
      const r = right[offset + i];
      sum += l * l + r * r;
    }
    blockEnergies[b] = sum;
  }

  const blocksPerWindow = Math.max(1, Math.floor(windowSeconds));
  let windowSum = 0;
  for (let b = 0; b < Math.min(blocksPerWindow, blockCount); b++) {
    windowSum += blockEnergies[b];
  }
  let bestSum = windowSum;
  let bestStart = 0;
  for (let b = blocksPerWindow; b < blockCount; b++) {
    windowSum += blockEnergies[b] - blockEnergies[b - blocksPerWindow];
    if (windowSum > bestSum) {
      bestSum = windowSum;
      bestStart = b - blocksPerWindow + 1;
    }
  }

  const start = bestStart * blockLength;
  return {
    left: left.subarray(start, start + windowLength),
    right: right.subarray(start, start + windowLength),
  };
}

const PREVIEW_WINDOW_SECONDS = 20;

/** Fetch a remote preview URL and return its feature vector. */
export async function analyzePreviewUrl(
  previewUrl: string,
): Promise<FeatureVector> {
  const response = await fetch(previewUrl);
  if (!response.ok) {
    throw new Error(`Preview fetch failed (${response.status})`);
  }
  const bytes = await response.arrayBuffer();
  const { left, right, sampleRate } = await decodeAudioBytes(bytes);
  const trimmed = trimToLoudestWindow(
    left,
    right,
    sampleRate,
    PREVIEW_WINDOW_SECONDS,
  );
  return extractFeatures(trimmed.left, trimmed.right, sampleRate);
}
