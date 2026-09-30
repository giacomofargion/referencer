/**
 * Style-first discovery + reference-cache writes shared by the live
 * /api/match route and the offline shelf-seeding script
 * (scripts/seed-shelf.ts). Keeping this in one place means "how a track
 * gets found" and "how it gets cached" can't drift between the two paths —
 * a seeded shelf is built the exact same way a live search would have
 * found the track, just without a 60s deadline.
 */
import { sql } from "@/lib/db";
import {
  searchDeezerGenreChart,
  searchDeezerTracks,
  type PlatformTrack,
} from "@/lib/deezer";
import { isStoredFingerprint } from "@/lib/feature-vector";
import {
  closerQueryKind,
  deezerGenreId,
  hydrationOrder,
  isBareStyleTitle,
  isInGenreNeighborhood,
  isMatchGenre,
  type DiscoveryQueryKind,
  type MatchGenre,
} from "@/lib/genres";
import { searchItunesSongs, type ItunesTrack } from "@/lib/itunes";
import type { StoredFingerprint } from "@/lib/types";

export interface DiscoveredTrack extends PlatformTrack {
  queryKind: DiscoveryQueryKind;
  /** Half-time / drum-and-bass query. Look these up before the genre chart. */
  lead: boolean;
}

export function isDrumAndBassQuery(query: string): boolean {
  return /drum\s*(?:and|n|&)?\s*bass|\bdnb\b|\bjungle\b/i.test(query);
}

/**
 * Style-first Deezer + iTunes discovery for one genre/style, deduped and
 * ordered style-first (see genres.ts hydrationOrder) with a lead boost for
 * half-time drum-and-bass queries.
 */
export async function collectPlatformCandidates(
  queries: Array<{ query: string; kind: DiscoveryQueryKind }>,
  genre: MatchGenre,
  discogsLabel: string | null,
  resultsPerQuery: number,
  poolLimit: number,
): Promise<DiscoveredTrack[]> {
  const byKey = new Map<string, DiscoveredTrack>();

  const consider = (track: DiscoveredTrack) => {
    const key = `${track.artist.toLowerCase()}|${track.title.toLowerCase()}`;
    const previous = byKey.get(key);
    if (!previous) {
      byKey.set(key, track);
      return;
    }
    // Keep the hit, but remember the closest query that found it.
    previous.queryKind = closerQueryKind(previous.queryKind, track.queryKind);
    previous.lead = previous.lead || track.lead;
  };

  const orderedQueries = [...queries].sort(
    (a, b) => hydrationOrder(a.kind) - hydrationOrder(b.kind),
  );

  for (const { query, kind } of orderedQueries) {
    // "Rock" as a text query matches song titles (Rock & Roll Band, …).
    // Parent and related genres come from the Deezer chart instead.
    const chartGenre = isMatchGenre(query) ? query : genre;
    const deezer =
      kind === "genre" || kind === "related"
        ? await searchDeezerGenreChart(
            deezerGenreId(chartGenre),
            resultsPerQuery,
          ).catch((error) => {
            console.warn("Deezer genre chart failed:", error);
            return [] as PlatformTrack[];
          })
        : await searchDeezerTracks(query, resultsPerQuery).catch((error) => {
            console.warn("Deezer search failed:", error);
            return [] as PlatformTrack[];
          });
    for (const track of deezer) {
      if (
        (kind === "style" || kind === "style-instrument") &&
        isBareStyleTitle(track.title, query)
      ) {
        continue;
      }
      // Deezer search hits have no genre — hydrate gates on the iTunes genre.
      consider({
        ...track,
        queryKind: kind,
        lead: isDrumAndBassQuery(query),
      });
    }

    if (kind === "genre" || kind === "related") continue;

    const itunes = await searchItunesSongs(query, resultsPerQuery).catch(
      (error) => {
        console.warn("iTunes search failed:", error);
        return [] as ItunesTrack[];
      },
    );
    for (const track of itunes) {
      if (isBareStyleTitle(track.title, query)) continue;
      const platformGenre = track.genre || genre;
      if (!isInGenreNeighborhood(genre, platformGenre, discogsLabel)) {
        continue;
      }
      consider({
        cacheKey: `itunes:${track.itunesTrackId}`,
        deezerId: null,
        itunesTrackId: track.itunesTrackId,
        title: track.title,
        artist: track.artist,
        album: track.album,
        artworkUrl: track.artworkUrl,
        genre: platformGenre,
        previewUrl: track.previewUrl,
        queryKind: kind,
        lead: isDrumAndBassQuery(query),
      });
    }
  }

  return [...byKey.values()]
    .sort((a, b) => {
      if (a.lead !== b.lead) return a.lead ? -1 : 1;
      return hydrationOrder(a.queryKind) - hydrationOrder(b.queryKind);
    })
    .slice(0, poolLimit);
}

