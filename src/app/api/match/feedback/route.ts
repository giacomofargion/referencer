import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { sql } from "@/lib/db";
import { isMatchGenre } from "@/lib/genres";
import {
  nudgeWeightsFromPreference,
  type FeedbackSource,
} from "@/lib/learned-weights";
import type { WeightMultipliers } from "@/lib/matching";

function isFeedbackSource(value: unknown): value is FeedbackSource {
  return value === "engage" || value === "save" || value === "reject";
}

/** Which weight groups the chosen match was closer on vs. the top result. */
function computeCloserGroups(groupDeltas?: {
  chosen: Partial<Record<keyof WeightMultipliers, number>>;
  top: Partial<Record<keyof WeightMultipliers, number>>;
}): {
  chosenCloser: Array<keyof WeightMultipliers>;
  skippedCloser: Array<keyof WeightMultipliers>;
} {
  const chosenCloser: Array<keyof WeightMultipliers> = [];
  const skippedCloser: Array<keyof WeightMultipliers> = [];
  if (!groupDeltas?.chosen || !groupDeltas?.top) {
    return { chosenCloser, skippedCloser };
  }
  const keys = Object.keys(groupDeltas.chosen) as Array<keyof WeightMultipliers>;
  for (const key of keys) {
    const c = groupDeltas.chosen[key];
    const t = groupDeltas.top[key];
    if (typeof c !== "number" || typeof t !== "number") continue;
    if (c < t) chosenCloser.push(key);
    else if (t < c) skippedCloser.push(key);
  }
  return { chosenCloser, skippedCloser };
}

/**
 * Log match preference signals (engage / save / reject). Soft-learns which
 * feature groups were closer on the chosen track vs the skipped top result,
 * scoped per genre — see src/lib/learned-weights.ts.
 */
export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    uploadId?: string;
    chosenReferenceId?: string;
    shownOrder?: number;
    chosenRank?: number;
    source?: string;
    /** Absolute deltas for weight groups: chosen vs client, and top vs client. */
    groupDeltas?: {
      chosen: Partial<Record<keyof WeightMultipliers, number>>;
      top: Partial<Record<keyof WeightMultipliers, number>>;
    };
  } | null;

  const uploadId = String(body?.uploadId ?? "").trim();
  const chosenReferenceId = String(body?.chosenReferenceId ?? "").trim();
  const shownOrder = Number(body?.shownOrder ?? 0);
  const chosenRank = Number(body?.chosenRank ?? 0);
  const source: FeedbackSource = isFeedbackSource(body?.source)
    ? body.source
    : "engage";

  // A save or reject on the current #1 result is still a genuine signal —
  // only a relative carousel-engage needs rank >= 2 to mean anything.
  if (!uploadId || !chosenReferenceId || (chosenRank < 2 && source === "engage")) {
    return NextResponse.json({ ok: true, ignored: true });
  }

  const uploads = await sql`
    SELECT id, genre FROM client_uploads
    WHERE id = ${uploadId} AND clerk_user_id = ${userId}
    LIMIT 1
  `;
  if (uploads.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const genreRaw = uploads[0].genre as string | null;
  const genre = genreRaw && isMatchGenre(genreRaw) ? genreRaw : null;

  await sql`
    INSERT INTO match_feedback (
      clerk_user_id, client_upload_id, chosen_reference_id,
      shown_order, chosen_rank, feature_group_deltas, source, genre
    )
    VALUES (
      ${userId}, ${uploadId}, ${chosenReferenceId},
      ${shownOrder}, ${chosenRank},
      ${JSON.stringify(body?.groupDeltas ?? {})}::jsonb,
      ${source}, ${genre}
    )
  `;

  // Pre-migration uploads have no stored genre — still log the audit row
  // above, just skip the nudge rather than guessing a genre.
  if (genre) {
    const { chosenCloser, skippedCloser } = computeCloserGroups(body?.groupDeltas);
    if (chosenCloser.length > 0 || skippedCloser.length > 0) {
      await nudgeWeightsFromPreference({
        genre,
        chosenCloserGroups: chosenCloser,
        skippedCloserGroups: skippedCloser,
        source,
      });
    }
  }

  return NextResponse.json({ ok: true });
}
