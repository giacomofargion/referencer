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

function textMatchesGenre(haystack: string, genre: MatchGenre): boolean {
  const lower = haystack.toLowerCase();
  if (!lower) return false;
  if (lower.includes(genre.toLowerCase())) return true;
  for (const alias of GENRE_ALIASES[genre]) {
    if (lower.includes(alias)) return true;
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
  if (style && raw.toLowerCase().includes(style.toLowerCase())) return true;

  return false;
}

/**
 * Text queries for Deezer / iTunes.
 * Prefer Discogs style; avoid related-parent spam when a style is known.
 */
export function searchQueriesForDiscovery(input: {
  genre: MatchGenre;
  discogsLabel?: string | null;
  instruments?: string[];
}): string[] {
  const queries: string[] = [];
  const style = discogsStyle(input.discogsLabel);
  const instruments = (input.instruments ?? []).filter(Boolean).slice(0, 2);

  if (style) {
    queries.push(style);
    for (const instrument of instruments) {
      queries.push(`${style} ${instrument}`);
    }
    // Parent as last-resort breadth, not as a peer of the style.
    queries.push(input.genre);
  } else {
    queries.push(input.genre);
    for (const instrument of instruments) {
      queries.push(`${input.genre} ${instrument}`);
    }
    for (const related of relatedGenres(input.genre).slice(0, 1)) {
      queries.push(related);
    }
  }

  const seen = new Set<string>();
  return queries.filter((q) => {
    const key = q.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Soft ranking nudge inside an already hard-gated pool.
 * Prefer exact style / preferred genre over related aliases.
 */
export function genreDistancePenalty(
  preferred: MatchGenre,
  candidateGenre: string,
  discogsLabel?: string | null,
): number {
  const raw = candidateGenre.trim();
  if (!raw) return 0.15;
  const lower = raw.toLowerCase();

  const style = discogsStyle(discogsLabel);
  if (style && lower.includes(style.toLowerCase())) return 0;
  if (lower.includes(preferred.toLowerCase())) return 0;

  for (const alias of GENRE_ALIASES[preferred]) {
    if (lower.includes(alias)) return 0.01;
  }
  for (const related of relatedGenres(preferred)) {
    if (textMatchesGenre(raw, related)) return 0.04;
  }
  // Should rarely hit when hard gate is applied first.
  return 0.12;
}
