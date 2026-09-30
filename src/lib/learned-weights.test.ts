import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyStaleDecay,
  computeNudgedMultipliers,
  decayFactor,
  learningRate,
} from "@/lib/learned-weights";

describe("learningRate", () => {
  it("shrinks monotonically as sample count grows", () => {
    const r0 = learningRate(0);
    const r20 = learningRate(20);
    const r100 = learningRate(100);
    assert.ok(r0 > r20);
    assert.ok(r20 > r100);
  });

  it("matches the closed form at known sample points", () => {
    assert.ok(Math.abs(learningRate(0) - 0.05) < 1e-9);
    assert.ok(Math.abs(learningRate(20) - 0.025) < 1e-9);
    assert.ok(Math.abs(learningRate(100) - 0.05 / 6) < 1e-9);
  });
});

describe("decayFactor", () => {
  it("is 1 inside the grace window", () => {
    assert.equal(decayFactor(0), 1);
    assert.equal(decayFactor(14), 1);
  });

  it("is 0 past grace + decay window", () => {
    assert.equal(decayFactor(14 + 60), 0);
    assert.equal(decayFactor(1000), 0);
  });

  it("is linear between the grace and decay window", () => {
    const mid = decayFactor(14 + 30);
    assert.ok(Math.abs(mid - 0.5) < 1e-9);
  });
});

describe("applyStaleDecay", () => {
  it("leaves a multiplier untouched within the grace period", () => {
    const updatedAt = new Date("2026-01-01T00:00:00Z");
    const now = new Date("2026-01-10T00:00:00Z");
    const result = applyStaleDecay({ loudness: 1.3 }, updatedAt, now);
    assert.equal(result.loudness, 1.3);
  });

  it("pulls a clamped multiplier measurably back toward 1.0 after long dormancy", () => {
    const updatedAt = new Date("2026-01-01T00:00:00Z");
    const now = new Date("2026-04-01T00:00:00Z");
    const result = applyStaleDecay({ loudness: 1.3 }, updatedAt, now);
    assert.ok(result.loudness !== undefined);
    assert.ok(result.loudness! < 1.3);
    assert.ok(result.loudness! >= 1);
  });
});

describe("computeNudgedMultipliers", () => {
  it("moves a multiplier further for a save than an engage at the same sample count", () => {
    const engage = computeNudgedMultipliers({
      current: {},
      sampleCount: 0,
      chosenCloserGroups: ["loudness"],
      skippedCloserGroups: [],
      source: "engage",
    });
    const save = computeNudgedMultipliers({
      current: {},
      sampleCount: 0,
      chosenCloserGroups: ["loudness"],
      skippedCloserGroups: [],
      source: "save",
    });
    assert.ok(save.loudness! > engage.loudness!);
  });

  it("a reject only ever demotes, never promotes", () => {
    const engageBaseline = computeNudgedMultipliers({
      current: {},
      sampleCount: 0,
      chosenCloserGroups: ["loudness"],
      skippedCloserGroups: [],
      source: "engage",
    });
    const rejected = computeNudgedMultipliers({
      current: {},
      sampleCount: 0,
      chosenCloserGroups: ["loudness"],
      skippedCloserGroups: [],
      source: "reject",
    });
    // chosenCloserGroups is demoted on reject, not promoted.
    assert.ok(rejected.loudness! < 1);
    const engageStep = engageBaseline.loudness! - 1;
    const rejectStep = 1 - rejected.loudness!;
    assert.ok(Math.abs(rejectStep - 2 * engageStep) < 1e-6);
  });

  it("keeps every multiplier within [0.7, 1.3] across repeated nudges", () => {
    let current = {};
    for (let i = 0; i < 200; i++) {
      current = computeNudgedMultipliers({
        current,
        sampleCount: i,
        chosenCloserGroups: ["band"],
        skippedCloserGroups: [],
        source: i % 2 === 0 ? "save" : "reject",
      });
    }
    for (const value of Object.values(current)) {
      assert.ok(typeof value === "number");
      assert.ok(value! >= 0.7 && value! <= 1.3);
    }
  });

  it("produces independent results with no shared mutation across two starting states", () => {
    const a = { loudness: 1.1 };
    const b = { loudness: 1.1 };
    const nextA = computeNudgedMultipliers({
      current: a,
      sampleCount: 5,
      chosenCloserGroups: ["loudness"],
      skippedCloserGroups: [],
      source: "engage",
    });
    const nextB = computeNudgedMultipliers({
      current: b,
      sampleCount: 5,
      chosenCloserGroups: [],
      skippedCloserGroups: ["loudness"],
      source: "engage",
    });
    assert.equal(a.loudness, 1.1);
    assert.equal(b.loudness, 1.1);
    assert.notEqual(nextA.loudness, nextB.loudness);
  });
});
