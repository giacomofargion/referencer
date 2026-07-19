import { Mp3Encoder } from "@breezystack/lamejs";

import { decodeAudioBytes } from "@/lib/analyze-server";

/** Cyanite API only accepts MP3 ≤ 15 min — a centered minute is plenty for similarity. */
const MAX_SECONDS = 60;
const SAMPLE_RATE = 44100;
const BITRATE_KBPS = 128;

/**
 * Convert uploaded audio bytes (wav/aiff/mp3/…) to an MP3 Buffer Cyanite accepts.
 * If the input is already MPEG and short enough, pass through as-is when content
 * type looks like mp3; otherwise re-encode from decoded PCM.
 */
export async function toCyaniteMp3(
  bytes: ArrayBuffer,
  contentType: string | null,
): Promise<Buffer> {
  const alreadyMp3 =
    contentType === "audio/mpeg" ||
    contentType === "audio/mp3" ||
    looksLikeMp3(bytes);

  if (alreadyMp3 && bytes.byteLength < 8_000_000) {
    return Buffer.from(bytes);
  }

  const { left, right, sampleRate } = await decodeAudioBytes(bytes);
  const mono = mixToMono(left, right);
  const resampled =
    sampleRate === SAMPLE_RATE ? mono : resampleLinear(mono, sampleRate, SAMPLE_RATE);
  const clipped = centerSlice(resampled, SAMPLE_RATE, MAX_SECONDS);
  return encodeMp3Mono(clipped, SAMPLE_RATE);
}

function looksLikeMp3(bytes: ArrayBuffer): boolean {
  const view = new Uint8Array(bytes);
  // ID3 tag or MPEG frame sync
  if (view.length >= 3 && view[0] === 0x49 && view[1] === 0x44 && view[2] === 0x33) {
    return true;
  }
  return view.length >= 2 && view[0] === 0xff && (view[1] & 0xe0) === 0xe0;
}

function mixToMono(left: Float32Array, right: Float32Array): Float32Array {
  const out = new Float32Array(left.length);
  for (let i = 0; i < left.length; i++) {
    out[i] = (left[i] + right[i]) * 0.5;
  }
  return out;
}

function centerSlice(
  samples: Float32Array,
  sampleRate: number,
  maxSeconds: number,
): Float32Array {
  const maxLen = Math.floor(maxSeconds * sampleRate);
  if (samples.length <= maxLen) return samples;
  const start = Math.floor((samples.length - maxLen) / 2);
  return samples.subarray(start, start + maxLen);
}

function resampleLinear(
  input: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLength = Math.floor(input.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const t = src - i0;
    out[i] = input[i0] * (1 - t) + input[i1] * t;
  }
  return out;
}

function encodeMp3Mono(samples: Float32Array, sampleRate: number): Buffer {
  const encoder = new Mp3Encoder(1, sampleRate, BITRATE_KBPS);
  const blockSize = 1152;
  const pcm = floatTo16BitPCM(samples);
  const parts: Uint8Array[] = [];

  for (let i = 0; i < pcm.length; i += blockSize) {
    const slice = pcm.subarray(i, Math.min(i + blockSize, pcm.length));
    const buf = encoder.encodeBuffer(slice);
    if (buf.length > 0) parts.push(buf);
  }
  const flush = encoder.flush();
  if (flush.length > 0) parts.push(flush);

  return Buffer.concat(parts.map((p) => Buffer.from(p)));
}

function floatTo16BitPCM(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}
