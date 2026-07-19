"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { toast } from "sonner";

import type { MatchResult } from "@/components/match-card";
import { ReferencesLightbox } from "@/components/references-lightbox";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { analyzeAudioFile } from "@/lib/analysis";
import { encodeClipMp3 } from "@/lib/encode-clip";
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
      featureVector: FeatureVector;
      matches: MatchResult[];
      discoveryNote: string | null;
    };

export function UploadCard() {
  const [file, setFile] = useState<File | null>(null);
  const [weightPreset, setWeightPreset] = useState<WeightPreset>("balanced");
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
    setActiveIndex(0);
    setLightboxOpen(false);
  }

  async function handleAnalyze() {
    if (!file) return;

    try {
      // Drop previous matches immediately so old results never linger
      // while the new track is analyzing.
      setPhase({ step: "analyzing" });
      setWeightPreset("balanced");
      setActiveIndex(0);
      setLightboxOpen(false);
      const featureVector = await analyzeAudioFile(file);

      setPhase({ step: "uploading" });
      const createResponse = await fetch("/api/uploads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: file.name.replace(/\.[^.]+$/, ""),
          contentType: file.type,
        }),
      });
      if (!createResponse.ok) {
        const { error } = await createResponse.json();
        throw new Error(error ?? "Could not create upload");
      }
      const { uploadId, uploadUrl } = (await createResponse.json()) as {
        uploadId: string;
        uploadUrl: string;
      };

      // R2 may not be configured yet — analysis + matching still work.
      if (uploadUrl) {
        const putResponse = await fetch(uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": file.type },
          body: file,
        });
        if (!putResponse.ok) {
          toast.message(
            "Couldn’t store the file in R2 — matching continues with local playback.",
          );
        }
      }

      const patchResponse = await fetch(`/api/uploads/${uploadId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ featureVector }),
      });
      if (!patchResponse.ok) {
        throw new Error("Could not save analysis");
      }

      setPhase({ step: "matching" });
      // Similarity search runs on a small 60s MP3 clip — the proxy caps
      // request bodies at 10MB, so never the raw WAV.
      const clip = await encodeClipMp3(file).catch(() => {
        throw new Error(
          "Couldn't prepare the audio clip for similarity search",
        );
      });
      const matchForm = new FormData();
      matchForm.append("uploadId", uploadId);
      matchForm.append("audio", clip, "clip.mp3");

      const matchResponse = await fetch("/api/match", {
        method: "POST",
        body: matchForm,
      });
      if (!matchResponse.ok) {
        const { error } = await matchResponse.json();
        throw new Error(error ?? "Matching failed");
      }

      const result = (await matchResponse.json()) as {
        matches: MatchResult[];
        discoveryNote: string | null;
      };

      setPhase({
        step: "done",
        uploadId,
        featureVector,
        matches: result.matches,
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
              WAV or AIFF preferred. The mix is matched against commercial
              releases by audio similarity — no tagging needed.
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

            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={handleAnalyze} disabled={!file || busy}>
                {phase.step === "analyzing"
                  ? "Analyzing…"
                  : phase.step === "uploading"
                    ? "Saving…"
                    : phase.step === "matching"
                      ? "Finding references…"
                      : "Analyze track"}
              </Button>
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
          />
        </>
      )}
    </div>
  );
}
