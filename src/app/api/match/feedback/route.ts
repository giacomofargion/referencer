import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { sql } from "@/lib/db";
import { nudgeWeightsFromPreference } from "@/lib/learned-weights";
import type { WeightMultipliers } from "@/lib/matching";

/**
 * Log when a user engages a non-top match (play/open). Soft-learns which
 * feature groups were closer on the chosen track vs the skipped top result.
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

  if (!uploadId || !chosenReferenceId || chosenRank < 2) {
    return NextResponse.json({ ok: true, ignored: true });
  }

  const uploads = await sql`
    SELECT id FROM client_uploads
    WHERE id = ${uploadId} AND clerk_user_id = ${userId}
    LIMIT 1
  `;
  if (uploads.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await sql`
    INSERT INTO match_feedback (
      clerk_user_id, client_upload_id, chosen_reference_id,
      shown_order, chosen_rank, feature_group_deltas
    )
    VALUES (
      ${userId}, ${uploadId}, ${chosenReferenceId},
      ${shownOrder}, ${chosenRank},
      ${JSON.stringify(body?.groupDeltas ?? {})}::jsonb
    )
  `;

  if (body?.groupDeltas?.chosen && body?.groupDeltas?.top) {
    const chosenCloser: Array<keyof WeightMultipliers> = [];
    const skippedCloser: Array<keyof WeightMultipliers> = [];
    const keys = Object.keys(body.groupDeltas.chosen) as Array<
      keyof WeightMultipliers
    >;
    for (const key of keys) {
      const c = body.groupDeltas.chosen[key];
      const t = body.groupDeltas.top[key];
      if (typeof c !== "number" || typeof t !== "number") continue;
      if (c < t) chosenCloser.push(key);
      else if (t < c) skippedCloser.push(key);
    }
    await nudgeWeightsFromPreference({
      chosenCloserGroups: chosenCloser,
      skippedCloserGroups: skippedCloser,
    });
  }

  return NextResponse.json({ ok: true });
}
