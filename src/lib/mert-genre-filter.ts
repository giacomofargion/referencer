/**
 * Keep ANN hits that agree with the dominant catalog genre among the
 * nearest neighbors. Stops metering re-rank from promoting random
 * cross-genre tracks when the catalog neighborhood is coherent
 * (e.g. Electronic for DnB vs R&B for Stevie Wonder).
 */

import type { MertSimilarHit } from "@/lib/mert-worker";

function genreKey(hit: MertSimilarHit): string {
  return (hit.genre ?? "").trim() || "Unknown";
}

/**
 * Soft-filter: vote on genre using the closest hits (similarity-weighted),
 * then keep only that genre. Falls back to the original list if the vote
 * is weak or would leave too few candidates.
 */
export function filterHitsByDominantGenre(
  hits: MertSimilarHit[],
  options?: { seedSize?: number; minKeep?: number; minVoteShare?: number },
): MertSimilarHit[] {
  if (hits.length === 0) return hits;

  const seedSize = options?.seedSize ?? 15;
  const minKeep = options?.minKeep ?? 8;
  const minVoteShare = options?.minVoteShare ?? 0.35;

  const seed = hits.slice(0, Math.min(seedSize, hits.length));
  const weights = new Map<string, number>();
  let totalWeight = 0;

  for (const hit of seed) {
    const key = genreKey(hit);
    if (key === "Unknown") continue;
    // Closer neighbors (lower cosine distance) get more vote.
    const weight = Math.max(0.05, 1 - hit.distance);
    weights.set(key, (weights.get(key) ?? 0) + weight);
    totalWeight += weight;
  }

  if (totalWeight <= 0) return hits;

  let dominant = "";
  let dominantWeight = 0;
  for (const [key, weight] of weights) {
    if (weight > dominantWeight) {
      dominant = key;
      dominantWeight = weight;
    }
  }

  if (!dominant || dominantWeight / totalWeight < minVoteShare) {
    return hits;
  }

  const filtered = hits.filter((hit) => genreKey(hit) === dominant);
  if (filtered.length < Math.min(minKeep, hits.length)) {
    return hits;
  }

  return filtered;
}
