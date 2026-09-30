-- Genre-scope ranking_weight_state; warm-start each genre from the old
-- global row's learned multipliers but reset per-genre confidence to zero.
-- See src/lib/learned-weights.ts (learningRate / HALF_LIFE_SAMPLES).
-- NOTE: this genre list must stay in sync with MATCH_GENRES in
-- src/lib/genres.ts — update both together if that list ever changes.

ALTER TABLE ranking_weight_state RENAME TO ranking_weight_state_legacy;

CREATE TABLE ranking_weight_state (
  genre text PRIMARY KEY CHECK (genre IN (
    'Electronic','Rock','Pop','Hip-Hop','R&B','Jazz','Folk','Country','Blues','Classical'
  )),
  multipliers jsonb NOT NULL DEFAULT '{}'::jsonb,
  sample_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO ranking_weight_state (genre, multipliers, sample_count)
SELECT g, COALESCE(legacy.multipliers, '{}'::jsonb), 0
FROM unnest(ARRAY[
  'Electronic','Rock','Pop','Hip-Hop','R&B','Jazz','Folk','Country','Blues','Classical'
]) AS g
LEFT JOIN ranking_weight_state_legacy legacy ON legacy.id = 1
ON CONFLICT (genre) DO NOTHING;

-- Per-event audit log: distinguish engage / save / reject, and denormalize
-- genre so ops queries don't need a join.
ALTER TABLE match_feedback
  ADD COLUMN source text NOT NULL DEFAULT 'engage' CHECK (source IN ('engage','save','reject')),
  ADD COLUMN genre text;
