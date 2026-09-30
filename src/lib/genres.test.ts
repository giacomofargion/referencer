import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STRONG_FIT_GENRE_MAX } from "@/lib/matching";
import {
  closerQueryKind,
  combineGenreCloseness,
  deezerGenreId,
  genreLabelAffinity,
  hydrationOrder,
  isBareStyleTitle,
  isDrumAndBassTempo,
  isInGenreNeighborhood,
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
    assert.ok(relatedHit <= STRONG_FIT_GENRE_MAX);
    assert.equal(closerQueryKind("genre", "style"), "style");
  });

  it("maps a parent genre to a Deezer chart instead of a title search", () => {
    assert.equal(deezerGenreId("Rock"), 152);
    assert.equal(deezerGenreId("Electronic"), 113);
  });

  it("does not treat a far genre label as close", () => {
    const far = combineGenreCloseness(
      "style",
      genreLabelAffinity("Electronic", "Classical", "Electronic---Deep House"),
    );
    assert.ok(far > 0.3);
  });

  it("drops songs that are just the style word", () => {
    assert.equal(isBareStyleTitle("Glitch", "Glitch"), true);
    assert.equal(isBareStyleTitle("Glitch (Original Mix)", "glitch"), true);
    assert.equal(isBareStyleTitle("Glitch King", "Glitch"), false);
  });

  it("hydrates the requested style before the broad parent-genre chart", () => {
    // Style is the retrieval key; the parent chart is breadth filler.
    assert.equal(hydrationOrder("style") < hydrationOrder("genre"), true);
    assert.equal(
      hydrationOrder("style-instrument") < hydrationOrder("related"),
      true,
    );
  });

  it("treats half-time 86 as drum and bass tempo", () => {
    assert.equal(isDrumAndBassTempo(86.5), true);
    assert.equal(isDrumAndBassTempo(174), true);
    assert.equal(isDrumAndBassTempo(120), false);
  });

  it("recognizes a style phrase across & / and / n / apostrophe spellings", () => {
    // iTunes labels this genre "Jungle/Drum'n'bass" (no spaces around "n");
    // Deezer/Discogs spell it "Drum & Bass" or "Drum n Bass". All four must
    // read as the same style, or the catalog looks emptier than it is and
    // a real style match can't outrank the generic Electronic filler.
    const label = "Electronic---Drum n Bass";
    for (const platformGenre of [
      "Jungle/Drum'n'bass",
      "Drum & Bass",
      "Drum and Bass",
      "Drum n Bass",
    ]) {
      assert.equal(
        genreLabelAffinity("Electronic", platformGenre, label),
        0,
        `expected "${platformGenre}" to read as an exact style match`,
      );
    }
    // A short single-word alias must still not match inside an unrelated word.
    assert.equal(
      isInGenreNeighborhood("Pop", "Popular Science Podcast", null),
      false,
    );
  });
});
