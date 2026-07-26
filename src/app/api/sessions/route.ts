import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { sql } from "@/lib/db";

/** History of match sessions (uploads) for the signed-in user. */
export async function GET(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const projectId = new URL(request.url).searchParams.get("projectId");

  const rows = projectId
    ? await sql`
        SELECT
          cu.id,
          cu.title,
          cu.created_at,
          cu.project_id,
          p.name AS project_name,
          (
            SELECT COUNT(*)::int
            FROM matches m
            WHERE m.client_upload_id = cu.id
          ) AS match_count
        FROM client_uploads cu
        LEFT JOIN projects p ON p.id = cu.project_id
        WHERE cu.clerk_user_id = ${userId}
          AND cu.project_id = ${projectId}
        ORDER BY cu.created_at DESC
      `
    : await sql`
        SELECT
          cu.id,
          cu.title,
          cu.created_at,
          cu.project_id,
          p.name AS project_name,
          (
            SELECT COUNT(*)::int
            FROM matches m
            WHERE m.client_upload_id = cu.id
          ) AS match_count
        FROM client_uploads cu
        LEFT JOIN projects p ON p.id = cu.project_id
        WHERE cu.clerk_user_id = ${userId}
        ORDER BY cu.created_at DESC
      `;

  return NextResponse.json({
    sessions: rows.map((row) => ({
      id: row.id as string,
      title: row.title as string,
      createdAt: row.created_at as string,
      projectId: (row.project_id as string | null) ?? null,
      projectName: (row.project_name as string | null) ?? null,
      matchCount: row.match_count as number,
    })),
  });
}
