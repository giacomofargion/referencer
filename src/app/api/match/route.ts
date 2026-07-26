import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { analyzePreviewUrl } from "@/lib/analyze-server";
import {
  discoverSimilarViaCyanite,
  isCyaniteConfigured,
} from "@/lib/cyanite";
import { debitForMatch, refundMatch } from "@/lib/credits";
import { sql } from "@/lib/db";
import { explainMatch } from "@/lib/explanations";
import { isFeatureVector } from "@/lib/feature-vector";
import { searchItunesSongs, type ItunesTrack } from "@/lib/itunes";
import { rankBySonicSimilarity } from "@/lib/matching";
import { resolveSpotifyTrackMeta } from "@/lib/spotify-oembed";
import { toCyaniteMp3 } from "@/lib/to-cyanite-mp3";
import type { FeatureVector } from "@/lib/types";

export const maxDuration = 60;

const MAX_CYANITE_HYDRATIONS = 8;
// Top 8 gives the client-side weight presets enough material to re-rank.
const TOP_RESULTS = 8;

interface CachedReference {
  id: string;
  itunes_track_id: number;
  title: string;
  artist: string;
  album: string | null;
  artwork_url: string | null;
  genre: string;
  preview_url: string;
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
  const uploadId = String(form.get("uploadId") ?? "");
  const file = form.get("audio");
  if (file instanceof File && file.size > 0) {
    return {
      uploadId,
      audio: await file.arrayBuffer(),
      audioContentType: file.type || null,
    };
  }
  return { uploadId, audio: null, audioContentType: null };
}

/**
 * Match a client upload against commercial references: upload the unreleased
 * mix to Cyanite, find sonically similar tracks on Spotify, hydrate them with
 * iTunes previews + Essentia features, then rank by the metering profile.
 */
export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isCyaniteConfigured()) {
    return NextResponse.json(
      { error: "Similarity search is not configured on this server" },
      { status: 503 },
    );
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
  const title = (upload.title as string | null) ?? null;
  const projectId = (upload.project_id as string | null) ?? null;
  const clientFeatures = upload.feature_vector as FeatureVector | null;

  if (!isFeatureVector(clientFeatures)) {
    return NextResponse.json(
      { error: "Upload has not been analyzed yet" },
      { status: 400 },
    );
  }

  // Spend before Cyanite so failed searches can refund without racing.
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

  let sessionTrackIds: Set<number>;
  try {
    const mp3 = await toCyaniteMp3(audio, audioContentType);
    const similar = await discoverSimilarViaCyanite({
      mp3,
      title: title ?? "client upload",
      externalId: uploadId,
    });
    sessionTrackIds = await hydrateCyaniteResults(similar);
  } catch (error) {
    console.error("Cyanite discovery failed:", error);
    await refundMatch(userId, uploadId).catch((refundError) => {
      console.error("Credit refund failed after Cyanite error:", refundError);
    });
    return NextResponse.json(
      { error: "Similarity search failed — please try again in a moment" },
      { status: 502 },
    );
  }

  const pool = await loadReferencesByTrackIds(sessionTrackIds);
  if (pool.length === 0) {
    return NextResponse.json({
      matches: [],
      clientFeatures,
      discoveryNote:
        "Similar tracks were found, but none had playable previews to analyze. Try again — results vary per run.",
    });
  }

  const ranked = rankBySonicSimilarity(
    clientFeatures,
    pool.map((row) => ({
      item: row,
      features: row.feature_vector,
    })),
  ).slice(0, TOP_RESULTS);

  // One current result set per upload — rematch replaces prior rows.
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
    discoveryNote: `Found ${pool.length} similar commercial tracks — ranked by your metering profile.`,
  });
}

/**
 * Resolve Cyanite Spotify IDs → artist/title (oEmbed) → iTunes preview →
 * Essentia features stored in the shared reference cache.
 */
async function hydrateCyaniteResults(
  similar: Array<{ spotifyId: string; title: string }>,
): Promise<Set<number>> {
  const sessionIds = new Set<number>();
  let analyzed = 0;

  for (const hit of similar) {
    if (analyzed >= MAX_CYANITE_HYDRATIONS) break;

    const meta =
      (await resolveSpotifyTrackMeta(hit.spotifyId)) ?? {
        title: hit.title,
        artist: "",
        artworkUrl: null as string | null,
      };
    const term = [meta.artist, meta.title].filter(Boolean).join(" ").trim();
    if (!term) continue;

    const itunesHits = await searchItunesSongs(term, 5).catch(() => []);
    const track =
      itunesHits.find(
        (t) =>
          (!meta.artist ||
            t.artist.toLowerCase().includes(meta.artist.toLowerCase().slice(0, 12))) &&
          t.title.toLowerCase().includes(meta.title.toLowerCase().slice(0, 12)),
      ) ?? itunesHits[0];
    if (!track?.previewUrl) continue;

    sessionIds.add(track.itunesTrackId);

    const existing = await sql`
      SELECT id FROM reference_tracks
      WHERE itunes_track_id = ${track.itunesTrackId} AND feature_vector IS NOT NULL
      LIMIT 1
    `;
    if (existing.length > 0) continue;

    try {
      const features = await analyzePreviewUrl(track.previewUrl);
      const stored: ItunesTrack = {
        ...track,
        artworkUrl: meta.artworkUrl ?? track.artworkUrl,
      };
      await upsertReference(stored, features);
      analyzed += 1;
    } catch {
      // Skip hydrate failures; keep going through the Cyanite list.
    }
  }

  return sessionIds;
}

async function upsertReference(
  track: ItunesTrack,
  features: FeatureVector,
): Promise<void> {
  await sql`
    INSERT INTO reference_tracks (
      itunes_track_id, title, artist, album, artwork_url,
      genre, itunes_genre, preview_url, feature_vector, analyzed_at
    )
    VALUES (
      ${track.itunesTrackId}, ${track.title}, ${track.artist},
      ${track.album}, ${track.artworkUrl}, ${track.genre},
      ${track.itunesGenre}, ${track.previewUrl},
      ${JSON.stringify(features)}::jsonb, now()
    )
    ON CONFLICT (itunes_track_id) DO UPDATE SET
      feature_vector = EXCLUDED.feature_vector,
      analyzed_at = EXCLUDED.analyzed_at,
      preview_url = EXCLUDED.preview_url,
      itunes_genre = EXCLUDED.itunes_genre,
      genre = EXCLUDED.genre,
      artwork_url = COALESCE(EXCLUDED.artwork_url, reference_tracks.artwork_url)
  `;
}

/** Load analyzed references for exactly this request's discovery session. */
async function loadReferencesByTrackIds(
  trackIds: Set<number>,
): Promise<CachedReference[]> {
  if (trackIds.size === 0) return [];

  const rows = await sql`
    SELECT id, itunes_track_id, title, artist, album, artwork_url,
           genre, preview_url, feature_vector
    FROM reference_tracks
    WHERE itunes_track_id = ANY(${[...trackIds]}) AND feature_vector IS NOT NULL
  `;

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
      feature_vector: row.feature_vector as FeatureVector,
    }));
}
