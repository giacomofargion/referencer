import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { analyzePreviewUrl } from "@/lib/analyze-server";
import { debitForMatch, refundMatch } from "@/lib/credits";
import { sql } from "@/lib/db";
import { searchDeezerTracks, type PlatformTrack } from "@/lib/deezer";
import { explainMatch } from "@/lib/explanations";
import {
  getAggregateFeatures,
  isStoredFingerprint,
} from "@/lib/feature-vector";
import {
  genreDistancePenalty,
  instrumentsFromDiscogsLabel,
  isInGenreNeighborhood,
  isMatchGenre,
  searchQueriesForDiscovery,
  type MatchGenre,
} from "@/lib/genres";
import {
  isEphemeralPreviewUrl,
  lookupItunesTracks,
  searchItunesSongs,
  type ItunesTrack,
} from "@/lib/itunes";
import { pickStrictItunesMatch } from "@/lib/itunes-match";
import { getLearnedWeightMultipliers } from "@/lib/learned-weights";
import { rankBySonicSimilarity } from "@/lib/matching";
import { refreshEphemeralPreviewUrls } from "@/lib/refresh-previews";
import type { StoredFingerprint } from "@/lib/types";

export const maxDuration = 60;

/** Cap new Essentia analyses per request so we stay under maxDuration. */
const MAX_HYDRATIONS = 14;
/** Rank against at most this many analyzed refs. */
const MAX_POOL = 60;
const TOP_RESULTS = 8;
const QUERIES_PER_SOURCE = 3;
const RESULTS_PER_QUERY = 12;
/** Leave headroom after hydrate for ranking + match inserts. */
const HYDRATE_SAFETY_MARGIN_MS = 10_000;

interface CachedReference {
  id: string;
  itunes_track_id: number;
  title: string;
  artist: string;
  album: string | null;
  artwork_url: string | null;
  genre: string;
  preview_url: string;
  preview_start_sec: number | null;
  feature_vector: StoredFingerprint;
}

function parseInstrumentsField(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((v) => String(v).trim()).filter(Boolean).slice(0, 4);
  }
  const text = String(raw ?? "").trim();
  if (!text) return [];
  return text
    .split(/[,|]/)
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, 4);
}

async function parseMatchRequest(request: Request): Promise<{
  uploadId: string;
  genre: string;
  discogsLabel: string | null;
  instruments: string[];
}> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    return {
      uploadId: String(form.get("uploadId") ?? "").trim(),
      genre: String(form.get("genre") ?? "").trim(),
      discogsLabel: String(form.get("discogsLabel") ?? "").trim() || null,
      instruments: parseInstrumentsField(form.get("instruments")),
    };
  }

  const body = (await request.json().catch(() => null)) as {
    uploadId?: string;
    genre?: string;
    discogsLabel?: string | null;
    instruments?: string[] | string;
  } | null;
  return {
    uploadId: String(body?.uploadId ?? "").trim(),
    genre: String(body?.genre ?? "").trim(),
    discogsLabel: String(body?.discogsLabel ?? "").trim() || null,
    instruments: parseInstrumentsField(body?.instruments),
  };
}

/**
 * Discogs genre → Deezer/iTunes search → Essentia metering re-rank.
 * No hosted MERT worker required.
 */
