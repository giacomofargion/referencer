import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { sql } from "@/lib/db";
import {
  getAggregateFeatures,
  isStoredFingerprint,
} from "@/lib/feature-vector";
import { isEphemeralPreviewUrl, lookupItunesTracks } from "@/lib/itunes";
import { isUuid } from "@/lib/ids";
import { refreshEphemeralPreviewUrls } from "@/lib/refresh-previews";
import type { StoredFingerprint } from "@/lib/types";

type RouteContext = { params: Promise<{ uploadId: string }> };

/** Reopen a past session: features, ranked matches, project + saved flags. */
export async function GET(_request: Request, context: RouteContext) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { uploadId } = await context.params;

  const uploads = await sql`
    SELECT
      cu.id,
      cu.title,
      cu.feature_vector,
      cu.created_at,
      cu.project_id,
      p.name AS project_name
    FROM client_uploads cu
    LEFT JOIN projects p ON p.id = cu.project_id
    WHERE cu.id = ${uploadId} AND cu.clerk_user_id = ${userId}
    LIMIT 1
  `;
  if (uploads.length === 0) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const upload = uploads[0];
  const stored = upload.feature_vector as StoredFingerprint | null;
  if (!isStoredFingerprint(stored)) {
    return NextResponse.json(
      { error: "Session has no analysis yet" },
      { status: 400 },
    );
  }
  const clientFeatures = getAggregateFeatures(stored);

  const projectId = (upload.project_id as string | null) ?? null;

  let savedIds = new Set<string>();
  if (projectId) {
    const savedRows = await sql`
      SELECT reference_track_id
      FROM saved_references
      WHERE project_id = ${projectId}
    `;
    savedIds = new Set(
      savedRows.map((row) => row.reference_track_id as string),
    );
  }

  const matchRows = await sql`
    SELECT
      rt.id,
      rt.itunes_track_id,
      rt.title,
      rt.artist,
      rt.album,
      rt.artwork_url,
      rt.genre,
      rt.preview_url,
      rt.preview_start_sec,
      rt.feature_vector,
      m.distance_score,
      m.explanation_text
    FROM matches m
    JOIN reference_tracks rt ON rt.id = m.reference_track_id
    WHERE m.client_upload_id = ${uploadId}
      AND m.clerk_user_id = ${userId}
    ORDER BY m.distance_score ASC, m.created_at ASC
  `;

  const matches = [];
  for (const row of matchRows) {
    if (!isStoredFingerprint(row.feature_vector)) continue;
    const id = row.id as string;
    matches.push({
      id,
      itunesTrackId: Number(row.itunes_track_id),
      title: row.title as string,
      artist: row.artist as string,
      album: (row.album as string | null) ?? null,
      artworkUrl: (row.artwork_url as string | null) ?? null,
      genre: row.genre as string,
      previewUrl: row.preview_url as string,
      previewStartSec:
        row.preview_start_sec == null ? null : Number(row.preview_start_sec),
      distanceScore: Number(row.distance_score),
      explanation: row.explanation_text as string,
      featureVector: getAggregateFeatures(
        row.feature_vector as StoredFingerprint,
      ),
      saved: savedIds.has(id),
    });
  }

  await refreshEphemeralPreviewUrls(matches);

  return NextResponse.json({
    session: {
      id: upload.id as string,
      title: upload.title as string,
      createdAt: upload.created_at as string,
      projectId,
      projectName: (upload.project_name as string | null) ?? null,
      clientFeatures,
      matches,
    },
  });
}

/** Assign or unassign this session to a project. */
export async function PATCH(request: Request, context: RouteContext) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { uploadId } = await context.params;
  const body = (await request.json()) as { projectId?: string | null };

  let projectId: string | null = null;
  if (body.projectId !== undefined && body.projectId !== null) {
    const trimmed = String(body.projectId).trim();
    if (!trimmed || !isUuid(trimmed)) {
      return NextResponse.json({ error: "Invalid projectId" }, { status: 400 });
    }
    const owned = await sql`
      SELECT id FROM projects
      WHERE id = ${trimmed} AND clerk_user_id = ${userId}
      LIMIT 1
    `;
    if (owned.length === 0) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    projectId = trimmed;
  } else if (body.projectId === null) {
    projectId = null;
  } else {
    return NextResponse.json(
      { error: "projectId required (string or null)" },
      { status: 400 },
    );
  }

  const rows = await sql`
    UPDATE client_uploads
    SET project_id = ${projectId}
    WHERE id = ${uploadId} AND clerk_user_id = ${userId}
    RETURNING id, project_id
  `;
  if (rows.length === 0) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  let projectName: string | null = null;
  if (projectId) {
    const projects = await sql`
      SELECT name FROM projects WHERE id = ${projectId} LIMIT 1
    `;
    projectName = (projects[0]?.name as string | null) ?? null;
  }

  return NextResponse.json({
    session: {
      id: rows[0].id as string,
      projectId: (rows[0].project_id as string | null) ?? null,
      projectName,
    },
  });
}
