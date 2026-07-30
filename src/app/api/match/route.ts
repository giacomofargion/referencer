import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { analyzePreviewUrl } from "@/lib/analyze-server";
import { debitForMatch, refundMatch } from "@/lib/credits";
import { sql } from "@/lib/db";
import { explainMatch } from "@/lib/explanations";
import { isFeatureVector } from "@/lib/feature-vector";
import { searchItunesSongs, type ItunesTrack } from "@/lib/itunes";
import { pickStrictItunesMatch } from "@/lib/itunes-match";
import { rankBySonicSimilarity } from "@/lib/matching";
import { filterHitsByDominantGenre } from "@/lib/mert-genre-filter";
import {
  discoverSimilarViaMert,
  isMertDiscoveryReady,
  isMertWorkerConfigured,
  type MertSimilarHit,
} from "@/lib/mert-worker";
import type { FeatureVector } from "@/lib/types";

export const maxDuration = 60;

/** Cap new Essentia analyses per request so we stay under maxDuration. */
const MAX_HYDRATIONS = 12;
/** Rank against at most this many analyzed refs. */
const MAX_POOL = 60;
/** Over-fetch ANN neighbors so genre filtering still leaves a solid pool. */
const MERT_ANN_LIMIT = 80;
const TOP_RESULTS = 8;

/** When true, keep MERT ANN order instead of Essentia metering re-rank (easy A/B). */
function skipEssentiaRerank(): boolean {
  const raw = process.env.MATCH_SKIP_ESSENTIA_RERANK?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

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
  feature_vector: FeatureVector;
}

async function parseMatchRequest(request: Request): Promise<{
  uploadId: string;
  audio: ArrayBuffer | null;
  audioContentType: string | null;
}> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return { uploadId: "", audio: null, audioContentType: null };
  }

  const form = await request.formData();
  const uploadId = String(form.get("uploadId") ?? "").trim();
  const file = form.get("audio");
  let audio: ArrayBuffer | null = null;
  let audioContentType: string | null = null;
  if (file instanceof File && file.size > 0) {
    audio = await file.arrayBuffer();
    audioContentType = file.type || null;
  }

  return { uploadId, audio, audioContentType };
}

/**
 * Match a client upload against commercial references.
 * Primary: MERT ANN in the embed worker (R2/local catalog) → iTunes hydrate → Essentia re-rank.
 * Fallback: existing Essentia-analyzed reference_tracks when the worker/catalog is down.
 */
export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { uploadId, audio, audioContentType } = await parseMatchRequest(request);
  if (!uploadId) {
    return NextResponse.json({ error: "uploadId required" }, { status: 400 });
  }
  if (!audio) {
    return NextResponse.json(
      { error: "Audio clip missing — try analyzing the track again" },
      { status: 400 },
    );
  }

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
  const clientFeatures = upload.feature_vector as FeatureVector | null;

  if (!isFeatureVector(clientFeatures)) {
    return NextResponse.json(
      { error: "Upload has not been analyzed yet" },
      { status: 400 },
    );
  }

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

  let pool: CachedReference[];
  let discoveryNote: string;
  /** MERT cosine distances keyed by iTunes id — used when skipping Essentia re-rank. */
  let mertDistanceByItunesId = new Map<number, number>();
  let usedMert = false;

  try {
    const useMert =
      isMertWorkerConfigured() && (await isMertDiscoveryReady());

    if (useMert) {
      usedMert = true;
      const discovery = await discoverSimilarViaMert({
        audio,
        contentType: audioContentType,
        limit: MERT_ANN_LIMIT,
      });
      // Worker already genre-filters via Discogs-EffNet when available. Neighbor
      // vote remains as a soft fallback if the classifier was unavailable.
      const mertHits = discovery.hits;
      const genreFiltered = discovery.predictedGenre
        ? mertHits
        : filterHitsByDominantGenre(mertHits);
      const hydrated = await hydrateMertResults(genreFiltered);
      mertDistanceByItunesId = new Map(
        hydrated.map((h) => [h.itunesTrackId, h.mertDistance]),
      );
      const byItunesId = new Map(
        (
          await loadReferencesByTrackIds(
            new Set(hydrated.map((h) => h.itunesTrackId)),
          )
        ).map((row) => [row.itunes_track_id, row]),
      );
      // Preserve ANN order (DB ANY() does not).
      pool = hydrated
        .map((h) => byItunesId.get(h.itunesTrackId))
        .filter((row): row is CachedReference => Boolean(row));

      const genreLabel =
        discovery.predictedGenre?.trim() ||
        genreFiltered[0]?.genre?.trim() ||
        mertHits[0]?.genre?.trim() ||
        "mixed";
      const genreSource = discovery.predictedGenre
        ? `Discogs→${genreLabel}`
        : `${genreLabel} neighbor vote`;
      const orderNote = skipEssentiaRerank()
        ? "MERT order (Essentia re-rank off)"
        : "re-ranked by your metering profile";
      discoveryNote = `MERT catalog neighbors (${genreFiltered.length} hits, ${genreSource}) — ${orderNote}.`;
    } else {
      pool = await loadRecentReferences(MAX_POOL);
      const reason = !isMertWorkerConfigured()
        ? "MERT worker not configured"
        : "MERT catalog unavailable";
      discoveryNote = `Fallback cache (${reason}) — ranked ${pool.length} refs by metering.`;
    }
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
      discoveryNote:
        "No playable references found. Pack/upload the MERT catalog and start the embed worker.",
    });
  }

  const ranked =
    usedMert && skipEssentiaRerank()
      ? pool.slice(0, TOP_RESULTS).map((item) => ({
          item,
          features: item.feature_vector,
          distance: mertDistanceByItunesId.get(item.itunes_track_id) ?? 0,
        }))
      : rankBySonicSimilarity(
          clientFeatures,
          pool.map((row) => ({
            item: row,
            features: row.feature_vector,
          })),
        ).slice(0, TOP_RESULTS);

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

  return NextResponse.json({
    matches,
    clientFeatures,
    projectId,
    discoveryNote,
  });
}

