import { FREQUENCY_BANDS, type FeatureVector } from "@/lib/types";

/** Absolute group distances for click-feedback weight learning. */
export function groupAbsDeltas(
  client: FeatureVector,
  reference: FeatureVector,
): Record<string, number> {
  const bandDelta =
    FREQUENCY_BANDS.reduce((sum, _, i) => {
      return (
        sum +
        Math.abs(
          (client.frequencyBandEnergies[i] ?? 0) -
            (reference.frequencyBandEnergies[i] ?? 0),
        )
      );
    }, 0) / FREQUENCY_BANDS.length;

  const mfccDelta =
    client.mfccMean && reference.mfccMean
      ? client.mfccMean.reduce(
          (s, v, i) => s + Math.abs(v - (reference.mfccMean?.[i] ?? 0)),
          0,
        ) / client.mfccMean.length
      : 0;

  return {
    loudness: Math.abs(
      client.integratedLoudnessLufs - reference.integratedLoudnessLufs,
    ),
    dynamicRange: Math.abs(client.loudnessRangeDb - reference.loudnessRangeDb),
    plr:
      typeof client.plrDb === "number" && typeof reference.plrDb === "number"
        ? Math.abs(client.plrDb - reference.plrDb)
        : 0,
    tempo: Math.abs(client.tempoBpm - reference.tempoBpm),
    onsets:
      typeof client.onsetRate === "number" &&
      typeof reference.onsetRate === "number"
        ? Math.abs(client.onsetRate - reference.onsetRate)
        : 0,
    stereoWidth: Math.abs(client.stereoWidth - reference.stereoWidth),
    band: bandDelta,
    timbre:
      mfccDelta +
      (typeof client.spectralCentroid === "number" &&
      typeof reference.spectralCentroid === "number"
        ? Math.abs(client.spectralCentroid - reference.spectralCentroid) / 5000
        : 0),
    chroma:
      client.hpcp && reference.hpcp
        ? client.hpcp.reduce(
            (s, v, i) => s + Math.abs(v - (reference.hpcp?.[i] ?? 0)),
            0,
          ) / client.hpcp.length
        : 0,
    rhythm:
      typeof client.spectralFlux === "number" &&
      typeof reference.spectralFlux === "number"
        ? Math.abs(client.spectralFlux - reference.spectralFlux)
        : 0,
    dynamicsExt:
      typeof client.dynamicComplexity === "number" &&
      typeof reference.dynamicComplexity === "number"
        ? Math.abs(client.dynamicComplexity - reference.dynamicComplexity)
        : 0,
  };
}
