import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildFingerprint,
  getFeatureWindows,
  getMatchWindows,
} from "@/lib/feature-vector";
import type { FeatureVector } from "@/lib/types";

function makeFeatures(overrides: Partial<FeatureVector> = {}): FeatureVector {
  return {
    integratedLoudnessLufs: -14,
    loudnessRangeDb: 6,
    frequencyBandEnergies: [0.08, 0.22, 0.18, 0.2, 0.16, 0.1, 0.06],
    tempoBpm: 124,
    stereoWidth: 0.45,
    ...overrides,
  };
}

describe("getMatchWindows", () => {
  it("prefers the short representative slice over the full-track windows", () => {
    const fullTrack = [
      makeFeatures({ tempoBpm: 100 }), // intro
      makeFeatures({ tempoBpm: 110 }),
      makeFeatures({ tempoBpm: 120 }),
      makeFeatures({ tempoBpm: 130 }),
      makeFeatures({ tempoBpm: 140 }), // outro
    ];
    const hookSlice = [makeFeatures({ tempoBpm: 125 })];
    const fp = buildFingerprint(fullTrack, undefined, hookSlice);

    assert.deepEqual(getMatchWindows(fp), hookSlice);
    // The full-track windows are still there for whole-mix UI stats.
    assert.deepEqual(getFeatureWindows(fp), fullTrack);
  });

  it("falls back to the full windows when matchWindows is absent", () => {
    // References (already a short preview) and fingerprints analyzed before
    // matchWindows existed both rely on this fallback.
    const windows = [makeFeatures(), makeFeatures({ tempoBpm: 128 })];
    const fp = buildFingerprint(windows);

    assert.deepEqual(getMatchWindows(fp), windows);
  });

  it("falls back to the bare vector for a v1 (pre-fingerprint) row", () => {
    const v1 = makeFeatures();
    assert.deepEqual(getMatchWindows(v1), [v1]);
  });
});
