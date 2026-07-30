"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { motion } from "motion/react";
import { toast } from "sonner";

import type { MatchResult } from "@/components/match-card";
import { ProjectPicker } from "@/components/project-picker";
import { ReferencesLightbox } from "@/components/references-lightbox";
import { SaveReferenceButton } from "@/components/save-reference-button";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { openBuyCreditsDialog } from "@/components/credits-balance";
import { useAuthedFetch } from "@/hooks/use-authed-fetch";
import { readApiJson, usePromptSignIn } from "@/hooks/use-prompt-sign-in";
import { analyzeAudioFile } from "@/lib/analysis";
import { classifyDiscogsGenre } from "@/lib/discogs-genre";
import { encodeClipMp3 } from "@/lib/encode-clip";
import {
  MATCH_GENRES,
  discogsLabelToGenre,
  instrumentsFromDiscogsLabel,
  isMatchGenre,
  type MatchGenre,
} from "@/lib/genres";
import {
  rankBySonicSimilarity,
  type WeightPreset,
} from "@/lib/matching";
import { fadeInUp } from "@/lib/motion";
import type { FeatureVector } from "@/lib/types";

type Phase =
  | { step: "idle" }
  | { step: "analyzing" }
  | { step: "uploading" }
  | { step: "matching" }
  | {
      step: "done";
      uploadId: string;
      projectId: string | null;
      featureVector: FeatureVector;
      matches: MatchResult[];
      discoveryNote: string | null;
    };

