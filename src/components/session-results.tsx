"use client";

import { useEffect, useMemo, useState } from "react";

import type { MatchResult } from "@/components/match-card";
import { ReferencesLightbox } from "@/components/references-lightbox";
import { SaveReferenceButton } from "@/components/save-reference-button";
import { Button } from "@/components/ui/button";
import {
  rankBySonicSimilarity,
  type WeightPreset,
} from "@/lib/matching";
import type { FeatureVector } from "@/lib/types";

export interface SessionResultsProps {
  uploadId: string;
  title: string;
  projectId: string | null;
  projectName: string | null;
  clientFeatures: FeatureVector;
  matches: MatchResult[];
  discoveryNote?: string | null;
}

/** Reopen a past match session with the same lightbox + save controls. */
export function SessionResults({
  uploadId,
  title,
  projectId: initialProjectId,
  projectName: initialProjectName,
  clientFeatures,
  matches: initialMatches,
  discoveryNote = null,
}: SessionResultsProps) {
  const [projectId, setProjectId] = useState(initialProjectId);
  const [projectName, setProjectName] = useState(initialProjectName);
  const [matches, setMatches] = useState(initialMatches);
  const [weightPreset, setWeightPreset] = useState<WeightPreset>("balanced");
  const [activeIndex, setActiveIndex] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(true);
  const [clientPlaybackUrl, setClientPlaybackUrl] = useState<string | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const response = await fetch(`/api/uploads/${uploadId}/audio`);
      if (!response.ok || cancelled) return;
      const data = (await response.json()) as { playbackUrl?: string };
      if (!cancelled && data.playbackUrl) {
        setClientPlaybackUrl(data.playbackUrl);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [uploadId]);

  const displayedMatches = useMemo(() => {
    if (weightPreset === "balanced") return matches;
    return rankBySonicSimilarity(
      clientFeatures,
      matches.map((m) => ({ item: m, features: m.featureVector })),
      weightPreset,
    ).map((hit) => ({
      ...hit.item,
      distanceScore: hit.distance,
    }));
  }, [matches, clientFeatures, weightPreset]);

  const safeActiveIndex =
    displayedMatches.length === 0
      ? 0
      : Math.min(activeIndex, displayedMatches.length - 1);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
            {title}
          </h1>
          <p className="text-sm text-text-muted">
            {projectName ? (
              <>
                Project{" "}
                <span className="text-text-secondary">{projectName}</span>
                {" · "}
              </>
            ) : (
              "Unassigned · "
            )}
            {matches.length} reference{matches.length === 1 ? "" : "s"}
            {!clientPlaybackUrl && (
              <span className="text-text-muted">
                {" "}
                · client A/B unavailable (file not in storage)
              </span>
            )}
          </p>
        </div>
        <Button onClick={() => setLightboxOpen(true)}>View references</Button>
      </div>

      <ReferencesLightbox
        open={lightboxOpen}
        onOpenChange={setLightboxOpen}
        matches={displayedMatches}
        activeIndex={safeActiveIndex}
        onActiveIndexChange={setActiveIndex}
        clientFeatures={clientFeatures}
        clientPlaybackUrl={clientPlaybackUrl}
        weightPreset={weightPreset}
        onWeightPresetChange={(preset) => {
          setWeightPreset(preset);
          setActiveIndex(0);
        }}
        discoveryNote={discoveryNote}
        renderSaveControl={(match) => (
          <SaveReferenceButton
            referenceTrackId={match.id}
            saved={Boolean(match.saved)}
            uploadId={uploadId}
            projectId={projectId}
            onProjectAssigned={(project) => {
              setProjectId(project.id);
              setProjectName(project.name);
            }}
            onSavedChange={(saved) => {
              setMatches((current) =>
                current.map((item) =>
                  item.id === match.id ? { ...item, saved } : item,
                ),
              );
            }}
          />
        )}
      />
    </div>
  );
}
