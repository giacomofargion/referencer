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

const FETCH_TIMEOUT_MS = 8_000;

async function fetchDeezer(url: string): Promise<Response> {
  return fetch(url, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

/**
 * Search previews are HTTPS on Deezer's CDN (typically cdns-preview-*.dzcdn.net).
 * Reject anything else so we never fetch/store an untrusted preview URL.
 */
export function isApprovedDeezerPreviewUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    return host === "dzcdn.net" || host.endsWith(".dzcdn.net");
  } catch {
    return false;
  }
}

function normalizeHit(hit: DeezerSearchHit): PlatformTrack | null {
  if (!hit.id || !hit.title || !hit.preview || !hit.artist?.name) return null;
  if (!isApprovedDeezerPreviewUrl(hit.preview)) return null;
  return {
    cacheKey: `deezer:${hit.id}`,
    deezerId: hit.id,
    itunesTrackId: null,
    title: hit.title,
    artist: hit.artist.name,
    album: hit.album?.title ?? null,
    artworkUrl: hit.album?.cover_big ?? hit.album?.cover_medium ?? null,
    // Search hits don't include genre — leave unknown for hydrate to resolve.
    genre: "",
    previewUrl: hit.preview,
  };
}

export async function searchDeezerTracks(
  term: string,
  limit = 15,
): Promise<PlatformTrack[]> {
  const params = new URLSearchParams({
    q: term,
    limit: String(Math.max(1, Math.min(limit, 40))),
  });
  const response = await fetchDeezer(
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
    .map((hit) => normalizeHit(hit))
    .filter((t): t is PlatformTrack => t !== null);
}
