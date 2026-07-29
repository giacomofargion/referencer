/**
 * Strict iTunes hydrate matching — avoid falling back to the first search
 * hit when artist/title don't actually line up with the catalog track.
 */

import type { ItunesTrack } from "@/lib/itunes";

export function normalizeMusicText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&\s*/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(value: string): Set<string> {
  return new Set(
    normalizeMusicText(value)
      .split(" ")
      .filter((t) => t.length > 1),
  );
}

/** Jaccard overlap on normalized tokens; 1 = identical token sets. */
function tokenOverlap(a: string, b: string): number {
  const sa = tokenSet(a);
  const sb = tokenSet(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) {
    if (sb.has(t)) inter += 1;
  }
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

function containsLoosely(haystack: string, needle: string): boolean {
  const h = normalizeMusicText(haystack);
  const n = normalizeMusicText(needle);
  if (!h || !n) return false;
  if (h === n) return true;
  if (h.includes(n) || n.includes(h)) return true;
  // First meaningful chunk of a long title (drop remix suffixes etc.)
  const short = n.split(" ").slice(0, 4).join(" ");
  return short.length >= 4 && h.includes(short);
}

/**
 * Pick the best iTunes result for a catalog hit, or null if nothing is
 * confident enough. Never returns a random first hit.
 */
export function pickStrictItunesMatch(
  catalog: { title: string; artist: string },
  itunesHits: ItunesTrack[],
): ItunesTrack | null {
  if (itunesHits.length === 0) return null;

  let best: ItunesTrack | null = null;
  let bestScore = 0;

  for (const track of itunesHits) {
    const titleOk =
      containsLoosely(track.title, catalog.title) ||
      tokenOverlap(track.title, catalog.title) >= 0.5;
    const artistOk =
      containsLoosely(track.artist, catalog.artist) ||
      tokenOverlap(track.artist, catalog.artist) >= 0.4;

    if (!titleOk || !artistOk) continue;

    const score =
      tokenOverlap(track.title, catalog.title) * 2 +
      tokenOverlap(track.artist, catalog.artist);

    if (score > bestScore) {
      bestScore = score;
      best = track;
    }
  }

  // Require a minimum combined score so "artist match + unrelated title" dies.
  if (!best || bestScore < 0.7) return null;
  return best;
}
