/**
 * Cyanite.ai GraphQL client — upload an unreleased mix, wait for analysis
 * (polling; webhooks optional), then pull Spotify-similar commercial tracks.
 *
 * Docs: https://api-docs.cyanite.ai/
 * Configure CYANITE_ACCESS_TOKEN. Without it, callers should skip this path.
 */

const GRAPHQL_URL = "https://api.cyanite.ai/graphql";

export function isCyaniteConfigured(): boolean {
  return Boolean(process.env.CYANITE_ACCESS_TOKEN?.trim());
}

export interface CyaniteSimilarTrack {
  spotifyId: string;
  title: string;
}

async function cyaniteGraphql<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const token = process.env.CYANITE_ACCESS_TOKEN?.trim();
  if (!token) {
    throw new Error("CYANITE_ACCESS_TOKEN is not configured");
  }

  const response = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`Cyanite HTTP ${response.status}`);
  }

  const payload = (await response.json()) as {
    data?: T;
    errors?: Array<{ message?: string }>;
  };
  if (payload.errors?.length) {
    throw new Error(
      payload.errors.map((e) => e.message ?? "GraphQL error").join("; "),
    );
  }
  if (!payload.data) {
    throw new Error("Cyanite returned empty data");
  }
  return payload.data;
}

/** Request upload slot → PUT mp3 → create LibraryTrack. Returns Cyanite id. */
export async function uploadLibraryTrackMp3(input: {
  mp3: Buffer;
  title: string;
  externalId?: string;
}): Promise<string> {
  const uploadReq = await cyaniteGraphql<{
    fileUploadRequest: { id: string; uploadUrl: string };
  }>(`mutation { fileUploadRequest { id uploadUrl } }`);

  const { id: uploadId, uploadUrl } = uploadReq.fileUploadRequest;
  const put = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "audio/mpeg" },
    body: new Uint8Array(input.mp3),
    signal: AbortSignal.timeout(60_000),
  });
  if (!put.ok) {
    throw new Error(`Cyanite file PUT failed (${put.status})`);
  }

  const created = await cyaniteGraphql<{
    libraryTrackCreate:
      | {
          __typename: "LibraryTrackCreateSuccess";
          createdLibraryTrack: { id: string };
        }
      | {
          __typename: "LibraryTrackCreateError";
          code: string;
          message: string;
        };
  }>(
    `mutation CreateTrack($input: LibraryTrackCreateInput!) {
      libraryTrackCreate(input: $input) {
        __typename
        ... on LibraryTrackCreateSuccess {
          createdLibraryTrack { id }
        }
        ... on LibraryTrackCreateError {
          code
          message
        }
      }
    }`,
    {
      input: {
        uploadId,
        title: input.title.slice(0, 200),
        externalId: input.externalId,
      },
    },
  );

  if (created.libraryTrackCreate.__typename !== "LibraryTrackCreateSuccess") {
    throw new Error(
      `Cyanite create failed: ${created.libraryTrackCreate.code} — ${created.libraryTrackCreate.message}`,
    );
  }
  return created.libraryTrackCreate.createdLibraryTrack.id;
}

/**
 * Poll until AudioAnalysis V6/V7 reports finished (webhook optional for local).
 * Free-tier analysis is usually well under a minute.
 */
export async function waitForLibraryTrackAnalysis(
  libraryTrackId: string,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 50_000;
  const intervalMs = options.intervalMs ?? 2_500;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const status = await getAnalysisStatus(libraryTrackId);
    if (status === "finished") return;
    if (status === "failed") {
      throw new Error("Cyanite analysis failed");
    }
    await sleep(intervalMs);
  }
  throw new Error("Cyanite analysis timed out — try again in a moment");
}

