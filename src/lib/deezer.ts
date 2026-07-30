/**
 * Deezer Search API — free, no key required for basic search.
 * Returns tracks with 30s preview URLs when available.
 * https://developers.deezer.com/api/search
 */

export interface PlatformTrack {
  /** Stable id for caching — Deezer ids are namespaced. */
  cacheKey: string;
  deezerId: number | null;
  itunesTrackId: number | null;
  title: string;
  artist: string;
  album: string | null;
  artworkUrl: string | null;
  genre: string;
  previewUrl: string;
}

interface DeezerSearchHit {
  id?: number;
  title?: string;
  preview?: string;
  artist?: { name?: string };
  album?: { title?: string; cover_medium?: string; cover_big?: string };
}

const MIN_GAP_MS = 200;
let lastRequestAt = 0;
let queue: Promise<void> = Promise.resolve();

async function throttledFetch(url: string): Promise<Response> {
  const run = queue.then(async () => {
    const wait = Math.max(0, MIN_GAP_MS - (Date.now() - lastRequestAt));
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
    return fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
  });
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function normalizeHit(hit: DeezerSearchHit, fallbackGenre: string): PlatformTrack | null {
  if (!hit.id || !hit.title || !hit.preview || !hit.artist?.name) return null;
  return {
    cacheKey: `deezer:${hit.id}`,
    deezerId: hit.id,
    itunesTrackId: null,
    title: hit.title,
    artist: hit.artist.name,
    album: hit.album?.title ?? null,
    artworkUrl: hit.album?.cover_big ?? hit.album?.cover_medium ?? null,
    genre: fallbackGenre,
    previewUrl: hit.preview,
  };
}

export async function searchDeezerTracks(
  term: string,
  limit = 15,
  fallbackGenre = "Unknown",
): Promise<PlatformTrack[]> {
  const params = new URLSearchParams({
    q: term,
    limit: String(Math.max(1, Math.min(limit, 40))),
  });
  const response = await throttledFetch(
    `https://api.deezer.com/search?${params}`,
  );
  if (!response.ok) {
    throw new Error(`Deezer search failed (${response.status})`);
  }
  const data = (await response.json()) as { data?: DeezerSearchHit[]; error?: { message?: string } };
  if (data.error?.message) {
    throw new Error(`Deezer search error: ${data.error.message}`);
  }
  return (data.data ?? [])
    .map((hit) => normalizeHit(hit, fallbackGenre))
    .filter((t): t is PlatformTrack => t !== null);
}
