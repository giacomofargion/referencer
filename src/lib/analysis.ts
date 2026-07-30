import type { FeatureFingerprint } from "@/lib/types";

/**
 * Decodes an audio file with the Web Audio API and analyzes it in the
 * Essentia worker. Returns a v2 multi-window fingerprint.
 */
export async function analyzeAudioFile(
  file: File,
): Promise<FeatureFingerprint> {
  const audioContext = new AudioContext();
  try {
    const audioBuffer = await audioContext.decodeAudioData(
      await file.arrayBuffer(),
    );

    const left = audioBuffer.getChannelData(0);
    const right =
      audioBuffer.numberOfChannels > 1
        ? audioBuffer.getChannelData(1)
        : audioBuffer.getChannelData(0);

    return await runWorker(
      new Float32Array(left),
      new Float32Array(right),
      audioBuffer.sampleRate,
    );
  } finally {
    await audioContext.close();
  }
}

function runWorker(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
): Promise<FeatureFingerprint> {
  return new Promise((resolve, reject) => {
    const worker = new Worker("/workers/analysis-worker.js");

    worker.onmessage = (event) => {
      worker.terminate();
      if (event.data.type === "result") {
        resolve(event.data.fingerprint as FeatureFingerprint);
      } else {
        reject(new Error(event.data.message ?? "Audio analysis failed"));
      }
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || "Audio analysis worker crashed"));
    };

    worker.postMessage({ left, right, sampleRate }, [
      left.buffer,
      right.buffer,
    ]);
  });
}
