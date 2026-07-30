/**
 * Find the start (seconds) of the loudest contiguous window in a mono mix.
 * Used for Essentia preview analysis and A/B playback so intros don't dominate.
 */

export const DEFAULT_LOUDEST_WINDOW_SECONDS = 20;

/**
 * RMS energy over 1s blocks; pick the contiguous window with max energy.
 * Returns 0 when the buffer is shorter than the window.
 */
export function findLoudestWindowStartSeconds(
  mono: Float32Array,
  sampleRate: number,
  windowSeconds: number = DEFAULT_LOUDEST_WINDOW_SECONDS,
): number {
  const windowLength = Math.floor(windowSeconds * sampleRate);
  if (mono.length <= windowLength || sampleRate <= 0) return 0;

  const blockLength = Math.max(1, Math.floor(sampleRate));
  const blockCount = Math.floor(mono.length / blockLength);
  if (blockCount <= 0) return 0;

  const blockEnergies = new Array<number>(blockCount);
  for (let b = 0; b < blockCount; b++) {
    let sum = 0;
    const offset = b * blockLength;
    for (let i = 0; i < blockLength; i++) {
      const s = mono[offset + i];
      sum += s * s;
    }
    blockEnergies[b] = sum;
  }

  const blocksPerWindow = Math.max(1, Math.floor(windowSeconds));
  if (blocksPerWindow >= blockCount) return 0;

  let windowSum = 0;
  for (let b = 0; b < blocksPerWindow; b++) {
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

  return bestStart * (blockLength / sampleRate);
}

/** Downmix stereo buffers to mono for loudest-window detection. */
export function mixToMono(left: Float32Array, right: Float32Array): Float32Array {
  const n = Math.min(left.length, right.length);
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    mono[i] = (left[i] + right[i]) * 0.5;
  }
  return mono;
}
