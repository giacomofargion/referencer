/**
 * Curated artist/label seed lists for scripts/seed-shelf.ts.
 *
 * Pure keyword search rewards whoever uploaded the most tracks with that
 * word in the title, not whoever's actually representative of the style —
 * seen directly in early seed runs, where a couple of prolific accounts
 * filled a large share of a shelf. Searching these names directly gives
 * well-known, genuinely representative tracks first crack at the shelf.
 *
 * Keyed by the same `discogsLabel` string used in seed-shelf.ts's
 * DEFAULT_STYLES ("Genre---Style"). A reasonable starting point, not
 * authoritative — easy to extend as the shelf grows to more styles.
 */
export const CURATED_ARTISTS: Record<string, string[]> = {
  "Electronic---Drum n Bass": [
    "Andy C",
    "Sub Focus",
    "Netsky",
    "Goldie",
    "Chase & Status",
    "Camo & Krooked",
  ],
  "Electronic---Deep House": [
    "Kerri Chandler",
    "Disclosure",
    "Bonobo",
    "Lane 8",
    "Black Coffee",
  ],
  "Electronic---Techno": [
    "Charlotte de Witte",
    "Adam Beyer",
    "Amelie Lens",
    "Richie Hawtin",
    "Ben Klock",
  ],
  "Electronic---Dubstep": [
    "Skrillex",
    "Flux Pavilion",
    "Rusko",
    "Benga",
    "Excision",
  ],
  "Electronic---Ambient": [
    "Brian Eno",
    "Tim Hecker",
    "Stars of the Lid",
    "Hammock",
    "Loscil",
  ],
};