async function hydrateMertResults(
  hits: MertSimilarHit[],
): Promise<Array<{ itunesTrackId: number; mertDistance: number }>> {
  const ordered: Array<{ itunesTrackId: number; mertDistance: number }> = [];
  const seen = new Set<number>();
  let analyzed = 0;

  for (const hit of hits) {
    if (analyzed >= MAX_HYDRATIONS && ordered.length >= TOP_RESULTS) break;

    const term = [hit.artist, hit.title].filter(Boolean).join(" ").trim();
    if (!term) continue;

    const itunesHits = await searchItunesSongs(term, 8).catch(() => []);
    const track = pickStrictItunesMatch(
      { title: hit.title, artist: hit.artist },
      itunesHits,
    );
    if (!track?.previewUrl) continue;
    if (seen.has(track.itunesTrackId)) continue;

    const existing = await sql`
      SELECT id, preview_start_sec FROM reference_tracks
      WHERE itunes_track_id = ${track.itunesTrackId} AND feature_vector IS NOT NULL
      LIMIT 1
    `;

    if (existing.length === 0 || existing[0].preview_start_sec == null) {
      if (analyzed >= MAX_HYDRATIONS) continue;
      try {
        const { features, loudestStartSec } = await analyzePreviewUrl(
          track.previewUrl,
        );
        await upsertReference(track, features, loudestStartSec);
        analyzed += 1;
      } catch {
        // Skip hydrate failures; keep going through the ANN list.
        continue;
      }
    }

    seen.add(track.itunesTrackId);
    ordered.push({
      itunesTrackId: track.itunesTrackId,
      mertDistance: hit.distance,
    });
  }

  return ordered;
}

async function upsertReference(
  track: ItunesTrack,
  features: FeatureVector,
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
      ${JSON.stringify(features)}::jsonb, now(),
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

async function loadRecentReferences(limit: number): Promise<CachedReference[]> {
  const rows = await sql`
    SELECT id, itunes_track_id, title, artist, album, artwork_url,
           genre, preview_url, preview_start_sec, feature_vector
    FROM reference_tracks
    WHERE feature_vector IS NOT NULL
    ORDER BY analyzed_at DESC NULLS LAST
    LIMIT ${limit}
  `;
  return mapCached(rows);
}

function mapCached(rows: Array<Record<string, unknown>>): CachedReference[] {
  return rows
    .filter((row) => isFeatureVector(row.feature_vector))
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
      feature_vector: row.feature_vector as FeatureVector,
    }));
}
