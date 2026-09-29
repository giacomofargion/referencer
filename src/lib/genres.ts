/**
 * Genre helpers for Discogs → platform search → Essentia ranking.
 * Discogs labels look like `Electronic---Deep House`.
 *
 * Genre/style gate the shortlist; Essentia only ranks inside it.
 * Cross-genre loudness twins (same LUFS, wrong world) must not enter the pool.
 */

export const MATCH_GENRES = [
  "Electronic",
  "Rock",
  "Pop",
  "Hip-Hop",
  "R&B",
  "Jazz",
  "Folk",
  "Country",
  "Blues",
  "Classical",
] as const;

export type MatchGenre = (typeof MATCH_GENRES)[number];

/**
 * Tight neighborhood only — no Electronic↔Pop/Hip-Hop bleed.
 * Empty means “stay in this parent; rely on Discogs style for search.”
 */
const RELATED: Record<MatchGenre, MatchGenre[]> = {
  Electronic: [],
  Rock: ["Blues"],
  Pop: [],
  "Hip-Hop": ["R&B"],
  "R&B": ["Hip-Hop"],
  Jazz: ["Blues"],
  Folk: ["Country"],
  Country: ["Folk"],
  Blues: ["Rock", "Jazz"],
  Classical: [],
};

/** Platform genre strings that still count as the preferred MatchGenre. */
const GENRE_ALIASES: Record<MatchGenre, string[]> = {
  Electronic: [
    "electronic",
    "dance",
    "edm",
    "house",
    "techno",
    "trance",
    "dubstep",
    "drum & bass",
    "drum and bass",
    "dnb",
    "jungle",
    "breakbeat",
    "ambient",
    "electronica",
    "garage",
    "uk garage",
    "hardstyle",
    "synthwave",
    "industrial",
  ],
  Rock: ["rock", "metal", "punk", "alternative", "indie rock", "hard rock", "grunge"],
  Pop: ["pop", "dance-pop", "synth-pop", "k-pop", "teen pop"],
  "Hip-Hop": ["hip-hop", "hip hop", "rap", "trap", "grime"],
  "R&B": ["r&b", "rnb", "soul", "funk", "neo-soul", "contemporary r&b"],
  Jazz: ["jazz", "bebop", "swing", "fusion"],
  Folk: ["folk", "singer/songwriter", "americana", "acoustic"],
  Country: ["country", "bluegrass", "nashville"],
  Blues: ["blues"],
  Classical: ["classical", "orchestral", "opera", "soundtrack", "score"],
};

function parentToGenre(parent: string): MatchGenre | null {
  const p = parent.trim().toLowerCase();
  if (p === "blues") return "Blues";
  if (p === "classical") return "Classical";
  if (p === "electronic") return "Electronic";
  if (p.startsWith("folk")) return "Folk";
  if (p === "funk / soul") return "R&B";
  if (p === "hip hop") return "Hip-Hop";
  if (p === "jazz") return "Jazz";
  if (p === "pop") return "Pop";
  if (p === "rock") return "Rock";
  if (p === "reggae" || p === "latin") return "Pop";
  if (p === "stage & screen" || p === "brass & military") return "Classical";
  if (p === "children's") return "Pop";
  if (p === "non-music") return null;
  return null;
}

/** Map `Parent---Style` Discogs tag onto a coarse match genre. */
export function discogsLabelToGenre(label: string): MatchGenre | null {
  if (!label.includes("---")) return parentToGenre(label);
  const [parent, style] = label.split("---", 2);
  const styleL = style.trim().toLowerCase();
  const parentL = parent.trim().toLowerCase();

  if (parentL.startsWith("folk") && styleL.includes("country")) return "Country";
  if (parentL.startsWith("folk")) return "Folk";
  if (
    styleL.includes("drum n bass") ||
    styleL.includes("jungle") ||
    styleL.includes("breakbeat")
  ) {
    return "Electronic";
  }
  if (
    styleL.includes("r&b") ||
    styleL.includes("rhythm & blues") ||
    styleL.includes("soul")
  ) {
    return "R&B";
  }
  if (styleL.includes("hip hop") || styleL.includes("trap")) return "Hip-Hop";

  return parentToGenre(parent);
}

