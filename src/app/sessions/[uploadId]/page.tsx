import { Suspense } from "react";
import { auth } from "@clerk/nextjs/server";
import { notFound, redirect } from "next/navigation";

import { AppHeader } from "@/components/app-header";
import { PageShell } from "@/components/page-shell";
import { SessionResults } from "@/components/session-results";
import { sql } from "@/lib/db";
import { isFeatureVector } from "@/lib/feature-vector";
import type { FeatureVector } from "@/lib/types";

type PageProps = { params: Promise<{ uploadId: string }> };

export default async function SessionPage({ params }: PageProps) {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const { uploadId } = await params;

  const uploads = await sql`
    SELECT
      cu.id,
      cu.title,
      cu.feature_vector,
      cu.project_id,
      p.name AS project_name
    FROM client_uploads cu
    LEFT JOIN projects p ON p.id = cu.project_id
    WHERE cu.id = ${uploadId} AND cu.clerk_user_id = ${userId}
    LIMIT 1
  `;
  if (uploads.length === 0) notFound();

  const upload = uploads[0];
  const clientFeatures = upload.feature_vector as FeatureVector | null;
  if (!isFeatureVector(clientFeatures)) notFound();

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
    if (!isFeatureVector(row.feature_vector)) continue;
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
      featureVector: row.feature_vector,
      saved: savedIds.has(id),
    });
  }

  return (
    <>
      <AppHeader />
      <PageShell>
        <Suspense
          fallback={
            <p className="text-sm text-text-muted">Loading session…</p>
          }
        >
          <SessionResults
            uploadId={upload.id as string}
            title={upload.title as string}
            projectId={projectId}
            projectName={(upload.project_name as string | null) ?? null}
            clientFeatures={clientFeatures}
            matches={matches}
            discoveryNote={
              matches.length === 0
                ? "No stored matches for this session."
                : null
            }
          />
        </Suspense>
      </PageShell>
    </>
  );
}
