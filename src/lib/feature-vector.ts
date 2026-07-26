import type { FeatureVector } from "@/lib/types";

/** Narrow unknown JSON (from Neon jsonb) to a FeatureVector. */
export function isFeatureVector(value: unknown): value is FeatureVector {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.integratedLoudnessLufs === "number" &&
    typeof v.loudnessRangeDb === "number" &&
    typeof v.tempoBpm === "number" &&
    typeof v.stereoWidth === "number" &&
    Array.isArray(v.frequencyBandEnergies) &&
    v.frequencyBandEnergies.length === 7 &&
    v.frequencyBandEnergies.every((n) => typeof n === "number")
  );
}
