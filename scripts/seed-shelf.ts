/**
 * Build a real per-style shelf in `reference_tracks` instead of waiting for
 * it to accumulate as a side effect of past user searches. Uses the exact
 * same discovery + analysis + upsert code as the live /api/match route
 * (src/lib/discovery.ts, src/lib/analyze-server.ts) — just with no 60s
 * request deadline and a much bigger per-query result count, so a style
 * that's never been searched live still gets a real shelf.
 *
 * Usage:
 *   npx tsx scripts/seed-shelf.ts --genre Electronic --style "Drum n Bass" --target 80
 *   npx tsx scripts/seed-shelf.ts --genre Electronic --style "Deep House" --instruments synth,drums,bass
 *   npx tsx scripts/seed-shelf.ts                       # runs the built-in default style list
 *   npx tsx scripts/seed-shelf.ts --list                # prints the built-in style list and exits
 *
 * Idempotent: re-running tops a style back up to --target without
 * duplicating rows (upsertReference is keyed on itunes_track_id).
 * Respects the same iTunes ~20 req/min throttle as the live path (shared
 * module-level queue in src/lib/itunes.ts) — a full run is network-bound,
 * not CPU-bound, and can safely run for a long time in the background.
 */
import { loadEnvConfig } from "@next/env";
import { CURATED_ARTISTS } from "./curated-artists";
// Type-only — erased at compile time, so safe to import before env loads.
import type { MatchGenre } from "../src/lib/genres";

loadEnvConfig(process.cwd());