export async function POST(request: Request) {
  const requestStartedAt = Date.now();
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const {
    uploadId,
    genre: genreRaw,
    discogsLabel,
    instruments: instrumentsRaw,
  } = await parseMatchRequest(request);
  if (!uploadId) {
    return NextResponse.json({ error: "uploadId required" }, { status: 400 });
  }
  if (!isMatchGenre(genreRaw)) {
    return NextResponse.json(
      { error: "Valid genre required (from Discogs tagging or manual pick)" },
      { status: 400 },
    );
  }
  const genre: MatchGenre = genreRaw;
  const instruments =
    instrumentsRaw.length > 0
      ? instrumentsRaw
      : instrumentsFromDiscogsLabel(discogsLabel);

  const uploads = await sql`
    SELECT id, title, feature_vector, project_id
    FROM client_uploads
    WHERE id = ${uploadId} AND clerk_user_id = ${userId}
    LIMIT 1
  `;
  if (uploads.length === 0) {
    return NextResponse.json({ error: "Upload not found" }, { status: 404 });
  }

  const upload = uploads[0];
  const projectId = (upload.project_id as string | null) ?? null;
  const clientFingerprint = upload.feature_vector as StoredFingerprint | null;

  if (!isStoredFingerprint(clientFingerprint)) {
    return NextResponse.json(
      { error: "Upload has not been analyzed yet" },
      { status: 400 },
    );
  }
  const clientFeatures = getAggregateFeatures(clientFingerprint);

  const balanceAfterDebit = await debitForMatch(userId, uploadId);
  if (balanceAfterDebit === null) {
    return NextResponse.json(
      {
        error: "You’re out of credits — buy more to run another search",
        code: "INSUFFICIENT_CREDITS",
        balance: 0,
      },
      { status: 402 },
    );
  }

  let pool: CachedReference[] = [];
  let discoveryNote: string;

  try {
    const queries = searchQueriesForDiscovery({
      genre,
      discogsLabel,
      instruments,
    }).slice(0, QUERIES_PER_SOURCE);

    const platformHits = await collectPlatformCandidates(
      queries,
      genre,
      discogsLabel,
    );
    const hydrated = await hydratePlatformTracks(
      platformHits,
      genre,
      discogsLabel,
      requestStartedAt,
    );
    const byId = new Map(
      (
        await loadReferencesByTrackIds(
          new Set(hydrated.map((h) => h.itunesTrackId)),
        )
      ).map((row) => [row.itunes_track_id, row]),
    );
    pool = hydrated
      .map((h) => byId.get(h.itunesTrackId))
      .filter((row): row is CachedReference => Boolean(row))
      .filter((row) =>
        isInGenreNeighborhood(genre, row.genre, discogsLabel),
      );

    // If platform hydrate was thin, top up from same-genre cache (analyze cache only).
    if (pool.length < 8) {
      const cached = await loadGenreCachedReferences(genre, MAX_POOL);
      const seen = new Set(pool.map((p) => p.itunes_track_id));
      for (const row of cached) {
        if (seen.has(row.itunes_track_id)) continue;
        if (!isInGenreNeighborhood(genre, row.genre, discogsLabel)) continue;
        pool.push(row);
        seen.add(row.itunes_track_id);
        if (pool.length >= MAX_POOL) break;
      }
    }

    const styleNote = discogsLabel?.includes("---")
      ? discogsLabel.split("---", 2)[1]?.trim()
      : null;
    const instrumentNote =
      instruments.length > 0 ? ` · ${instruments.slice(0, 2).join("/")}` : "";
    discoveryNote = styleNote
      ? `Discogs “${styleNote}”${instrumentNote} → gated Deezer/iTunes → Essentia (${pool.length} candidates).`
      : `Discogs ${genre}${instrumentNote} → gated Deezer/iTunes → Essentia (${pool.length} candidates).`;
  } catch (error) {
    console.error("Discovery failed:", error);
    await refundMatch(userId, uploadId).catch((refundError) => {
      console.error("Credit refund failed after discovery error:", refundError);
    });
    return NextResponse.json(
      { error: "Similarity search failed — please try again in a moment" },
      { status: 502 },
    );
  }

  if (pool.length === 0) {
    return NextResponse.json({
      matches: [],
      clientFeatures,
      creditsRemaining: balanceAfterDebit,
      discoveryNote:
        "No playable references found for this genre — try again in a moment.",
    });
  }

  const weightMultipliers = await getLearnedWeightMultipliers();
  const ranked = rankBySonicSimilarity(
    clientFingerprint,
    pool.map((row) => ({
      item: row,
      features: row.feature_vector,
    })),
    "balanced",
    weightMultipliers,
  )
    .map((hit) => ({
      ...hit,
      distance:
        hit.distance +
        genreDistancePenalty(genre, hit.item.genre, discogsLabel),
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, TOP_RESULTS);

  await sql`DELETE FROM matches WHERE client_upload_id = ${uploadId}`;

  let savedIds = new Set<string>();
  if (projectId) {
    const savedRows = await sql`
      SELECT reference_track_id
      FROM saved_references
      WHERE project_id = ${projectId}
    `;
    savedIds = new Set(
      savedRows.map((row) => row.reference_track_id as string),
    );
  }

  const matches = [];
  for (const hit of ranked) {
    const explanation = explainMatch(clientFeatures, hit.features);
    await sql`
      INSERT INTO matches (
        clerk_user_id, client_upload_id, reference_track_id,
        distance_score, explanation_text
      )
      VALUES (
        ${userId}, ${uploadId}, ${hit.item.id},
        ${hit.distance}, ${explanation}
      )
    `;
    matches.push({
      id: hit.item.id,
      itunesTrackId: hit.item.itunes_track_id,
      title: hit.item.title,
      artist: hit.item.artist,
      album: hit.item.album,
      artworkUrl: hit.item.artwork_url,
      genre: hit.item.genre,
      previewUrl: hit.item.preview_url,
      previewStartSec: hit.item.preview_start_sec,
      distanceScore: hit.distance,
      explanation,
      featureVector: hit.features,
      saved: savedIds.has(hit.item.id),
    });
  }

  // Final pass: replace any remaining Deezer CDN URLs before the client plays them.
  await refreshEphemeralPreviewUrls(matches);

  return NextResponse.json({
    matches,
    clientFeatures,
    projectId,
    discoveryNote,
    creditsRemaining: balanceAfterDebit,
  });
}

async function collectPlatformCandidates(
  queries: string[],
  genre: MatchGenre,
  discogsLabel: string | null,
): Promise<PlatformTrack[]> {
  const merged: PlatformTrack[] = [];
  const seen = new Set<string>();

  for (const query of queries) {
    const deezer = await searchDeezerTracks(query, RESULTS_PER_QUERY).catch(
      (error) => {
        console.warn("Deezer search failed:", error);
        return [] as PlatformTrack[];
      },
    );
    for (const track of deezer) {
      const key = `${track.artist.toLowerCase()}|${track.title.toLowerCase()}`;
      if (seen.has(key)) continue;
      // Deezer stamps the requested genre as a placeholder — treat as unknown
      // and let hydratePlatformTracks gate on the real iTunes genre.
      seen.add(key);
      merged.push(track);
    }

    const itunes = await searchItunesSongs(query, RESULTS_PER_QUERY).catch(
      (error) => {
        console.warn("iTunes search failed:", error);
        return [] as ItunesTrack[];
      },
    );
    for (const track of itunes) {
      const key = `${track.artist.toLowerCase()}|${track.title.toLowerCase()}`;
      if (seen.has(key)) continue;
      const platformGenre = track.genre || genre;
      if (!isInGenreNeighborhood(genre, platformGenre, discogsLabel)) {
        continue;
      }
      seen.add(key);
      merged.push({
        cacheKey: `itunes:${track.itunesTrackId}`,
        deezerId: null,
        itunesTrackId: track.itunesTrackId,
        title: track.title,
        artist: track.artist,
        album: track.album,
        artworkUrl: track.artworkUrl,
        genre: platformGenre,
        previewUrl: track.previewUrl,
      });
    }
  }

  return merged.slice(0, MAX_POOL);
}

/**
 * Resolve to iTunes ids for the existing reference_tracks cache key, analyze
 * previews (Deezer or iTunes URL), upsert features.
 * Stops early when the request deadline is reached so ranking still has budget.
 */
async function hydratePlatformTracks(
  hits: PlatformTrack[],
  fallbackGenre: MatchGenre,
  discogsLabel: string | null,
  requestStartedAt: number,
): Promise<Array<{ itunesTrackId: number }>> {
  const ordered: Array<{ itunesTrackId: number }> = [];
  const seen = new Set<number>();
  let analyzed = 0;
  const deadlineAt =
    requestStartedAt + maxDuration * 1000 - HYDRATE_SAFETY_MARGIN_MS;

  const pastDeadline = () => Date.now() >= deadlineAt;

  for (const hit of hits) {
    if (pastDeadline()) break;
    if (analyzed >= MAX_HYDRATIONS && ordered.length >= TOP_RESULTS) break;

    let itunesId = hit.itunesTrackId;
    let previewUrl = hit.previewUrl;
    let title = hit.title;
    let artist = hit.artist;
    let album = hit.album;
    let artworkUrl = hit.artworkUrl;
    let genre = hit.genre || fallbackGenre;
    let itunesGenre = hit.genre || fallbackGenre;

    if (itunesId == null) {
      if (pastDeadline()) break;
      const term = [hit.artist, hit.title].filter(Boolean).join(" ").trim();
      if (!term) continue;
      const itunesHits = await searchItunesSongs(term, 8).catch(() => []);
      const matched = pickStrictItunesMatch(
        { title: hit.title, artist: hit.artist },
        itunesHits,
      );
      if (matched) {
        itunesId = matched.itunesTrackId;
        // Prefer stable iTunes previews — Deezer CDN URLs expire (~15 min).
        previewUrl = matched.previewUrl || hit.previewUrl;
        title = matched.title;
        artist = matched.artist;
        album = matched.album ?? album;
        artworkUrl = matched.artworkUrl ?? artworkUrl;
        genre = matched.genre || genre;
        itunesGenre = matched.itunesGenre || itunesGenre;
      } else {
        // No iTunes id → skip (schema requires itunes_track_id).
        continue;
      }
    }

    if (seen.has(itunesId)) continue;
    // Drop loudness twins from the wrong neighborhood before spending analyze budget.
    if (!isInGenreNeighborhood(fallbackGenre, genre, discogsLabel)) {
      continue;
    }

    if (pastDeadline()) break;

    const existing = await sql`
      SELECT id, preview_start_sec, preview_url, feature_vector FROM reference_tracks
      WHERE itunes_track_id = ${itunesId} AND feature_vector IS NOT NULL
      LIMIT 1
    `;

    const cached = existing[0];
    const needsReanalyze =
      !cached ||
      cached.preview_start_sec == null ||
      !isStoredFingerprint(cached.feature_vector) ||
      (typeof cached.feature_vector === "object" &&
        cached.feature_vector !== null &&
        (cached.feature_vector as { version?: number }).version !== 2);

    if (needsReanalyze) {
      if (analyzed >= MAX_HYDRATIONS) continue;
      if (pastDeadline()) break;
      try {
        // Prefer a stable URL for analysis when the hit only has Deezer.
        let analyzeUrl = previewUrl;
        if (isEphemeralPreviewUrl(analyzeUrl)) {
          const fresh = await lookupItunesTracks([itunesId]);
          const itunesPreview = fresh.get(itunesId)?.previewUrl;
          if (itunesPreview) analyzeUrl = itunesPreview;
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
            genre,
            itunesGenre,
            previewUrl: analyzeUrl,
          },
          fingerprint,
          loudestStartSec,
        );
        analyzed += 1;
      } catch {
        continue;
      }
    } else {
      // Cache hit: swap ephemeral Deezer URLs for stable iTunes ones (no re-analyze).
      const storedUrl = String(cached.preview_url ?? "");
      if (isEphemeralPreviewUrl(storedUrl)) {
        const stable =
          (!isEphemeralPreviewUrl(previewUrl) ? previewUrl : null) ||
          (await lookupItunesTracks([itunesId])).get(itunesId)?.previewUrl;
        if (stable && stable !== storedUrl) {
          await sql`
            UPDATE reference_tracks
            SET preview_url = ${stable}
            WHERE itunes_track_id = ${itunesId}
          `;
        }
      }
    }

    seen.add(itunesId);
    ordered.push({ itunesTrackId: itunesId });
  }

  return ordered;
}

async function upsertReference(
  track: {
    itunesTrackId: number;
    title: string;
    artist: string;
    album: string | null;
    artworkUrl: string | null;
    genre: string;
    itunesGenre: string;
    previewUrl: string;
  },
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

async function loadReferencesByTrackIds(
  trackIds: Set<number>,
): Promise<CachedReference[]> {
  if (trackIds.size === 0) return [];

  const rows = await sql`
    SELECT id, itunes_track_id, title, artist, album, artwork_url,
           genre, preview_url, preview_start_sec, feature_vector
    FROM reference_tracks
    WHERE itunes_track_id = ANY(${[...trackIds]}) AND feature_vector IS NOT NULL
  `;

  return mapCached(rows);
}

async function loadGenreCachedReferences(
  genre: MatchGenre,
  limit: number,
): Promise<CachedReference[]> {
  const rows = await sql`
    SELECT id, itunes_track_id, title, artist, album, artwork_url,
           genre, preview_url, preview_start_sec, feature_vector
    FROM reference_tracks
    WHERE feature_vector IS NOT NULL
      AND (
        genre ILIKE ${"%" + genre + "%"}
        OR itunes_genre ILIKE ${"%" + genre + "%"}
      )
    ORDER BY analyzed_at DESC NULLS LAST
    LIMIT ${limit}
  `;
  return mapCached(rows);
}

function mapCached(rows: Array<Record<string, unknown>>): CachedReference[] {
  return rows
    .filter((row) => isStoredFingerprint(row.feature_vector))
    .map((row) => ({
      id: row.id as string,
      itunes_track_id: Number(row.itunes_track_id),
      title: row.title as string,
      artist: row.artist as string,
      album: (row.album as string | null) ?? null,
      artwork_url: (row.artwork_url as string | null) ?? null,
      genre: row.genre as string,
      preview_url: row.preview_url as string,
      preview_start_sec:
        row.preview_start_sec == null ? null : Number(row.preview_start_sec),
      feature_vector: row.feature_vector as StoredFingerprint,
    }));
}
