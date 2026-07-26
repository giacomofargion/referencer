import { auth } from "@clerk/nextjs/server";
import { notFound, redirect } from "next/navigation";

import { AppHeader } from "@/components/app-header";
import { ProjectDetail } from "@/app/projects/[id]/project-detail";
import { sql } from "@/lib/db";

type PageProps = { params: Promise<{ id: string }> };

export default async function ProjectPage({ params }: PageProps) {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const { id } = await params;
  const projects = await sql`
    SELECT id, name
    FROM projects
    WHERE id = ${id} AND clerk_user_id = ${userId}
    LIMIT 1
  `;
  if (projects.length === 0) notFound();

  const project = projects[0];

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
      rt.title,
      rt.artist,
      rt.artwork_url,
      rt.preview_url
    FROM saved_references sr
    JOIN reference_tracks rt ON rt.id = sr.reference_track_id
    WHERE sr.project_id = ${id}
    ORDER BY sr.created_at DESC
  `;

  return (
    <>
      <AppHeader />
      <main className="relative mx-auto flex w-full max-w-3xl flex-1 flex-col px-6 py-12">
        <ProjectDetail
          projectId={project.id as string}
          initialName={project.name as string}
          sessions={sessions.map((row) => ({
            id: row.id as string,
            title: row.title as string,
            createdAt: String(row.created_at),
            matchCount: row.match_count as number,
          }))}
          savedReferences={saved.map((row) => ({
            savedId: row.saved_id as string,
            note: (row.note as string | null) ?? null,
            savedAt: String(row.created_at),
            id: row.id as string,
            title: row.title as string,
            artist: row.artist as string,
            artworkUrl: (row.artwork_url as string | null) ?? null,
            previewUrl: row.preview_url as string,
          }))}
        />
      </main>
    </>
  );
}
