/**
 * MERT embed worker client — embeds audio and runs ANN over the shared R2 catalog.
 * The worker loads the catalog once (local path or download from R2) and optionally
 * tags the upload with Discogs-EffNet before genre-filtering neighbors.
 */

export interface MertSimilarHit {
  spotifyId: string;
  title: string;
  artist: string;
  album: string | null;
  genre: string | null;
  distance: number;
}

export interface MertDiscoveryResult {
  hits: MertSimilarHit[];
  predictedGenre: string | null;
  genreConfidence: number | null;
  discogsLabel: string | null;
  catalogSize: number;
}

export function isMertWorkerConfigured(): boolean {
  return Boolean(process.env.EMBED_WORKER_URL?.trim());
}

function workerBaseUrl(): string {
  const raw = process.env.EMBED_WORKER_URL?.trim();
  if (!raw) {
    throw new Error("EMBED_WORKER_URL is not set");
  }
  return raw.replace(/\/$/, "");
}

export async function isMertDiscoveryReady(): Promise<boolean> {
  if (!isMertWorkerConfigured()) return false;
  try {
    const response = await fetch(`${workerBaseUrl()}/health`, {
      signal: AbortSignal.timeout(3000),
      cache: "no-store",
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { catalogReady?: boolean };
    return Boolean(body.catalogReady);
  } catch {
    return false;
  }
}

/**
 * Embed the mix and ANN-search the worker's in-memory R2/local catalog.
 */
export async function discoverSimilarViaMert(input: {
  audio: ArrayBuffer;
  contentType?: string | null;
  limit?: number;
}): Promise<MertDiscoveryResult> {
  const limit = Math.max(1, Math.min(input.limit ?? 40, 100));
  const form = new FormData();
  const type = input.contentType || "audio/mpeg";
  form.append(
    "audio",
    new Blob([new Uint8Array(input.audio)], { type }),
    "clip.mp3",
  );

  const response = await fetch(`${workerBaseUrl()}/similar?limit=${limit}`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(180_000),
    cache: "no-store",
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `MERT similar ${response.status}: ${detail || response.statusText}`,
    );
  }

  const body = (await response.json()) as {
    hits?: Array<{
      spotifyId?: string;
      title?: string;
      artist?: string;
      album?: string | null;
      genre?: string | null;
      distance?: number;
    }>;
    predictedGenre?: string | null;
    genreConfidence?: number | null;
    discogsLabel?: string | null;
    catalogSize?: number;
  };

  if (!Array.isArray(body.hits)) {
    throw new Error("MERT worker returned invalid similar results");
  }

  return {
    hits: body.hits.map((hit) => ({
      spotifyId: String(hit.spotifyId ?? ""),
      title: String(hit.title ?? ""),
      artist: String(hit.artist ?? ""),
      album: hit.album ?? null,
      genre: hit.genre ?? null,
      distance: Number(hit.distance ?? 0),
    })),
    predictedGenre: body.predictedGenre ?? null,
    genreConfidence:
      body.genreConfidence == null ? null : Number(body.genreConfidence),
    discogsLabel: body.discogsLabel ?? null,
    catalogSize: Number(body.catalogSize ?? 0),
  };
}
