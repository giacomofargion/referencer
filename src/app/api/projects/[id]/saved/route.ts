import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { sql } from "@/lib/db";

const MAX_NOTE_LENGTH = 500;

type RouteContext = { params: Promise<{ id: string }> };

async function assertOwnedProject(projectId: string, userId: string) {
  const rows = await sql`
    SELECT id
    FROM projects
    WHERE id = ${projectId} AND clerk_user_id = ${userId}
    LIMIT 1
  `;
  return rows.length > 0;
}

/** Add a commercial reference to the project shortlist. */
export async function POST(request: Request, context: RouteContext) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: projectId } = await context.params;
  if (!(await assertOwnedProject(projectId, userId))) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const body = (await request.json()) as {
    referenceTrackId?: string;
    note?: string | null;
  };
  const referenceTrackId = body.referenceTrackId?.trim();
  if (!referenceTrackId) {
    return NextResponse.json(
      { error: "referenceTrackId required" },
      { status: 400 },
    );
  }

  // Omitted note → keep existing on upsert; "" / whitespace → clear to null.
  const noteProvided = Object.prototype.hasOwnProperty.call(body, "note");
  const note = noteProvided
    ? typeof body.note === "string"
      ? body.note.trim().slice(0, MAX_NOTE_LENGTH) || null
      : null
    : null;

  const refs = await sql`
    SELECT id FROM reference_tracks WHERE id = ${referenceTrackId} LIMIT 1
  `;
  if (refs.length === 0) {
    return NextResponse.json(
      { error: "Reference track not found" },
      { status: 404 },
    );
  }

  const [row] = await sql`
    INSERT INTO saved_references (project_id, reference_track_id, note)
    VALUES (${projectId}, ${referenceTrackId}, ${note})
    ON CONFLICT (project_id, reference_track_id)
    DO UPDATE SET note = CASE
      WHEN ${noteProvided} THEN EXCLUDED.note
      ELSE saved_references.note
    END
    RETURNING id, created_at, note
  `;

  return NextResponse.json({
    saved: {
      savedId: row.id as string,
      referenceTrackId,
      note: (row.note as string | null) ?? null,
      savedAt: row.created_at as string,
    },
  });
}

/** Remove a reference from the project shortlist. */
export async function DELETE(request: Request, context: RouteContext) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: projectId } = await context.params;
  if (!(await assertOwnedProject(projectId, userId))) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const body = (await request.json()) as { referenceTrackId?: string };
  const referenceTrackId = body.referenceTrackId?.trim();
  if (!referenceTrackId) {
    return NextResponse.json(
      { error: "referenceTrackId required" },
      { status: 400 },
    );
  }

  const rows = await sql`
    DELETE FROM saved_references
    WHERE project_id = ${projectId}
      AND reference_track_id = ${referenceTrackId}
    RETURNING id
  `;
  if (rows.length === 0) {
    return NextResponse.json({ error: "Not saved" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
