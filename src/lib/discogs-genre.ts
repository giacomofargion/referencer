/**
 * Client helper: Discogs-EffNet genre tagging in a Web Worker.
 */

export interface DiscogsGenreResult {
  discogsLabel: string | null;
  confidence: number;
  topDiscogs: Array<{ label: string; score: number }>;
}

/** Covers WASM init + TF.js load + inference; must not leave the UI hung. */
const WORKER_TIMEOUT_MS = 60_000;

/**
 * Downmix + classify with the browser Discogs-EffNet model.
 * Requires `public/models/discogs-genre/` (scripts/download-discogs-tfjs.sh).
 */
export async function classifyDiscogsGenre(file: File): Promise<DiscogsGenreResult> {
  const audioContext = new AudioContext();
  try {
    const buffer = await audioContext.decodeAudioData(await file.arrayBuffer());
    const left = buffer.getChannelData(0);
    const right =
      buffer.numberOfChannels > 1
        ? buffer.getChannelData(1)
        : buffer.getChannelData(0);
    const mono = new Float32Array(left.length);
    for (let i = 0; i < left.length; i++) {
      mono[i] = (left[i] + right[i]) * 0.5;
    }
    return await runGenreWorker(mono, buffer.sampleRate);
  } finally {
    await audioContext.close();
  }
}

function runGenreWorker(
  mono: Float32Array,
  sampleRate: number,
): Promise<DiscogsGenreResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker("/workers/genre-worker.js");
    let settled = false;

    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      action();
    };

    const timer = setTimeout(() => {
      settle(() =>
        reject(new Error("Discogs genre tagging timed out")),
      );
    }, WORKER_TIMEOUT_MS);

    worker.onmessage = (event) => {
      if (event.data.type === "result") {
        settle(() =>
          resolve({
            discogsLabel: event.data.discogsLabel ?? null,
            confidence: Number(event.data.confidence ?? 0),
            topDiscogs: Array.isArray(event.data.topDiscogs)
              ? event.data.topDiscogs
              : [],
          }),
        );
      } else {
        settle(() =>
          reject(new Error(event.data.message ?? "Genre tagging failed")),
        );
      }
    };
    worker.onerror = (event) => {
      settle(() =>
        reject(new Error(event.message || "Genre worker crashed")),
      );
    };
    worker.postMessage({ mono, sampleRate }, [mono.buffer]);
  });
}