export function relatedGenres(genre: MatchGenre): MatchGenre[] {
  return RELATED[genre] ?? [];
}

export function isMatchGenre(value: string): value is MatchGenre {
  return (MATCH_GENRES as readonly string[]).includes(value);
}

/**
 * Deezer chart ids. Parent-genre words like "Rock" are song titles as often
 * as they are styles, so a text search returns "Rock & Roll" instead of rock.
 * Charts are actual tracks in that genre.
 */
export function deezerGenreId(genre: MatchGenre): number {
  switch (genre) {
    case "Electronic":
      return 113;
    case "Rock":
      return 152;
    case "Pop":
      return 132;
    case "Hip-Hop":
      return 116;
    case "R&B":
      return 165;
    case "Jazz":
      return 129;
    case "Folk":
      return 466;
    case "Country":
      return 84;
    case "Blues":
      return 153;
    case "Classical":
      return 98;
    default: {
      const exhaustive: never = genre;
      return exhaustive;
    }
  }
}

/** Discogs style segment, or null when the label is parent-only. */
export function discogsStyle(label: string | null | undefined): string | null {
  const raw = label?.trim();
  if (!raw?.includes("---")) return null;
  const style = raw.split("---", 2)[1]?.trim();
  return style || null;
}

/**
 * Cheap instrumentation hints from Discogs style/parent.
 * Used to enrich search queries (no second ML model required).
 */
