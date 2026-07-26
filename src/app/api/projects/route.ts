import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { sql } from "@/lib/db";

const MAX_NAME_LENGTH = 120;

/** List the signed-in user's projects (newest first). */
export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rows = await sql`
    SELECT
      p.id,
      p.name,
      p.created_at,
      (
        SELECT COUNT(*)::int
        FROM client_uploads cu
        WHERE cu.project_id = p.id
      ) AS session_count,
      (
        SELECT COUNT(*)::int
        FROM saved_references sr
        WHERE sr.project_id = p.id
      ) AS saved_count
    FROM projects p
    WHERE p.clerk_user_id = ${userId}
    ORDER BY p.created_at DESC
  `;

  return NextResponse.json({
    projects: rows.map((row) => ({
      id: row.id as string,
      name: row.name as string,
      createdAt: row.created_at as string,
      sessionCount: row.session_count as number,
      savedCount: row.saved_count as number,
    })),
  });
}

/** Create a named project (client job). */
export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as { name?: string };
  const name = body.name?.trim();
  if (!name || name.length > MAX_NAME_LENGTH) {
    return NextResponse.json({ error: "Invalid name" }, { status: 400 });
  }

  const [row] = await sql`
    INSERT INTO projects (clerk_user_id, name)
    VALUES (${userId}, ${name})
    RETURNING id, name, created_at
  `;

  return NextResponse.json({
    project: {
      id: row.id as string,
      name: row.name as string,
      createdAt: row.created_at as string,
      sessionCount: 0,
      savedCount: 0,
    },
  });
}
