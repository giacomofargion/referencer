import { sql } from "@/lib/db";
import { isEphemeralPreviewUrl, lookupItunesTracks } from "@/lib/itunes";

/**
 * Replace expired Deezer CDN preview URLs with stable iTunes ones.
 * Mutates `matches` in place and persists updates to `reference_tracks`.
 */
export async function refreshEphemeralPreviewUrls<
  T extends { itunesTrackId: number; previewUrl: string },
>(matches: T[]): Promise<T[]> {
  const ephemeralIds = matches
    .filter((m) => isEphemeralPreviewUrl(m.previewUrl))
    .map((m) => m.itunesTrackId);
  if (ephemeralIds.length === 0) return matches;

  const fresh = await lookupItunesTracks(ephemeralIds);
  for (const match of matches) {
    const itunesPreview = fresh.get(match.itunesTrackId)?.previewUrl;
    if (!itunesPreview || !isEphemeralPreviewUrl(match.previewUrl)) continue;
    match.previewUrl = itunesPreview;
    await sql`
      UPDATE reference_tracks
      SET preview_url = ${itunesPreview}
      WHERE itunes_track_id = ${match.itunesTrackId}
    `;
  }
  return matches;
}