export function instrumentsFromDiscogsLabel(
  label: string | null | undefined,
): string[] {
  const raw = label?.trim().toLowerCase() ?? "";
  const style = discogsStyle(label)?.toLowerCase() ?? raw;
  const hay = `${raw} ${style}`;

  if (
    /drum n bass|dnb|jungle|breakbeat|techno|house|trance|dubstep|garage|edm|ambient|synth|electro/.test(
      hay,
    )
  ) {
    return ["synth", "drums", "bass"];
  }
  if (/hip hop|trap|grime|rap/.test(hay)) {
    return ["drums", "vocals", "bass"];
  }
  if (/r&b|soul|funk|neo.?soul/.test(hay)) {
    return ["vocals", "keys", "drums"];
  }
  if (/metal|punk|rock|grunge|indie/.test(hay)) {
    return ["guitar", "drums", "bass"];
  }
  if (/jazz|bebop|swing/.test(hay)) {
    return ["piano", "drums", "bass"];
  }
  if (/classical|orchestr|opera|soundtrack/.test(hay)) {
    return ["orchestra", "piano"];
  }
  if (/country|bluegrass|folk|americana/.test(hay)) {
    return ["guitar", "vocals"];
  }
  if (/blues/.test(hay)) {
    return ["guitar", "vocals"];
  }
  if (/pop/.test(hay)) {
    return ["vocals", "synth"];
  }
  return [];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Match an alias/genre as a standalone token (not a substring of another word).
 * Prevents e.g. "garage"/"industrial"/"fusion"/"pop" hitting inside unrelated words.
 */
function textContainsToken(haystack: string, token: string): boolean {
  const needle = token.trim().toLowerCase();
  if (!needle) return false;
  const pattern = new RegExp(
    `(^|[^a-z0-9])${escapeRegExp(needle)}([^a-z0-9]|$)`,
    "i",
  );
  return pattern.test(haystack);
}

function textMatchesGenre(haystack: string, genre: MatchGenre): boolean {
  const lower = haystack.toLowerCase();
  if (!lower) return false;
  if (textContainsToken(lower, genre)) return true;
  for (const alias of GENRE_ALIASES[genre]) {
    if (textContainsToken(lower, alias)) return true;
  }
  return false;
}

/**
 * Hard gate: keep only candidates in the preferred genre neighborhood.
 * Empty/unknown platform genres are dropped — loudness alone must not admit them.
 */
export function isInGenreNeighborhood(
  preferred: MatchGenre,
  candidateGenre: string,
  discogsLabel?: string | null,
): boolean {
  const raw = candidateGenre.trim();
  if (!raw) return false;

  if (textMatchesGenre(raw, preferred)) return true;
  for (const related of relatedGenres(preferred)) {
    if (textMatchesGenre(raw, related)) return true;
  }

  // Style token in the platform genre string (e.g. iTunes "Deep House").
  const style = discogsStyle(discogsLabel);
  if (style && textContainsToken(raw, style)) return true;

  return false;
}

/**
 * Where a discovery query sits relative to the requested style.
 * Style hits stay closer than a parent-genre or related-genre search,
 * even when the platform later labels both tracks with a coarse genre.
 */
export type DiscoveryQueryKind =
  | "style"
  | "style-instrument"
  | "genre"
  | "related";

export interface DiscoveryQuery {
  query: string;
  kind: DiscoveryQueryKind;
}

/**
 * Text queries for Deezer / iTunes.
 * Prefer Discogs style; avoid related-parent spam when a style is known.
 */
export function searchQueriesForDiscovery(input: {
  genre: MatchGenre;
  discogsLabel?: string | null;
  instruments?: string[];
}): DiscoveryQuery[] {
  const queries: DiscoveryQuery[] = [];
  const style = discogsStyle(input.discogsLabel);
  const instruments = (input.instruments ?? []).filter(Boolean).slice(0, 2);

  if (style) {
    queries.push({ query: style, kind: "style" });
    for (const instrument of instruments) {
      queries.push({
        query: `${style} ${instrument}`,
        kind: "style-instrument",
      });
    }
    // Parent as last-resort breadth, not as a peer of the style.
    queries.push({ query: input.genre, kind: "genre" });
  } else {
    queries.push({ query: input.genre, kind: "genre" });
    for (const instrument of instruments) {
      queries.push({
        query: `${input.genre} ${instrument}`,
        kind: "style-instrument",
      });
    }
    for (const related of relatedGenres(input.genre).slice(0, 1)) {
      queries.push({ query: related, kind: "related" });
    }
  }

  const seen = new Set<string>();
  return queries.filter((entry) => {
    const key = entry.query.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 0 = this search was aimed at the requested style.
 * Higher = the track only showed up because the query got broader.
 */
export function queryCloseness(kind: DiscoveryQueryKind): number {
  switch (kind) {
    case "style":
      return 0;
    case "style-instrument":
      return 0.1;
    case "genre":
      return 0.5;
    case "related":
      return 0.6;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/**
 * 0 = platform genre names the Discogs style or the preferred parent.
 * Listeners treat genre as its own similarity axis (Siedenburg et al.),
 * so this stays large enough that a tone match cannot erase it.
 */
export function genreLabelAffinity(
  preferred: MatchGenre,
  candidateGenre: string,
  discogsLabel?: string | null,
): number {
  const raw = candidateGenre.trim();
  if (!raw) return 1;
  const lower = raw.toLowerCase();

  const style = discogsStyle(discogsLabel);
  if (style && textContainsToken(lower, style)) return 0;
  if (textContainsToken(lower, preferred)) return 0.2;

  for (const alias of GENRE_ALIASES[preferred]) {
    if (textContainsToken(lower, alias)) return 0.45;
  }
  for (const related of relatedGenres(preferred)) {
    if (textMatchesGenre(raw, related)) return 0.55;
  }
  return 1;
}

/**
 * Blend how the track was found with how it is labeled.
 * A Deep House search hit labeled "Dance" stays close.
 * A parent-genre search hit does not, even when its tone matches.
 */
export function combineGenreCloseness(
  kind: DiscoveryQueryKind,
  labelAffinity: number,
): number {
  const label = Math.min(1, Math.max(0, labelAffinity));
  return Math.min(1, 0.6 * queryCloseness(kind) + 0.4 * label);
}

/** Closest query wins when the same track is returned by several searches. */
export function closerQueryKind(
  current: DiscoveryQueryKind,
  next: DiscoveryQueryKind,
): DiscoveryQueryKind {
  return queryCloseness(next) < queryCloseness(current) ? next : current;
}

/** Best-effort parent genre for older sessions that did not store closeness. */
export function inferPreferredGenre(genres: string[]): MatchGenre | null {
  let best: MatchGenre | null = null;
  let bestCount = 0;
  for (const genre of MATCH_GENRES) {
    let count = 0;
    for (const candidate of genres) {
      if (textMatchesGenre(candidate, genre)) count += 1;
    }
    if (count > bestCount) {
      best = genre;
      bestCount = count;
    }
  }
  return best;
}