export interface CacheStatusRow {
  previewStartSec: number | null;
  previewUrl: string;
  featureVector: unknown;
}

/** Batched cache-status lookup — one round trip instead of one per candidate. */
export async function loadCacheStatusByTrackIds(
  trackIds: Set<number>,
): Promise<Map<number, CacheStatusRow>> {
  const map = new Map<number, CacheStatusRow>();
  if (trackIds.size === 0) return map;
  const rows = await sql`
    SELECT itunes_track_id, preview_start_sec, preview_url, feature_vector
    FROM reference_tracks
    WHERE itunes_track_id = ANY(${[...trackIds]}) AND feature_vector IS NOT NULL
  `;
  for (const row of rows) {
    map.set(Number(row.itunes_track_id), {
      previewStartSec:
        row.preview_start_sec == null ? null : Number(row.preview_start_sec),
      previewUrl: String(row.preview_url ?? ""),
      featureVector: row.feature_vector,
    });
  }
  return map;
}

export function cacheRowNeedsReanalyze(
  cached: CacheStatusRow | undefined,
): boolean {
  return (
    !cached ||
    cached.previewStartSec == null ||
    !isStoredFingerprint(cached.featureVector) ||
    (typeof cached.featureVector === "object" &&
      cached.featureVector !== null &&
      (cached.featureVector as { version?: number }).version !== 2)
  );
}

export interface UpsertableTrack {
  itunesTrackId: number;
  title: string;
  artist: string;
  album: string | null;
  artworkUrl: string | null;
  genre: string;
  itunesGenre: string;
  previewUrl: string;
}

/** Insert or refresh one analyzed reference. Idempotent on itunes_track_id. */
export async function upsertReference(
  track: UpsertableTrack,
  fingerprint: StoredFingerprint,
  loudestStartSec: number,
): Promise<void> {
  await sql`
    INSERT INTO reference_tracks (
      itunes_track_id, title, artist, album, artwork_url,
      genre, itunes_genre, preview_url, feature_vector, analyzed_at,
      preview_start_sec
    )
    VALUES (
      ${track.itunesTrackId}, ${track.title}, ${track.artist},
      ${track.album}, ${track.artworkUrl}, ${track.genre},
      ${track.itunesGenre}, ${track.previewUrl},
      ${JSON.stringify(fingerprint)}::jsonb, now(),
      ${loudestStartSec}
    )
    ON CONFLICT (itunes_track_id) DO UPDATE SET
      feature_vector = EXCLUDED.feature_vector,
      analyzed_at = EXCLUDED.analyzed_at,
      preview_url = EXCLUDED.preview_url,
      itunes_genre = EXCLUDED.itunes_genre,
      genre = EXCLUDED.genre,
      artwork_url = COALESCE(EXCLUDED.artwork_url, reference_tracks.artwork_url),
      preview_start_sec = EXCLUDED.preview_start_sec
  `;
}
