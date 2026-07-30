import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isApprovedDeezerPreviewUrl } from "@/lib/deezer";

describe("isApprovedDeezerPreviewUrl", () => {
  it("accepts HTTPS Deezer CDN preview hosts", () => {
    assert.equal(
      isApprovedDeezerPreviewUrl(
        "https://cdns-preview-c.dzcdn.net/stream/c-abc123.mp3",
      ),
      true,
    );
    assert.equal(
      isApprovedDeezerPreviewUrl(
        "https://cdnt-preview.dzcdn.net/stream/c-abc123.mp3?hdnea=exp",
      ),
      true,
    );
  });

  it("rejects non-HTTPS, bad hosts, and malformed URLs", () => {
    assert.equal(
      isApprovedDeezerPreviewUrl(
        "http://cdns-preview-c.dzcdn.net/stream/c-abc123.mp3",
      ),
      false,
    );
    assert.equal(
      isApprovedDeezerPreviewUrl("https://evil.example/stream.mp3"),
      false,
    );
    assert.equal(
      isApprovedDeezerPreviewUrl(
        "https://dzcdn.net.evil.example/stream.mp3",
      ),
      false,
    );
    assert.equal(isApprovedDeezerPreviewUrl("not-a-url"), false);
  });
});