export function UploadCard() {
  const { isLoaded: authLoaded, isSignedIn } = useAuth();
  const promptSignIn = usePromptSignIn();
  const authedFetch = useAuthedFetch();
  const [file, setFile] = useState<File | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  // Keeps the picker label correct when a project is assigned via the save dialog.
  const [knownProject, setKnownProject] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [weightPreset, setWeightPreset] = useState<WeightPreset>("balanced");
  const [genreOverride, setGenreOverride] = useState<MatchGenre | "">("");
  const [detectedGenre, setDetectedGenre] = useState<MatchGenre | null>(null);
  const [detectedLabel, setDetectedLabel] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ step: "idle" });
  const [activeIndex, setActiveIndex] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Derived, not state: an object URL for A/B playback of the local file.
  // The effect only handles revocation when the file changes/unmounts.
  const clientPlaybackUrl = useMemo(
    () => (file ? URL.createObjectURL(file) : null),
    [file],
  );
  useEffect(() => {
    return () => {
      if (clientPlaybackUrl) URL.revokeObjectURL(clientPlaybackUrl);
    };
  }, [clientPlaybackUrl]);

  const busy =
    phase.step === "analyzing" ||
    phase.step === "uploading" ||
    phase.step === "matching";

  // Re-rank the returned pool when the engineer switches weight preset —
  // no extra API round trip.
  const displayedMatches = useMemo(() => {
    if (phase.step !== "done") return [];
    if (weightPreset === "balanced") return phase.matches;
    return rankBySonicSimilarity(
      phase.featureVector,
      phase.matches.map((m) => ({ item: m, features: m.featureVector })),
      weightPreset,
    ).map((hit) => ({
      ...hit.item,
      distanceScore: hit.distance,
    }));
  }, [phase, weightPreset]);

  const safeActiveIndex =
    displayedMatches.length === 0
      ? 0
      : Math.min(activeIndex, displayedMatches.length - 1);

  function acceptFile(candidate: File | undefined) {
    if (!candidate) return;
    if (!candidate.type.startsWith("audio/")) {
      toast.error("That doesn't look like an audio file.");
      return;
    }
    setFile(candidate);
    setPhase({ step: "idle" });
    setWeightPreset("balanced");
    setGenreOverride("");
    setDetectedGenre(null);
    setDetectedLabel(null);
    setActiveIndex(0);
    setLightboxOpen(false);
  }

  async function handleAnalyze() {
    if (!file) return;
    // Soft gate: keep the file selected, open Clerk before any API/WASM work.
    if (!authLoaded) return;
    if (!isSignedIn) {
      promptSignIn();
      return;
    }

    try {
      // Drop previous matches immediately so old results never linger
      // while the new track is analyzing.
      setPhase({ step: "analyzing" });
      setWeightPreset("balanced");
      setActiveIndex(0);
      setLightboxOpen(false);

      // Discogs-EffNet in the browser — drives Deezer/iTunes search terms.
      let discogsLabel: string | null = null;
      let genre: MatchGenre | null =
        genreOverride && isMatchGenre(genreOverride) ? genreOverride : null;
      try {
        const tagged = await classifyDiscogsGenre(file);
        discogsLabel = tagged.discogsLabel;
        setDetectedLabel(tagged.discogsLabel);
        const mapped = tagged.discogsLabel
          ? discogsLabelToGenre(tagged.discogsLabel)
          : null;
        setDetectedGenre(mapped);
        if (!genre && mapped) genre = mapped;
      } catch (tagError) {
        console.warn("Discogs genre tagging failed:", tagError);
        toast.message(
          "Couldn’t auto-detect genre — pick one below if matching fails.",
        );
      }
      if (!genre) {
        throw new Error(
          "Pick a genre (auto-detect missed this track) and try again",
        );
      }

      const featureVector = await analyzeAudioFile(file);

      const clip = await encodeClipMp3(file).catch(() => {
        throw new Error("Couldn't prepare the audio clip");
      });

      setPhase({ step: "uploading" });
      const createResponse = await authedFetch("/api/uploads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: file.name.replace(/\.[^.]+$/, ""),
          contentType: "audio/mpeg",
          projectId,
        }),
      });
      const created = await readApiJson<{
        uploadId: string;
        projectId: string | null;
        uploadUrl: string | null;
      }>(createResponse);
      if (!created.ok) {
        if (created.unauthenticated) {
          promptSignIn();
          setPhase({ step: "idle" });
          return;
        }
        throw new Error(created.error);
      }
      const { uploadId, uploadUrl } = created.data;
      const sessionProjectId = created.data.projectId ?? projectId;

      // R2 may not be configured yet — analysis + matching still work.
      if (uploadUrl) {
        const putResponse = await fetch(uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": "audio/mpeg" },
          body: clip,
        });
        if (!putResponse.ok) {
          toast.message(
            "Couldn’t store the clip in R2 — matching continues with local playback.",
          );
        }
      }

      const patchResponse = await authedFetch(`/api/uploads/${uploadId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ featureVector }),
      });
      const patched = await readApiJson<{ ok?: boolean }>(patchResponse);
      if (!patched.ok) {
        if (patched.unauthenticated) {
          promptSignIn();
          setPhase({ step: "idle" });
          return;
        }
        throw new Error(patched.error || "Could not save analysis");
      }

      setPhase({ step: "matching" });
      const instruments = instrumentsFromDiscogsLabel(discogsLabel);
      const matchForm = new FormData();
      matchForm.append("uploadId", uploadId);
      matchForm.append("genre", genre);
      if (discogsLabel) matchForm.append("discogsLabel", discogsLabel);
      if (instruments.length > 0) {
        matchForm.append("instruments", instruments.join(","));
      }

      const matchResponse = await authedFetch("/api/match", {
        method: "POST",
        body: matchForm,
      });
      const matched = await readApiJson<{
        matches: MatchResult[];
        projectId?: string | null;
        discoveryNote: string | null;
      }>(matchResponse);
      if (!matched.ok) {
        if (matched.unauthenticated) {
          promptSignIn();
          setPhase({ step: "idle" });
          return;
        }
        if (
          matched.status === 402 ||
          matched.code === "INSUFFICIENT_CREDITS"
        ) {
          toast.error(matched.error || "You’re out of credits", {
            action: {
              label: "Buy credits",
              onClick: () => openBuyCreditsDialog(),
            },
          });
          setPhase({ step: "idle" });
          return;
        }
        throw new Error(matched.error);
      }
      const result = matched.data;

      setPhase({
        step: "done",
        uploadId,
        projectId: result.projectId ?? sessionProjectId,
        featureVector,
        matches: result.matches.map((match) => ({
          ...match,
          saved: match.saved ?? false,
        })),
        discoveryNote: result.discoveryNote,
      });
      setLightboxOpen(true);
    } catch (error) {
      setPhase({ step: "idle" });
      toast.error(
        error instanceof Error ? error.message : "Something went wrong",
      );
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <motion.div variants={fadeInUp} initial="hidden" animate="visible">
        <Card className="border-border bg-surface-1">
          <CardHeader>
            <CardTitle className="text-base">Upload client track</CardTitle>
            <CardDescription className="text-text-muted">
              WAV or AIFF preferred. We detect genre with Discogs-EffNet in your
              browser, search Deezer/iTunes, then rank by Essentia metering.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <button
              type="button"
              disabled={busy}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setIsDragging(false);
                acceptFile(event.dataTransfer.files[0]);
              }}
              className={`flex min-h-36 cursor-pointer items-center justify-center rounded-lg border border-dashed px-4 text-center text-sm transition-colors ${
                isDragging
                  ? "border-client bg-client-muted text-text-primary"
                  : "border-border bg-surface-0 text-text-muted hover:border-text-muted"
              }`}
            >
              {file ? (
                <span className="text-text-primary">{file.name}</span>
              ) : (
                "Drag & drop audio here, or click to browse"
              )}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*"
              className="hidden"
              onChange={(event) => acceptFile(event.target.files?.[0])}
            />

            <div className="flex flex-col gap-2">
              <label
                htmlFor="genre-override"
                className="text-xs font-medium text-text-muted"
              >
                Genre{" "}
                <span className="font-normal">
                  (auto-detected on analyze; override if needed)
                </span>
              </label>
              <select
                id="genre-override"
                disabled={busy}
                value={genreOverride}
                onChange={(event) => {
                  const value = event.target.value;
                  setGenreOverride(
                    value && isMatchGenre(value) ? value : "",
                  );
                }}
                className="h-9 rounded-md border border-border bg-surface-0 px-3 text-sm text-text-primary"
              >
                <option value="">
                  {detectedGenre
                    ? `Auto: ${detectedGenre}${
                        detectedLabel?.includes("---")
                          ? ` — ${detectedLabel.split("---").pop()}`
                          : ""
                      }`
                    : "Auto-detect from mix"}
                </option>
                {MATCH_GENRES.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
            </div>

            <ProjectPicker
              value={phase.step === "done" ? phase.projectId : projectId}
              knownOption={knownProject}
              onChange={(next) => {
                if (phase.step !== "done") {
                  setProjectId(next);
                  if (next === null || knownProject?.id !== next) {
                    setKnownProject(null);
                  }
                  return;
                }

                const uploadId = phase.uploadId;
                const previousProjectId = phase.projectId;
                const previousKnown = knownProject;

                setProjectId(next);
                if (next === null || knownProject?.id !== next) {
                  setKnownProject(null);
                }
                // Functional update so concurrent match toggles aren't clobbered.
                setPhase((current) =>
                  current.step === "done"
                    ? { ...current, projectId: next }
                    : current,
                );

                void authedFetch(`/api/sessions/${uploadId}`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ projectId: next }),
                })
                  .then((response) => {
                    if (!response.ok) {
                      throw new Error("Project assignment rejected");
                    }
                  })
                  .catch(() => {
                    setProjectId(previousProjectId);
                    setKnownProject(previousKnown);
                    setPhase((current) =>
                      current.step === "done"
                        ? { ...current, projectId: previousProjectId }
                        : current,
                    );
                    toast.error("Could not update project for this session");
                  });
              }}
              disabled={busy}
            />

            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  onClick={() => void handleAnalyze()}
                  disabled={!file || busy || !authLoaded}
                >
                  {phase.step === "analyzing"
                    ? "Analyzing…"
                    : phase.step === "uploading"
                      ? "Saving…"
                      : phase.step === "matching"
                        ? "Finding references…"
                        : "Analyze track"}
                </Button>
              </div>
              {authLoaded && !isSignedIn ? (
                <p className="text-xs text-text-muted">
                  Sign in to run the search — new accounts get 2 free credits.
                </p>
              ) : null}
            </div>

            {phase.step === "done" && (
              <p className="font-mono text-xs text-text-secondary">
                {phase.featureVector.integratedLoudnessLufs.toFixed(1)} LUFS ·{" "}
                {phase.featureVector.loudnessRangeDb.toFixed(1)} LU range
                {typeof phase.featureVector.plrDb === "number"
                  ? ` · ${phase.featureVector.plrDb.toFixed(1)} dB PLR`
                  : ""}{" "}
                · {Math.round(phase.featureVector.tempoBpm)} BPM
                {typeof phase.featureVector.onsetRate === "number"
                  ? ` · ${phase.featureVector.onsetRate.toFixed(1)} onsets/s`
                  : ""}
              </p>
            )}

            <div className="flex gap-4 text-xs">
              <span className="flex items-center gap-1.5 text-text-secondary">
                <span className="size-2 rounded-full bg-client" />
                Your track
              </span>
              <span className="flex items-center gap-1.5 text-text-secondary">
                <span className="size-2 rounded-full bg-reference" />
                Reference
              </span>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {phase.step === "done" && (
        <>
          <motion.div
            variants={fadeInUp}
            initial="hidden"
            animate="visible"
            className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex flex-col gap-1">
              <h2 className="text-lg font-semibold text-text-primary">
                {displayedMatches.length} reference
                {displayedMatches.length === 1 ? "" : "s"} ready
              </h2>
              {phase.discoveryNote && (
                <p className="text-sm text-text-muted">{phase.discoveryNote}</p>
              )}
            </div>
            <Button onClick={() => setLightboxOpen(true)}>
              View references
            </Button>
          </motion.div>

          <ReferencesLightbox
            open={lightboxOpen}
            onOpenChange={setLightboxOpen}
            matches={displayedMatches}
            activeIndex={safeActiveIndex}
            onActiveIndexChange={setActiveIndex}
            clientFeatures={phase.featureVector}
            clientPlaybackUrl={clientPlaybackUrl}
            weightPreset={weightPreset}
            onWeightPresetChange={(preset) => {
              setWeightPreset(preset);
              setActiveIndex(0);
            }}
            discoveryNote={phase.discoveryNote}
            renderSaveControl={(match) => (
              <SaveReferenceButton
                referenceTrackId={match.id}
                saved={Boolean(match.saved)}
                uploadId={phase.uploadId}
                projectId={phase.projectId}
                onProjectAssigned={(project) => {
                  setProjectId(project.id);
                  setKnownProject(project);
                  setPhase((current) =>
                    current.step === "done"
                      ? { ...current, projectId: project.id }
                      : current,
                  );
                }}
                onSavedChange={(saved) => {
                  setPhase((current) => {
                    if (current.step !== "done") return current;
                    return {
                      ...current,
                      matches: current.matches.map((item) =>
                        item.id === match.id ? { ...item, saved } : item,
                      ),
                    };
                  });
                }}
              />
            )}
          />
        </>
      )}
    </div>
  );
}
