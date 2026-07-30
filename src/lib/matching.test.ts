import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rankBySonicSimilarity } from "@/lib/matching";
import type { FeatureVector } from "@/lib/types";

function makeFeatures(overrides: Partial<FeatureVector> = {}): FeatureVector {
  return {
    integratedLoudnessLufs: -12,
    loudnessRangeDb: 6,
    frequencyBandEnergies: [0.1, 0.2, 0.15, 0.12, 0.1, 0.08, 0.05],
    tempoBpm: 120,
    stereoWidth: 0.5,
    plrDb: 8,
    onsetRate: 2,
    ...overrides,
  };
}

describe("rankBySonicSimilarity fixed-arity flatten", () => {
  it("tolerates short/long array features without NaN distances", () => {
    const query = makeFeatures({
      mfccMean: [1, 2, 3], // short — must pad, not shift later dims
      mfccStd: new Array(20).fill(0.1), // long — must truncate
      spectralContrast: [1, 2],
      hpcp: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 99],
      beatHistBpms: [128],
      beatHistWeights: [0.9, 0.1, 0.05],
    });
    const candidate = makeFeatures({
      mfccMean: new Array(13).fill(0),
      mfccStd: new Array(13).fill(0.2),
      spectralContrast: new Array(6).fill(0),
      hpcp: new Array(12).fill(0.08),
      beatHistBpms: [120, 60],
      beatHistWeights: [0.7, 0.3],
      tempoBpm: 121,
    });

    const ranked = rankBySonicSimilarity(query, [
      { item: "a", features: candidate },
    ]);

    assert.equal(ranked.length, 1);
    assert.ok(Number.isFinite(ranked[0].distance));
  });
});
