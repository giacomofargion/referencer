import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { sql } from "@/lib/db";
import type { FeatureVector } from "@/lib/types";

function isValidFeatureVector(value: unknown): value is FeatureVector {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.integratedLoudnessLufs === "number" &&
    typeof v.loudnessRangeDb === "number" &&
    typeof v.tempoBpm === "number" &&
    typeof v.stereoWidth === "number" &&
    Array.isArray(v.frequencyBandEnergies) &&
    v.frequencyBandEnergies.length === 7 &&
    v.frequencyBandEnergies.every((n) => typeof n === "number")
  );
}

/** Attaches the browser-computed feature vector to an upload. */
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

  if (!isValidFeatureVector(body.featureVector)) {
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
