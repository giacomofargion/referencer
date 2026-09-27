import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_GENRE_CLOSENESS } from "@/lib/matching";
import {
  closerQueryKind,
  combineGenreCloseness,
  genreLabelAffinity,
  searchQueriesForDiscovery,
} from "@/lib/genres";

describe("genre closeness", () => {
  it("searches the Discogs style before the parent genre", () => {
    const queries = searchQueriesForDiscovery({
      genre: "Electronic",
      discogsLabel: "Electronic---Deep House",
      instruments: ["synth"],
    });
    assert.deepEqual(
      queries.map((entry) => entry.kind),
      ["style", "style-instrument", "genre"],
    );
    assert.equal(queries[0]?.query, "Deep House");
  });

  it("keeps a style-search hit closer than a parent-genre hit", () => {
    const styleHit = combineGenreCloseness(
      "style",
      genreLabelAffinity("Electronic", "Dance", "Electronic---Deep House"),
    );
    const parentHit = combineGenreCloseness(
      "genre",
      genreLabelAffinity("Electronic", "Electronic", "Electronic---Deep House"),
    );
    const relatedHit = combineGenreCloseness(
      "related",
      genreLabelAffinity("Hip-Hop", "R&B", null),
    );

    assert.ok(styleHit < parentHit);
    assert.ok(parentHit < relatedHit);
    // A genuinely similar genre can still clear the bar when the tone does.
    assert.ok(relatedHit <= MAX_GENRE_CLOSENESS);
    assert.equal(closerQueryKind("genre", "style"), "style");
  });

  it("does not treat a far genre label as close", () => {
    const far = combineGenreCloseness(
      "style",
      genreLabelAffinity("Electronic", "Classical", "Electronic---Deep House"),
    );
    assert.ok(far > 0.3);
  });
});
