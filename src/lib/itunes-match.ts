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

/**
 * True when `longer` is `shorter` plus an explicit version/feature suffix
 * (e.g. "song title" ⊂ "song title radio edit"), not more core title words
 * ("stay" ⊄ "stay with me").
 */
function isPrefixWithVersionSuffix(longer: string, shorter: string): boolean {
  if (!longer.startsWith(shorter)) return false;
  if (longer.length === shorter.length) return true;
  // Require a token boundary so "stay" does not match inside "staying".
  if (longer[shorter.length] !== " ") return false;
  const rest = longer.slice(shorter.length).trim();
  if (!rest) return true;
  return /^(?:[\(\[]|[-–—:]\s*)?(?:feat\.?|ft\.?|featuring|remix|remaster(?:ed)?|live|edit|version|mix|radio|acoustic|deluxe|extended|instrumental|bonus|mono|stereo)\b/.test(
    rest,
  );
}

function containsLoosely(haystack: string, needle: string): boolean {
  const h = normalizeMusicText(haystack);
  const n = normalizeMusicText(needle);
  if (!h || !n) return false;
  if (h === n) return true;

  // Containment only for explicit version/feature suffixes — not weak prefixes.
  if (isPrefixWithVersionSuffix(h, n) || isPrefixWithVersionSuffix(n, h)) {
    return true;
  }

  // Strong token agreement (stricter than the pickStrictItunesMatch thresholds).
  if (tokenOverlap(h, n) >= 0.75) return true;

  // Long titles: compare a ≥3-token head via the same suffix rule only
  // (never bare includes — that reintroduces "Stay" ⊂ "Stay With Me").
  const tokens = n.split(" ").filter(Boolean);
  if (tokens.length >= 3) {
    const head = tokens.slice(0, 4).join(" ");
    if (isPrefixWithVersionSuffix(h, head) || isPrefixWithVersionSuffix(head, h)) {
      return true;
    }
  }

  return false;
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
