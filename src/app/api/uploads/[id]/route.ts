import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { sql } from "@/lib/db";
import { isStoredFingerprint } from "@/lib/feature-vector";

/** Attaches the browser-computed fingerprint to an upload. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const body = (await request.json()) as { featureVector?: unknown };

  if (!isStoredFingerprint(body.featureVector)) {
    return NextResponse.json(
      { error: "Invalid feature vector" },
      { status: 400 },
    );
  }

  const rows = await sql`
    UPDATE client_uploads
    SET feature_vector = ${JSON.stringify(body.featureVector)}::jsonb
    WHERE id = ${id} AND clerk_user_id = ${userId}
    RETURNING id
  `;

  if (rows.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
