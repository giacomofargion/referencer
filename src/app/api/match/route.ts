import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { analyzePreviewUrl } from "@/lib/analyze-server";
import { debitForMatch, refundMatch } from "@/lib/credits";
import { sql } from "@/lib/db";
import {
  cacheRowNeedsReanalyze,
  collectPlatformCandidates,
  loadCacheStatusByTrackIds,
  upsertReference,
  type DiscoveredTrack,
} from "@/lib/discovery";
import { explainMatch } from "@/lib/explanations";
import {
  getAggregateFeatures,
  isStoredFingerprint,
} from "@/lib/feature-vector";
import {
  closerQueryKind,
  combineGenreCloseness,
  genreLabelAffinity,
  instrumentsFromDiscogsLabel,
  isDrumAndBassTempo,
  isInGenreNeighborhood,
  isMatchGenre,
  searchQueriesForDiscovery,
  type DiscoveryQueryKind,
  type MatchGenre,
} from "@/lib/genres";
import {
  isEphemeralPreviewUrl,
  lookupItunesTracks,
  searchItunesSongs,
} from "@/lib/itunes";
import { pickStrictItunesMatch } from "@/lib/itunes-match";
import { getLearnedWeightMultipliers } from "@/lib/learned-weights";
import { isStrongReferenceFit, rankReferences } from "@/lib/matching";
import { refreshEphemeralPreviewUrls } from "@/lib/refresh-previews";
import type { StoredFingerprint } from "@/lib/types";

export const maxDuration = 60;

/** Cap new Essentia analyses per request so we stay under maxDuration. */
const MAX_HYDRATIONS = 14;
/**
 * Cap throttled iTunes text-search calls (resolving a Deezer-only hit to a
 * stable id) per request. iTunes's ~20 req/min limit means each one costs
 * a serialized 3.5s — uncapped, this alone can burn the whole time budget
 * resolving broad chart filler before a single preview gets analyzed.
 */
const MAX_RESOLVE_CALLS = 8;
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

interface PooledReference extends CachedReference {
  /** 0 = requested style, higher = a broader genre search or label. */
  genreCloseness: number;
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

  await sql`
    UPDATE client_uploads SET genre = ${genre}
    WHERE id = ${uploadId} AND clerk_user_id = ${userId}
  `;

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

  let pool: PooledReference[] = [];
  let sourceNote: string = genre;

  try {
    const queries = searchQueriesForDiscovery({
      genre,
      discogsLabel,
      instruments,
    }).slice(0, QUERIES_PER_SOURCE);
    // 86 BPM is the half-time reading of a 172 BPM drum-and-bass grid.
    if (genre === "Electronic" && isDrumAndBassTempo(clientFeatures.tempoBpm)) {
      queries.unshift({ query: "drum and bass", kind: "style" });
    }

    // The analyzed library answers immediately. Live search is slow and a
    // style word like "Glitch" is mostly song titles, so the chart and the
    // library are what actually fill a shortlist.
    const catalogPromise = loadGenreCatalog(genre, discogsLabel).catch(
      (error) => {
        console.warn("Genre catalog lookup failed:", error);
        return [] as PooledReference[];
      },
    );

    const platformHits = await collectPlatformCandidates(
      queries,
      genre,
      discogsLabel,
      RESULTS_PER_QUERY,
      MAX_POOL,
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
    const closenessByTrack = new Map<number, number>();
    for (const hit of hydrated) {
      const row = byId.get(hit.itunesTrackId);
      if (!row) continue;
      if (!isInGenreNeighborhood(genre, row.genre, discogsLabel)) continue;
      const closeness = combineGenreCloseness(
        hit.queryKind,
        genreLabelAffinity(genre, row.genre, discogsLabel),
      );
      const previous = closenessByTrack.get(hit.itunesTrackId);
      if (previous == null || closeness < previous) {
        closenessByTrack.set(hit.itunesTrackId, closeness);
      }
    }
    pool = [...closenessByTrack.entries()].flatMap(([trackId, closeness]) => {
      const row = byId.get(trackId);
      if (!row) return [];
      return [{ ...row, genreCloseness: closeness }];
    });

    const catalog = await catalogPromise;
    pool = mergePools(pool, catalog);

    const styleNote = discogsLabel?.includes("---")
      ? discogsLabel.split("---", 2)[1]?.trim()
      : null;
    const instrumentNote =
      instruments.length > 0 ? ` · ${instruments.slice(0, 2).join("/")}` : "";
    sourceNote = styleNote
      ? `Discogs “${styleNote}”${instrumentNote}`
      : `Discogs ${genre}${instrumentNote}`;
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
      projectId,
      creditsRemaining: balanceAfterDebit,
      discoveryNote:
        "No playable references found for this genre — try again in a moment.",
    });
  }

  const weightMultipliers = await getLearnedWeightMultipliers(genre);
  const rankedAll = rankReferences(
    clientFingerprint,
    pool.map((row) => ({
      item: row,
      features: row.feature_vector,
      genreCloseness: row.genreCloseness,
    })),
    "balanced",
    weightMultipliers,
  );
  // `pool` is already gated to the requested genre neighborhood (live hits
  // and the catalog were both filtered there). Never reach outside it for a
  // cross-genre "tone twin," and never empty the list because nothing
  // cleared a sonic-distance cutoff — show the closest tracks this search
  // actually found in style, ranked, and say honestly how close they are.
  const ranked = rankedAll.slice(0, TOP_RESULTS);
  const strongFitCount = ranked.filter((hit) =>
    isStrongReferenceFit(hit.sonicDistance, hit.genreCloseness),
  ).length;

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
      genreCloseness: hit.genreCloseness,
      saved: savedIds.has(hit.item.id),
    });
  }

  // Final pass: replace any remaining Deezer CDN URLs before the client plays them.
  await refreshEphemeralPreviewUrls(matches);

  const discoveryNote =
    strongFitCount > 0
      ? `${sourceNote} → closest ${matches.length} of ${pool.length} in style, ${strongFitCount} with a strong tone match.`
      : `${sourceNote} → closest ${matches.length} of ${pool.length} in style. Tone is a stretch on all of them — none are a strong match yet.`;

  return NextResponse.json({
    matches,
    clientFeatures,
    projectId,
    discoveryNote,
    creditsRemaining: balanceAfterDebit,
  });
}


