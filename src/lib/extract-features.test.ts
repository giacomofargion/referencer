import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractFeatures } from "@/lib/extract-features";

function sine(sampleRate: number, seconds: number, freq: number, amp: number) {
  const n = Math.floor(sampleRate * seconds);
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    data[i] = amp * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  }
  return data;
}

describe("EBU loudness sample rate", () => {
  it("measures a 96 kHz tone at the same loudness as 48 kHz", () => {
    const tone48 = sine(48000, 4, 997, 1);
    const tone96 = sine(96000, 4, 997, 1);
    const at48 = extractFeatures(tone48, tone48, 48000).integratedLoudnessLufs;
    const at96 = extractFeatures(tone96, tone96, 96000).integratedLoudnessLufs;

    assert.ok(at48 > -1 && at48 < 1, `48 kHz sine should be near 0 LUFS, got ${at48}`);
    assert.ok(
      Math.abs(at96 - at48) < 0.15,
      `96 kHz fell off the 48 kHz reading (${at48}); got ${at96}`,
    );
  });
});
