/**
 * Free Spotify oEmbed — Cyanite SpotifyTrack only returns id + title,
 * so we resolve the artist name here without a Spotify developer app.
 */
export async function resolveSpotifyTrackMeta(spotifyId: string): Promise<{
  title: string;
  artist: string;
  artworkUrl: string | null;
} | null> {
  const url = `https://open.spotify.com/oembed?url=${encodeURIComponent(
    `https://open.spotify.com/track/${spotifyId}`,
  )}`;
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      title?: string;
      author_name?: string;
      thumbnail_url?: string;
    };
    if (!data.title || !data.author_name) return null;
    return {
      title: data.title,
      artist: data.author_name,
      artworkUrl: data.thumbnail_url ?? null,
    };
  } catch {
    return null;
  }
}