/** Keep the closer genre score when live search and the library both have a track. */
function mergePools(
  live: PooledReference[],
  catalog: PooledReference[],
): PooledReference[] {
  const byTrack = new Map<number, PooledReference>();
  for (const row of catalog) byTrack.set(row.itunes_track_id, row);
  for (const row of live) {
    const previous = byTrack.get(row.itunes_track_id);
    if (!previous || row.genreCloseness < previous.genreCloseness) {
      byTrack.set(row.itunes_track_id, row);
    }
  }
  return [...byTrack.values()];
}

/**
 * Already-analyzed tracks in this genre — answers instantly while live
 * discovery (slower, and thin for any style that hasn't been searched
 * before) fills in behind it. See scripts/seed-shelf.ts to grow this on
 * purpose instead of waiting for it to accumulate from past searches.
 */
async function loadGenreCatalog(
  genre: MatchGenre,
  discogsLabel: string | null,
): Promise<PooledReference[]> {
  const rows = await sql`
    SELECT itunes_track_id, genre
    FROM reference_tracks
    WHERE feature_vector IS NOT NULL
    ORDER BY analyzed_at DESC
  `;
  const ids: number[] = [];
  for (const row of rows) {
    if (!isInGenreNeighborhood(genre, String(row.genre ?? ""), discogsLabel)) {
      continue;
    }
    ids.push(Number(row.itunes_track_id));
    if (ids.length >= 160) break;
  }
  const loaded = await loadReferencesByTrackIds(new Set(ids));
  return loaded.map((row) => ({
    ...row,
    genreCloseness: combineGenreCloseness(
      "genre",
      genreLabelAffinity(genre, row.genre, discogsLabel),
    ),
  }));
}

/**
 * Resolve to iTunes ids for the existing reference_tracks cache key, analyze
 * previews (Deezer or iTunes URL), upsert features.
 * Stops early when the request deadline is reached so ranking still has budget.
 *
 * `hits` already arrives style-first (see genres.ts hydrationOrder): specific
 * style hits are queued and analyzed before broad parent-genre chart filler,
 * and iTunes-native hits (already carry a stable id) are cheaper than
 * Deezer-only hits that need a throttled resolve-by-search call.
 */
