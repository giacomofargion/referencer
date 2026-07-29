export interface ItunesTrack {
  itunesTrackId: number;
  title: string;
  artist: string;
  album: string | null;
  artworkUrl: string | null;
  /** iTunes primaryGenreName (e.g. "Jungle/Drum'n'bass"). */
  genre: string;
  /** Kept alongside `genre` because the DB stores both columns. */
  itunesGenre: string;
  previewUrl: string;
}

interface ItunesSearchResult {
  trackId?: number;
  trackName?: string;
  artistName?: string;
  collectionName?: string;
  artworkUrl100?: string;
  primaryGenreName?: string;
  previewUrl?: string;
  kind?: string;
}

/** Soft iTunes limit is ~20 req/min — serialize lookups with a gap. */
const MIN_GAP_MS = 3500;
let lastRequestAt = 0;
let queue: Promise<void> = Promise.resolve();

async function throttledFetch(url: string): Promise<Response> {
  const run = queue.then(async () => {
    const wait = Math.max(0, MIN_GAP_MS - (Date.now() - lastRequestAt));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
    return fetch(url, {
      headers: { Accept: "application/json" },
      next: { revalidate: 0 },
    });
  });
  // Keep the chain alive even if a request fails
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function normalizeSearchResult(item: ItunesSearchResult): ItunesTrack | null {
  if (
    !item.trackId ||
    !item.trackName ||
    !item.artistName ||
    !item.previewUrl ||
    !item.primaryGenreName
  ) {
    return null;
  }
  return {
    itunesTrackId: item.trackId,
    title: item.trackName,
    artist: item.artistName,
    album: item.collectionName ?? null,
    artworkUrl: item.artworkUrl100?.replace("100x100bb", "300x300bb") ?? null,
    genre: item.primaryGenreName,
    itunesGenre: item.primaryGenreName,
    previewUrl: item.previewUrl,
  };
}

/**
 * Free-text song search. Used to hydrate genre/seed-artist discovery into
 * iTunes previews for A/B playback + Essentia analysis.
 */
export async function searchItunesSongs(
  term: string,
  limit = 8,
): Promise<ItunesTrack[]> {
  const params = new URLSearchParams({
    term,
    media: "music",
    entity: "song",
    limit: String(limit),
  });
  const response = await throttledFetch(
    `https://itunes.apple.com/search?${params}`,
  );
  if (!response.ok) {
    throw new Error(`iTunes search failed (${response.status})`);
  }
  const data = (await response.json()) as { results?: ItunesSearchResult[] };
  return (data.results ?? [])
    .map(normalizeSearchResult)
    .filter((t): t is ItunesTrack => t !== null);
}