async function getAnalysisStatus(
  libraryTrackId: string,
): Promise<"pending" | "finished" | "failed"> {
  const data = await cyaniteGraphql<{
    libraryTrack:
      | {
          __typename: "LibraryTrack";
          audioAnalysisV6: { __typename: string };
          audioAnalysisV7: { __typename: string };
        }
      | { __typename: string; message?: string };
  }>(
    `query TrackStatus($id: ID!) {
      libraryTrack(id: $id) {
        __typename
        ... on LibraryTrack {
          audioAnalysisV6 { __typename }
          audioAnalysisV7 { __typename }
        }
        ... on Error { message }
      }
    }`,
    { id: libraryTrackId },
  );

  const track = data.libraryTrack;
  if (!("audioAnalysisV6" in track)) {
    throw new Error(
      `Cyanite track lookup failed: ${track.message ?? track.__typename}`,
    );
  }

  const v6 = track.audioAnalysisV6.__typename;
  const v7 = track.audioAnalysisV7.__typename;

  if (v6.includes("Failed") || v7.includes("Failed")) return "failed";
  // Prefer V7 when present; either Finished is enough to search.
  if (v6.includes("Finished") || v7.includes("Finished")) return "finished";
  return "pending";
}

/** Spotify-similar tracks for a finished LibraryTrack. */
export async function findSimilarSpotifyTracks(
  libraryTrackId: string,
  first = 20,
): Promise<CyaniteSimilarTrack[]> {
  const data = await cyaniteGraphql<{
    libraryTrack:
      | {
          __typename: "LibraryTrack";
          similarTracks:
            | {
                __typename: "SimilarTracksConnection";
                edges: Array<{
                  node: { __typename: string; id: string; title?: string };
                }>;
              }
            | {
                __typename: "SimilarTracksError";
                code: string;
                message: string;
              };
        }
      | { __typename: string; message?: string };
  }>(
    `query Similar($id: ID!, $first: Int!) {
      libraryTrack(id: $id) {
        __typename
        ... on LibraryTrack {
          similarTracks(target: { spotify: {} }, first: $first) {
            __typename
            ... on SimilarTracksError { code message }
            ... on SimilarTracksConnection {
              edges {
                node {
                  __typename
                  ... on SpotifyTrack { id title }
                }
              }
            }
          }
        }
        ... on Error { message }
      }
    }`,
    { id: libraryTrackId, first },
  );

  const track = data.libraryTrack;
  if (!("similarTracks" in track)) {
    throw new Error("Cyanite similarTracks: library track not found");
  }

  const result = track.similarTracks;
  if (result.__typename === "SimilarTracksError") {
    throw new Error(`Cyanite similarTracks: ${result.code} — ${result.message}`);
  }

  type SpotNode = { __typename: string; id: string; title?: string };
  const nodes: SpotNode[] = result.edges.map((edge) => edge.node);
  return nodes
    .filter(
      (node): node is SpotNode & { title: string } =>
        node.__typename === "SpotifyTrack" && typeof node.title === "string",
    )
    .map((node) => ({
      spotifyId: node.id,
      title: node.title,
    }));
}

/** Basic-tier library cap is 30 — delete when done so the next run can upload. */
export async function deleteLibraryTracks(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    await cyaniteGraphql(
      `mutation Delete($input: LibraryTracksDeleteInput!) {
        libraryTracksDelete(input: $input) {
          __typename
          ... on LibraryTracksDeleteError { code message }
        }
      }`,
      { input: { libraryTrackIds: ids.slice(0, 100) } },
    );
  } catch (error) {
    console.warn("Cyanite delete failed (non-fatal):", error);
  }
}

/**
 * End-to-end: upload mp3 → wait → similar Spotify IDs → cleanup library slot.
 */
export async function discoverSimilarViaCyanite(input: {
  mp3: Buffer;
  title: string;
  externalId?: string;
}): Promise<CyaniteSimilarTrack[]> {
  const libraryTrackId = await uploadLibraryTrackMp3(input);
  try {
    await waitForLibraryTrackAnalysis(libraryTrackId);
    return await findSimilarSpotifyTracks(libraryTrackId, 20);
  } finally {
    await deleteLibraryTracks([libraryTrackId]);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
