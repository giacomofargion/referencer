import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isStrongReferenceFit,
  rankReferences,
  sonicDistance,
  STRONG_FIT_GENRE_MAX,
  STRONG_FIT_SONIC_MAX,
  WEIGHT_PRESETS,
} from "@/lib/matching";
import type { FeatureVector } from "@/lib/types";

function makeFeatures(overrides: Partial<FeatureVector> = {}): FeatureVector {
  return {
    integratedLoudnessLufs: -14,
    loudnessRangeDb: 6,
    frequencyBandEnergies: [0.08, 0.22, 0.18, 0.2, 0.16, 0.1, 0.06],
    tempoBpm: 124,
    stereoWidth: 0.45,
    plrDb: 8,
    onsetRate: 2.1,
    ...overrides,
  };
}

describe("reference fit", () => {
  it("keeps a nearer genre ahead of a tone twin from a broader genre", () => {
    const client = makeFeatures();
    const styleMatch = makeFeatures({
      // Same record, a step brighter — still a usable reference.
      frequencyBandEnergies: [0.06, 0.18, 0.16, 0.2, 0.18, 0.14, 0.08],
      tempoBpm: 126,
    });
    const toneTwin = makeFeatures();

    const ranked = rankReferences(client, [
      { item: "broader-genre", features: toneTwin, genreCloseness: 0.58 },
      { item: "requested-style", features: styleMatch, genreCloseness: 0.18 },
    ]);

    assert.equal(ranked[0]?.item, "requested-style");
    assert.ok(ranked[0].distance < ranked[1].distance);
  });

  it("does not call a far genre a strong fit even when the tone is identical", () => {
    const client = makeFeatures();
    const sonic = sonicDistance(client, client, WEIGHT_PRESETS.balanced);
    assert.ok(sonic < 0.05);
    assert.equal(isStrongReferenceFit(sonic, 0.9), false);
    assert.ok(0.9 > STRONG_FIT_GENRE_MAX);
  });

  it("keeps a louder commercial master when the tone still matches", () => {
    const client = makeFeatures({
      integratedLoudnessLufs: -18,
      plrDb: 12,
      loudnessRangeDb: 8,
    });
    const master = makeFeatures({
      integratedLoudnessLufs: -9,
      plrDb: 7,
      loudnessRangeDb: 4,
    });
    const sonic = sonicDistance(client, master, WEIGHT_PRESETS.balanced);
    assert.equal(isStrongReferenceFit(sonic, 0.18), true);
  });

  it("drops a different tonal balance even in the requested style", () => {
    const client = makeFeatures();
    const otherRecord = makeFeatures({
      frequencyBandEnergies: [0.02, 0.04, 0.06, 0.08, 0.1, 0.2, 0.5],
    });
    const sonic = sonicDistance(
      client,
      otherRecord,
      WEIGHT_PRESETS.balanced,
    );
    assert.ok(
      sonic > STRONG_FIT_SONIC_MAX,
      `expected a different curve to miss the tone bar, got ${sonic}`,
    );
    assert.equal(isStrongReferenceFit(sonic, 0), false);
  });

  it("still returns the closest in-genre reference when nothing is a strong fit", () => {
    // The old code gated the result list on this cap and, when nothing
    // cleared it, reached into other genres for a tone twin. Ranking must
    // never drop a weak-but-in-genre hit or leave the candidate pool.
    const client = makeFeatures();
    const near = makeFeatures({
      frequencyBandEnergies: [0.02, 0.04, 0.06, 0.08, 0.1, 0.2, 0.5],
    });
    const farGenre = makeFeatures();
    const ranked = rankReferences(client, [
      { item: "near-style", features: near, genreCloseness: 0.18 },
      { item: "far-genre", features: farGenre, genreCloseness: 0.9 },
    ]);
    const shortlist = ranked.slice(0, 8);
    assert.deepEqual(
      shortlist.map((hit) => hit.item),
      ["near-style", "far-genre"],
    );
    assert.equal(
      isStrongReferenceFit(shortlist[0].sonicDistance, shortlist[0].genreCloseness),
      false,
    );
  });

  it("keeps a nearer genre ahead of a better-sounding but far-genre candidate", () => {
    // Genre closeness is part of the published score, so a pool that mixes
    // genres (e.g. a broad parent-genre catalog fallback) still sorts the
    // requested style first even when the far-genre tone is a closer match.
    const client = makeFeatures();
    const inGenre = makeFeatures({
      frequencyBandEnergies: [0.06, 0.18, 0.16, 0.2, 0.18, 0.14, 0.08],
    });
    const farGenreCloserTone = makeFeatures();
    const ranked = rankReferences(client, [
      { item: "far-genre-close-tone", features: farGenreCloserTone, genreCloseness: 0.9 },
      { item: "in-genre", features: inGenre, genreCloseness: 0.18 },
    ]);
    assert.equal(ranked[0]?.item, "in-genre");
  });

  it("tolerates short and long optional arrays without NaN", () => {
    const query = makeFeatures({
      mfccMean: [1, 2, 3],
      mfccStd: new Array(20).fill(0.1),
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
    });

    const ranked = rankReferences(query, [
      { item: "a", features: candidate, genreCloseness: 0.1 },
    ]);
    assert.equal(ranked.length, 1);
    assert.ok(Number.isFinite(ranked[0].distance));
    assert.ok(Number.isFinite(ranked[0].sonicDistance));
  });
});
