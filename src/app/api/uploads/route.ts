import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

import { sql } from "@/lib/db";
import { presignUpload } from "@/lib/r2";

const ALLOWED_CONTENT_TYPES = new Set([
  "audio/wav",
  "audio/x-wav",
  "audio/aiff",
  "audio/x-aiff",
  "audio/mpeg",
  "audio/flac",
  "audio/x-flac",
  "audio/mp4",
]);

const MAX_TITLE_LENGTH = 200;

/**
 * Creates an upload record and returns a presigned R2 PUT URL.
 * The browser uploads the audio directly to R2, keeping large files
 * out of serverless request bodies.
 */
export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as {
    title?: string;
    contentType?: string;
    projectId?: string | null;
  };

  const title = body.title?.trim();
  if (!title || title.length > MAX_TITLE_LENGTH) {
    return NextResponse.json({ error: "Invalid title" }, { status: 400 });
  }
  if (!body.contentType || !ALLOWED_CONTENT_TYPES.has(body.contentType)) {
    return NextResponse.json(
      { error: "Unsupported audio format" },
      { status: 400 },
    );
  }

  let projectId: string | null = null;
  if (body.projectId) {
    const trimmed = body.projectId.trim();
    const owned = await sql`
      SELECT id FROM projects
      WHERE id = ${trimmed} AND clerk_user_id = ${userId}
      LIMIT 1
    `;
    if (owned.length === 0) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    projectId = trimmed;
  }

  const objectKey = `client-uploads/${userId}/${randomUUID()}`;
  const [row] = await sql`
    INSERT INTO client_uploads (clerk_user_id, r2_object_key, title, project_id)
    VALUES (${userId}, ${objectKey}, ${title}, ${projectId})
    RETURNING id, project_id
  `;

  // R2 is optional until the bucket/creds are configured — analysis +
  // matching still work with a local blob URL for A/B playback.
  let uploadUrl: string | null = null;
  try {
    uploadUrl = await presignUpload(objectKey, body.contentType);
  } catch {
    uploadUrl = null;
  }

  return NextResponse.json({
    uploadId: row.id as string,
    projectId: (row.project_id as string | null) ?? null,
    uploadUrl,
  });
}
