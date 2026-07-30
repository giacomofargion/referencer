import { FREQUENCY_BANDS, type FeatureVector } from "@/lib/types";
import {
  getAggregateFeatures,
  isFeatureFingerprint,
} from "@/lib/feature-vector";
import type { StoredFingerprint } from "@/lib/types";

const BAND_LABELS: Record<(typeof FREQUENCY_BANDS)[number]["name"], string> = {
  sub: "sub-bass",
  bass: "low end",
  "low-mid": "low-mids",
  mid: "mids",
  "high-mid": "high-mids",
  presence: "presence (4–8 kHz)",
  air: "air/top end",
};

function asFeatures(
  value: FeatureVector | StoredFingerprint,
): FeatureVector {
  // v2 fingerprint envelope → aggregate; bare FeatureVector is already usable.
  if (isFeatureFingerprint(value)) {
    return getAggregateFeatures(value);
  }
  return value;
}

/**
 * Deterministic plain-English explanation from feature deltas —
 * no LLM call, so it's free and fast.
 */
export function explainMatch(
  clientInput: FeatureVector | StoredFingerprint,
  referenceInput: FeatureVector | StoredFingerprint,
): string {
  const client = asFeatures(clientInput);
  const reference = asFeatures(referenceInput);
  const parts: string[] = [];

  const tempoDelta = Math.abs(client.tempoBpm - reference.tempoBpm);
  const halfDelta = Math.abs(client.tempoBpm - reference.tempoBpm / 2);
  const doubleDelta = Math.abs(client.tempoBpm - reference.tempoBpm * 2);
  const closestTempo = Math.min(tempoDelta, halfDelta, doubleDelta);

  if (closestTempo <= 4) {
    parts.push(
      `Similar tempo (${Math.round(client.tempoBpm)} vs ${Math.round(reference.tempoBpm)} BPM)`,
    );
  } else if (closestTempo <= 12) {
    parts.push(
      `Nearby tempo (${Math.round(client.tempoBpm)} vs ${Math.round(reference.tempoBpm)} BPM)`,
    );
  }

  const loudDelta =
    reference.integratedLoudnessLufs - client.integratedLoudnessLufs;
  if (Math.abs(loudDelta) <= 1.5) {
    parts.push("comparable integrated loudness");
  } else if (loudDelta > 0) {
    parts.push(
      `this reference is about ${loudDelta.toFixed(1)} LU louder — a guide for how far you might push level`,
    );
  } else {
    parts.push(
      `this reference sits about ${Math.abs(loudDelta).toFixed(1)} LU quieter — useful if you're aiming for more headroom`,
    );
  }

  const rangeDelta = reference.loudnessRangeDb - client.loudnessRangeDb;
  if (Math.abs(rangeDelta) <= 1) {
    parts.push("similar dynamic range");
  } else if (rangeDelta > 1.5) {
    parts.push(
      "more dynamic range — treat as a cue to ease off compression slightly",
    );
  } else if (rangeDelta < -1.5) {
    parts.push(
      "tighter dynamics — a reference for denser, more controlled leveling",
    );
  }

  if (
    typeof client.plrDb === "number" &&
    typeof reference.plrDb === "number"
  ) {
    const plrDelta = reference.plrDb - client.plrDb;
    if (Math.abs(plrDelta) <= 1.5) {
      parts.push("similar peak-to-loudness ratio");
    } else if (plrDelta > 1.5) {
      parts.push(
        "more headroom / punch (higher PLR) — a cue to leave more transient life",
      );
    } else {
      parts.push(
        "denser / more limited (lower PLR) — a cue for how hard you might push limiting",
      );
    }
  }

  if (
    typeof client.onsetRate === "number" &&
    typeof reference.onsetRate === "number"
  ) {
    const onsetDelta = reference.onsetRate - client.onsetRate;
    if (Math.abs(onsetDelta) > 0.8) {
      parts.push(
        onsetDelta > 0
          ? "busier rhythmic density"
          : "sparser rhythmic density",
      );
    }
  }

  if (
    typeof client.spectralCentroid === "number" &&
    typeof reference.spectralCentroid === "number"
  ) {
    const brightDelta = reference.spectralCentroid - client.spectralCentroid;
    if (Math.abs(brightDelta) > 400) {
      parts.push(
        brightDelta > 0
          ? "brighter overall tone"
          : "darker overall tone",
      );
    }
  }

  const bandNotes = similarBands(client, reference);
  if (bandNotes.length > 0) {
    parts.push(`similar ${bandNotes.join(" and ")}`);
  }

  const widthDelta = reference.stereoWidth - client.stereoWidth;
  if (Math.abs(widthDelta) > 0.12) {
    parts.push(
      widthDelta > 0
        ? "wider stereo image than your track"
        : "narrower stereo image than your track",
    );
  }

  if (parts.length === 0) {
    return "Closest overall sonic match in the current reference pool.";
  }

  const [first, ...rest] = parts;
  const sentence =
    first.charAt(0).toUpperCase() +
    first.slice(1) +
    (rest.length ? `; ${rest.join("; ")}` : "") +
    ".";
  return sentence;
}

function similarBands(client: FeatureVector, reference: FeatureVector): string[] {
  const deltas = FREQUENCY_BANDS.map((band, i) => ({
    name: band.name,
    delta: Math.abs(
      (client.frequencyBandEnergies[i] ?? 0) -
        (reference.frequencyBandEnergies[i] ?? 0),
    ),
    energy:
      ((client.frequencyBandEnergies[i] ?? 0) +
        (reference.frequencyBandEnergies[i] ?? 0)) /
      2,
  }));

  return deltas
    .filter((d) => d.delta < 0.04 && d.energy > 0.05)
    .sort((a, b) => b.energy - a.energy)
    .slice(0, 2)
    .map((d) => BAND_LABELS[d.name]);
}
