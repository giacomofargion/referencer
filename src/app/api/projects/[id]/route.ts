import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { sql } from "@/lib/db";

const MAX_NAME_LENGTH = 120;

type RouteContext = { params: Promise<{ id: string }> };

async function loadOwnedProject(projectId: string, userId: string) {
  const rows = await sql`
    SELECT id, name, created_at
    FROM projects
    WHERE id = ${projectId} AND clerk_user_id = ${userId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/** Project detail with sessions and saved shortlist. */
export async function GET(_request: Request, context: RouteContext) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  const project = await loadOwnedProject(id, userId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const sessions = await sql`
    SELECT
      cu.id,
      cu.title,
      cu.created_at,
      (
        SELECT COUNT(*)::int
        FROM matches m
        WHERE m.client_upload_id = cu.id
      ) AS match_count
    FROM client_uploads cu
    WHERE cu.project_id = ${id} AND cu.clerk_user_id = ${userId}
    ORDER BY cu.created_at DESC
  `;

  const saved = await sql`
    SELECT
      sr.id AS saved_id,
      sr.note,
      sr.created_at,
      rt.id,
      rt.itunes_track_id,
      rt.title,
      rt.artist,
      rt.album,
      rt.artwork_url,
      rt.genre,
      rt.preview_url,
      rt.preview_start_sec
    FROM saved_references sr
    JOIN reference_tracks rt ON rt.id = sr.reference_track_id
    WHERE sr.project_id = ${id}
    ORDER BY sr.created_at DESC
  `;

  return NextResponse.json({
    project: {
      id: project.id as string,
      name: project.name as string,
      createdAt: project.created_at as string,
    },
    sessions: sessions.map((row) => ({
      id: row.id as string,
      title: row.title as string,
      createdAt: row.created_at as string,
      matchCount: row.match_count as number,
    })),
    savedReferences: saved.map((row) => ({
      savedId: row.saved_id as string,
      note: (row.note as string | null) ?? null,
      savedAt: row.created_at as string,
      id: row.id as string,
      itunesTrackId: Number(row.itunes_track_id),
      title: row.title as string,
      artist: row.artist as string,
      album: (row.album as string | null) ?? null,
      artworkUrl: (row.artwork_url as string | null) ?? null,
      genre: row.genre as string,
      previewUrl: row.preview_url as string,
      previewStartSec:
        row.preview_start_sec == null ? null : Number(row.preview_start_sec),
    })),
  });
}

/** Rename a project. */
export async function PATCH(request: Request, context: RouteContext) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  const body = (await request.json()) as { name?: string };
  const name = body.name?.trim();
  if (!name || name.length > MAX_NAME_LENGTH) {
    return NextResponse.json({ error: "Invalid name" }, { status: 400 });
  }

  const rows = await sql`
    UPDATE projects
    SET name = ${name}
    WHERE id = ${id} AND clerk_user_id = ${userId}
    RETURNING id, name, created_at
  `;
  if (rows.length === 0) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  return NextResponse.json({
    project: {
      id: rows[0].id as string,
      name: rows[0].name as string,
      createdAt: rows[0].created_at as string,
    },
  });
}

/** Delete a project (sessions become unassigned; shortlist cascades away). */
export async function DELETE(_request: Request, context: RouteContext) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  const rows = await sql`
    DELETE FROM projects
    WHERE id = ${id} AND clerk_user_id = ${userId}
    RETURNING id
  `;
  if (rows.length === 0) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