// Everything below is imported AFTER env is loaded, since src/lib/db.ts
// reads process.env.DATABASE_URL at module-evaluation time.
async function main() {
  const { analyzePreviewUrl } = await import("../src/lib/analyze-server");
  const {
    cacheRowNeedsReanalyze,
    collectPlatformCandidates,
    loadCacheStatusByTrackIds,
    upsertReference,
  } = await import("../src/lib/discovery");
  const { isEphemeralPreviewUrl, lookupItunesTracks, searchItunesSongs } =
    await import("../src/lib/itunes");
  const { pickStrictItunesMatch } = await import("../src/lib/itunes-match");
  const {
    genreLabelAffinity,
    instrumentsFromDiscogsLabel,
    isInGenreNeighborhood,
    isMatchGenre,
    searchQueriesForDiscovery,
  } = await import("../src/lib/genres");
  const { sql } = await import("../src/lib/db");

  interface StyleTarget {
    genre: MatchGenre;
    style?: string;
    target: number;
  }

  // Styles we actually care about first — the electronic sub-styles the
  // Deezer chart (one coarse "Dance" bucket) can never reach on its own,
  // and that reference_tracks currently has ~zero rows for.
  const DEFAULT_STYLES: StyleTarget[] = [
    { genre: "Electronic", style: "Drum n Bass", target: 80 },
    { genre: "Electronic", style: "Deep House", target: 80 },
    { genre: "Electronic", style: "Techno", target: 80 },
    { genre: "Electronic", style: "Dubstep", target: 60 },
    { genre: "Electronic", style: "Ambient", target: 60 },
  ];

  const RESULTS_PER_QUERY = 50;
  const POOL_LIMIT = 300;
  const MAX_RESOLVE_ATTEMPTS_PER_STYLE = 400;

  function parseArgs(argv: string[]): {
    styles: StyleTarget[];
    list: boolean;
  } {
    const get = (flag: string) => {
      const i = argv.indexOf(flag);
      return i >= 0 ? argv[i + 1] : undefined;
    };
    if (argv.includes("--list")) return { styles: [], list: true };

    const genreArg = get("--genre");
    if (!genreArg) return { styles: DEFAULT_STYLES, list: false };
    if (!isMatchGenre(genreArg)) {
      throw new Error(
        `--genre must be one of the MATCH_GENRES (got "${genreArg}")`,
      );
    }
    const style = get("--style");
    const target = Number(get("--target") ?? 80);
    return {
      styles: [{ genre: genreArg, style, target }],
      list: false,
    };
  }

  const { styles, list } = parseArgs(process.argv.slice(2));

  if (list) {
    console.log("Default style list:");
    for (const s of DEFAULT_STYLES) {
      console.log(`  ${s.genre}${s.style ? `---${s.style}` : ""} (target ${s.target})`);
    }
    return;
  }

  let totalWritten = 0;
  let totalSkippedExisting = 0;

  for (const { genre, style, target } of styles) {
    const discogsLabel = style ? `${genre}---${style}` : null;
    const label = discogsLabel ?? genre;
    console.log(`\n=== ${label} (target ${target}) ===`);

    const existingCount = await countExistingInStyle(genre, discogsLabel);
    console.log(`  already in catalog: ${existingCount}`);
    if (existingCount >= target) {
      console.log("  target already met, skipping discovery");
      continue;
    }

    const curatedArtists = discogsLabel ? CURATED_ARTISTS[discogsLabel] ?? [] : [];
    const queries = [
      // Curated names first — first crack at the shelf, ahead of keyword
      // search that would otherwise reward whoever uploaded the most tracks
      // with the style word in the title, not whoever's representative of it.
      ...curatedArtists.map((artist) => ({ query: artist, kind: "style" as const })),
      ...searchQueriesForDiscovery({
        genre,
        discogsLabel,
        instruments: instrumentsFromDiscogsLabel(discogsLabel),
      }),
    ];
    console.log(
      `  queries: ${queries.map((q) => `${q.kind}:"${q.query}"`).join(", ")}`,
    );

    const candidates = await collectPlatformCandidates(
      queries,
      genre,
      discogsLabel,
      RESULTS_PER_QUERY,
      POOL_LIMIT,
    );
    console.log(`  discovered ${candidates.length} raw candidates`);

    let written = 0;
    let resolveAttempts = 0;
    const knownIds = new Set(
      candidates
        .map((c) => c.itunesTrackId)
        .filter((id): id is number => id != null),
    );
    const cacheByTrackId = await loadCacheStatusByTrackIds(knownIds);

    for (const hit of candidates) {
      if (existingCount + written >= target) break;

      let itunesId = hit.itunesTrackId;
      let previewUrl = hit.previewUrl;
      let title = hit.title;
      let artist = hit.artist;
      let album = hit.album;
      let artworkUrl = hit.artworkUrl;
      let trackGenre = hit.genre || genre;
      let itunesGenre = hit.genre || genre;
      const wasKnownId = itunesId != null;
      let cached = itunesId != null ? cacheByTrackId.get(itunesId) : undefined;

      if (itunesId == null) {
        if (resolveAttempts >= MAX_RESOLVE_ATTEMPTS_PER_STYLE) continue;
        const term = [hit.artist, hit.title].filter(Boolean).join(" ").trim();
        if (!term) continue;
        resolveAttempts += 1;
        const itunesHits = await searchItunesSongs(term, 8).catch(() => []);
        const matched = pickStrictItunesMatch(
          { title: hit.title, artist: hit.artist },
          itunesHits,
        );
        if (!matched) continue;
        itunesId = matched.itunesTrackId;
        previewUrl = matched.previewUrl || hit.previewUrl;
        title = matched.title;
        artist = matched.artist;
        album = matched.album ?? album;
        artworkUrl = matched.artworkUrl ?? artworkUrl;
        trackGenre = matched.genre || trackGenre;
        itunesGenre = matched.itunesGenre || itunesGenre;
      }

      if (!isInGenreNeighborhood(genre, trackGenre, discogsLabel)) continue;

      if (!wasKnownId) {
        cached = (await loadCacheStatusByTrackIds(new Set([itunesId]))).get(
          itunesId,
        );
      }
      if (!cacheRowNeedsReanalyze(cached)) {
        totalSkippedExisting += 1;
        continue; // Already analyzed and cached — nothing to do.
      }

      try {
        let analyzeUrl = previewUrl;
        if (isEphemeralPreviewUrl(analyzeUrl)) {
          const fresh = await lookupItunesTracks([itunesId]);
          const stable = fresh.get(itunesId)?.previewUrl;
          if (stable) analyzeUrl = stable;
        }
        const { fingerprint, loudestStartSec } =
          await analyzePreviewUrl(analyzeUrl);
        await upsertReference(
          {
            itunesTrackId: itunesId,
            title,
            artist,
            album,
            artworkUrl,
            genre: trackGenre,
            itunesGenre,
            previewUrl: analyzeUrl,
          },
          fingerprint,
          loudestStartSec,
        );
        written += 1;
        totalWritten += 1;
        console.log(`  [${existingCount + written}/${target}] ${artist} — ${title}`);
      } catch (error) {
        console.warn(
          `  skip (analyze failed): ${artist} — ${title}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    console.log(
      `  done: wrote ${written} new, ended at ${existingCount + written}/${target}`,
    );
  }

  console.log(
    `\nTotal: ${totalWritten} tracks analyzed and written, ${totalSkippedExisting} already current.`,
  );

  /**
   * How many rows already genuinely represent this style — NOT the loose
   * isInGenreNeighborhood gate the live route uses for pool admission
   * (that one also counts every generic "Electronic"/"Dance"/"House" row,
   * which would make every electronic sub-style look fully seeded once any
   * one of them has ~100 rows). A style row needs affinity 0: the Discogs
   * style token actually appears in its platform genre label. With no
   * style (bare-parent seeding), the neighborhood gate IS the right count.
   */
  async function countExistingInStyle(
    genre: MatchGenre,
    discogsLabel: string | null,
  ): Promise<number> {
    const rows = await sql`
      SELECT genre FROM reference_tracks WHERE feature_vector IS NOT NULL
    `;
    let count = 0;
    for (const row of rows) {
      const rowGenre = String(row.genre ?? "");
      const matches = discogsLabel
        ? genreLabelAffinity(genre, rowGenre, discogsLabel) === 0
        : isInGenreNeighborhood(genre, rowGenre, discogsLabel);
      if (matches) count += 1;
    }
    return count;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