async function hydratePlatformTracks(
  hits: DiscoveredTrack[],
  fallbackGenre: MatchGenre,
  discogsLabel: string | null,
  requestStartedAt: number,
): Promise<Array<{ itunesTrackId: number; queryKind: DiscoveryQueryKind }>> {
  const ordered: Array<{ itunesTrackId: number; queryKind: DiscoveryQueryKind }> =
    [];
  const seen = new Set<number>();
  let analyzed = 0;
  let resolveCalls = 0;
  const deadlineAt =
    requestStartedAt + maxDuration * 1000 - HYDRATE_SAFETY_MARGIN_MS;

  const pastDeadline = () => Date.now() >= deadlineAt;
  const pendingAnalysis: Array<{
    itunesId: number;
    previewUrl: string;
    title: string;
    artist: string;
    album: string | null;
    artworkUrl: string | null;
    genre: string;
    itunesGenre: string;
    queryKind: DiscoveryQueryKind;
  }> = [];

  // Hits that already carry an iTunes id (iTunes-native search hits) need no
  // throttled resolve call — batch their cache status up front so the loop
  // below only ever talks to the DB per-item for the much smaller set that
  // still needs resolving.
  const knownIds = new Set(
    hits
      .map((hit) => hit.itunesTrackId)
      .filter((id): id is number => id != null),
  );
  const cacheByTrackId = await loadCacheStatusByTrackIds(knownIds);

  for (const hit of hits) {
    if (pastDeadline()) break;
    // Stop once enough fresh candidates are queued to fill the analysis
    // budget and we already have a full result list — more resolving or
    // cache lookups past that point cannot change the outcome.
    if (pendingAnalysis.length >= MAX_HYDRATIONS && ordered.length >= TOP_RESULTS) {
      break;
    }

    let itunesId = hit.itunesTrackId;
    let previewUrl = hit.previewUrl;
    let title = hit.title;
    let artist = hit.artist;
    let album = hit.album;
    let artworkUrl = hit.artworkUrl;
    let genre = hit.genre || fallbackGenre;
    let itunesGenre = hit.genre || fallbackGenre;
    // Was this id already covered by the up-front batch lookup? Tracked
    // separately so a freshly-resolved id (not in that batch) gets its own
    // lookup below, without re-querying an id the batch already checked.
    const wasKnownId = itunesId != null;
    let cached = itunesId != null ? cacheByTrackId.get(itunesId) : undefined;

    if (itunesId == null) {
      // Bounded separately from MAX_HYDRATIONS: each call is a serialized
      // ~3.5s iTunes request, so this is what actually caps request time.
      if (pastDeadline() || resolveCalls >= MAX_RESOLVE_CALLS) continue;
      const term = [hit.artist, hit.title].filter(Boolean).join(" ").trim();
      if (!term) continue;
      resolveCalls += 1;
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

    if (seen.has(itunesId)) {
      const existing = ordered.find((item) => item.itunesTrackId === itunesId);
      if (existing) {
        existing.queryKind = closerQueryKind(existing.queryKind, hit.queryKind);
      }
      continue;
    }
    // Drop loudness twins from the wrong neighborhood before spending analyze budget.
    if (!isInGenreNeighborhood(fallbackGenre, genre, discogsLabel)) {
      continue;
    }

    if (pastDeadline()) break;

    // A resolve call surfaces an id the up-front batch never saw — look it
    // up now. (A pre-known id's status is already authoritative from that
    // batch, cached or not, so this only runs for freshly-resolved ids.)
    if (!wasKnownId) {
      cached = (await loadCacheStatusByTrackIds(new Set([itunesId]))).get(
        itunesId,
      );
    }

    if (cacheRowNeedsReanalyze(cached)) {
      // Analyze after the lookup pass so one new preview cannot block
      // cached tracks that are already usable references.
      if (pendingAnalysis.length >= MAX_HYDRATIONS) continue;
      pendingAnalysis.push({
        itunesId,
        previewUrl,
        title,
        artist,
        album,
        artworkUrl,
        genre,
        itunesGenre,
        queryKind: hit.queryKind,
      });
      seen.add(itunesId);
      continue;
    }

    // Cache hit: swap ephemeral Deezer URLs for stable iTunes ones (no re-analyze).
    if (!cached) continue;
    const storedUrl = cached.previewUrl;
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

    seen.add(itunesId);
    ordered.push({ itunesTrackId: itunesId, queryKind: hit.queryKind });
  }

  for (const pending of pendingAnalysis) {
    if (pastDeadline() || analyzed >= MAX_HYDRATIONS) break;
    try {
      let analyzeUrl = pending.previewUrl;
      if (isEphemeralPreviewUrl(analyzeUrl)) {
        const fresh = await lookupItunesTracks([pending.itunesId]);
        const itunesPreview = fresh.get(pending.itunesId)?.previewUrl;
        if (itunesPreview) analyzeUrl = itunesPreview;
      }
      const { fingerprint, loudestStartSec } = await analyzePreviewUrl(analyzeUrl);
      await upsertReference(
        {
          itunesTrackId: pending.itunesId,
          title: pending.title,
          artist: pending.artist,
          album: pending.album,
          artworkUrl: pending.artworkUrl,
          genre: pending.genre,
          itunesGenre: pending.itunesGenre,
          previewUrl: analyzeUrl,
        },
        fingerprint,
        loudestStartSec,
      );
      analyzed += 1;
      ordered.push({
        itunesTrackId: pending.itunesId,
        queryKind: pending.queryKind,
      });
    } catch {
      continue;
    }
  }

  return ordered;
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
