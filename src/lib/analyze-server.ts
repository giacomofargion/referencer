import decodeAac from "@audio/decode-aac";
import decodeMp3 from "@audio/decode-mp3";

import { extractFingerprint } from "@/lib/extract-features";
import type { FeatureFingerprint } from "@/lib/types";

function looksLikeMp3(bytes: Uint8Array): boolean {
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    return true;
  }
  return bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
}

function looksLikeMp4Family(bytes: Uint8Array): boolean {
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

export interface PreviewAnalysis {
  fingerprint: FeatureFingerprint;
  /** Seconds into the iTunes preview where the loudest window begins. */
  loudestStartSec: number;
}

/** Fetch a remote preview URL and return multi-window fingerprint + seek offset. */
export async function analyzePreviewUrl(
  previewUrl: string,
): Promise<PreviewAnalysis> {
  const response = await fetch(previewUrl);
  if (!response.ok) {
    throw new Error(`Preview fetch failed (${response.status})`);
  }
  const bytes = await response.arrayBuffer();
  const { left, right, sampleRate } = await decodeAudioBytes(bytes);
  const { fingerprint, loudestStartSec } = extractFingerprint(
    left,
    right,
    sampleRate,
  );
  return { fingerprint, loudestStartSec };
}
