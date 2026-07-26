import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { sql } from "@/lib/db";
import {
  isR2NotConfiguredError,
  objectExists,
  presignPlayback,
} from "@/lib/r2";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Presigned R2 GET for A/B on a reopened session.
 * Returns 404 when R2 is unset or the object was never stored.
 */
export async function GET(_request: Request, context: RouteContext) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  const rows = await sql`
    SELECT r2_object_key
    FROM client_uploads
    WHERE id = ${id} AND clerk_user_id = ${userId}
    LIMIT 1
  `;
  if (rows.length === 0) {
    return NextResponse.json({ error: "Upload not found" }, { status: 404 });
  }

  const objectKey = rows[0].r2_object_key as string;
  try {
    if (!(await objectExists(objectKey))) {
      return NextResponse.json(
        { error: "Client audio not available" },
        { status: 404 },
      );
    }
    const playbackUrl = await presignPlayback(objectKey);
    return NextResponse.json({ playbackUrl });
  } catch (error) {
    // Optional R2 — same soft miss as an unstored clip.
    if (isR2NotConfiguredError(error)) {
      return NextResponse.json(
        { error: "Client audio not available" },
        { status: 404 },
      );
    }
    console.error("R2 playback failed:", error);
    return NextResponse.json(
      { error: "Audio storage unavailable" },
      { status: 503 },
    );
  }
}
