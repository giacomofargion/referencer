import { sql } from "@/lib/db";
import { isEphemeralPreviewUrl, lookupItunesTracks } from "@/lib/itunes";

/**
 * Replace expired Deezer CDN preview URLs with stable iTunes ones.
 * Mutates `matches` in place and best-effort persists updates to `reference_tracks`.
 * DB write failures are logged and never reject the caller — in-memory URLs still return.
 */
export async function refreshEphemeralPreviewUrls<
  T extends { itunesTrackId: number; previewUrl: string },
>(matches: T[]): Promise<T[]> {
  const ephemeralIds = [
    ...new Set(
      matches
        .filter((m) => isEphemeralPreviewUrl(m.previewUrl))
        .map((m) => m.itunesTrackId),
    ),
  ];
  if (ephemeralIds.length === 0) return matches;

  const fresh = await lookupItunesTracks(ephemeralIds);

  // Dedupe by track id so one match row → one DB update even if the id appears twice.
  const updates = new Map<number, string>();
  for (const match of matches) {
    const itunesPreview = fresh.get(match.itunesTrackId)?.previewUrl;
    if (!itunesPreview || !isEphemeralPreviewUrl(match.previewUrl)) continue;
    match.previewUrl = itunesPreview;
    updates.set(match.itunesTrackId, itunesPreview);
  }

  if (updates.size === 0) return matches;

  const ids = [...updates.keys()];
  const urls = [...updates.values()];
  try {
    // One round-trip: pair ids↔urls via unnest (same array style as ANY([...]) elsewhere).
    await sql`
      UPDATE reference_tracks AS rt
      SET preview_url = data.preview_url
      FROM unnest(${ids}::int[], ${urls}::text[]) AS data(itunes_track_id, preview_url)
      WHERE rt.itunes_track_id = data.itunes_track_id
    `;
  } catch (err) {
    console.error("Failed to persist refreshed preview URLs", err);
  }

  return matches;
}
