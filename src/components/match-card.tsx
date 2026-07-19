"use client";

import { motion } from "motion/react";

import { ABPlayer } from "@/components/ab-player";
import { EqCurveGraph } from "@/components/eq-curve-graph";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { computeFeatureDeltas } from "@/lib/matching";
import { fadeInUp } from "@/lib/motion";
import type { FeatureVector } from "@/lib/types";

export interface MatchResult {
  id: string;
  itunesTrackId: number;
  title: string;
  artist: string;
  album: string | null;
  artworkUrl: string | null;
  genre: string;
  previewUrl: string;
  distanceScore: number;
  explanation: string;
  featureVector: FeatureVector;
}

interface MatchCardProps {
  match: MatchResult;
  clientFeatures: FeatureVector;
  clientPlaybackUrl: string | null;
}

function formatSigned(value: number, digits = 1, suffix = ""): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}${suffix}`;
}

/** Detail panel for the active carousel match — identity lives on the carousel. */
export function MatchCard({
  match,
  clientFeatures,
  clientPlaybackUrl,
}: MatchCardProps) {
  const deltas = computeFeatureDeltas(clientFeatures, match.featureVector);

  return (
    <motion.div
      key={match.id}
      variants={fadeInUp}
      initial="hidden"
      animate="visible"
    >
      <Card className="border-border bg-surface-1">
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-text-secondary">{match.explanation}</p>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs text-text-muted sm:grid-cols-4">
            <div className="flex justify-between gap-2 sm:block">
              <dt>Loudness</dt>
              <dd className="text-text-secondary">
                {formatSigned(deltas.loudnessLu, 1, " LU")}
              </dd>
            </div>
            <div className="flex justify-between gap-2 sm:block">
              <dt>Dynamics</dt>
              <dd className="text-text-secondary">
                {formatSigned(deltas.dynamicRangeDb, 1, " LU")}
              </dd>
            </div>
            <div className="flex justify-between gap-2 sm:block">
              <dt>PLR</dt>
              <dd className="text-text-secondary">
                {deltas.plrDb !== null
                  ? formatSigned(deltas.plrDb, 1, " dB")
                  : "—"}
              </dd>
            </div>
            <div className="flex justify-between gap-2 sm:block">
              <dt>Tempo</dt>
              <dd className="text-text-secondary">
                {formatSigned(deltas.tempoBpm, 0, " BPM")}
              </dd>
            </div>
          </dl>

          <EqCurveGraph
            client={clientFeatures}
            reference={match.featureVector}
          />
          <ABPlayer
            clientUrl={clientPlaybackUrl}
            referenceUrl={match.previewUrl}
          />
        </CardContent>
      </Card>
    </motion.div>
  );
}
