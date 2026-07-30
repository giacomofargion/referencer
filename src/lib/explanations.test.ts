import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { explainMatch } from "@/lib/explanations";
import type { FeatureFingerprint, FeatureVector } from "@/lib/types";

function makeFeatures(overrides: Partial<FeatureVector> = {}): FeatureVector {
  return {
    integratedLoudnessLufs: -12,
    loudnessRangeDb: 6,
    frequencyBandEnergies: [0.1, 0.2, 0.15, 0.12, 0.1, 0.08, 0.05],
    tempoBpm: 120,
    stereoWidth: 0.5,
    plrDb: 8,
    onsetRate: 2,
    spectralCentroid: 2000,
    ...overrides,
  };
}

describe("explainMatch", () => {
  it("accepts bare FeatureVector inputs", () => {
    const client = makeFeatures();
    const reference = makeFeatures({
      tempoBpm: 121,
      integratedLoudnessLufs: -12.2,
      loudnessRangeDb: 6.2,
    });

    const text = explainMatch(client, reference);
    assert.match(text, /Similar tempo/i);
    assert.match(text, /comparable integrated loudness/i);
  });

  it("accepts StoredFingerprint (v2) inputs via aggregate features", () => {
    const clientAgg = makeFeatures({ tempoBpm: 100, integratedLoudnessLufs: -14 });
    const refAgg = makeFeatures({
      tempoBpm: 102,
      integratedLoudnessLufs: -10,
      loudnessRangeDb: 9,
    });

    const client: FeatureFingerprint = {
      version: 2,
      aggregate: clientAgg,
      // Distinct window values so a wrong unwrap would change the explanation.
      windows: [makeFeatures({ tempoBpm: 60, integratedLoudnessLufs: -30 })],
    };
    const reference: FeatureFingerprint = {
      version: 2,
      aggregate: refAgg,
      windows: [makeFeatures({ tempoBpm: 180, integratedLoudnessLufs: 0 })],
    };

    const text = explainMatch(client, reference);
    // Uses aggregate tempos (100/102), not the decoy window values (60/180).
    assert.match(text, /Similar tempo \(100 vs 102 BPM\)/i);
    assert.match(text, /4\.0 LU louder/i);
  });

  it("mixed FeatureVector + StoredFingerprint inputs still explain from aggregates", () => {
    const client = makeFeatures({ tempoBpm: 128, stereoWidth: 0.3 });
    const reference: FeatureFingerprint = {
      version: 2,
      aggregate: makeFeatures({ tempoBpm: 128, stereoWidth: 0.6 }),
      windows: [makeFeatures({ tempoBpm: 90, stereoWidth: 0.1 })],
    };

    const text = explainMatch(client, reference);
    assert.match(text, /Similar tempo/i);
    assert.match(text, /wider stereo image/i);
  });
});
