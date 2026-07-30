-- Implicit match preference signals + global ranking weight multipliers.
-- Used to gently learn which feature groups matter from non-top clicks/plays.

CREATE TABLE IF NOT EXISTS match_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_user_id text NOT NULL,
  client_upload_id uuid NOT NULL REFERENCES client_uploads (id) ON DELETE CASCADE,
  chosen_reference_id uuid NOT NULL REFERENCES reference_tracks (id) ON DELETE CASCADE,
  shown_order integer NOT NULL,
  chosen_rank integer NOT NULL,
  feature_group_deltas jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_match_feedback_upload
  ON match_feedback (client_upload_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ranking_weight_state (
  id integer PRIMARY KEY CHECK (id = 1),
  multipliers jsonb NOT NULL DEFAULT '{}'::jsonb,
  sample_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO ranking_weight_state (id, multipliers, sample_count)
VALUES (1, '{}'::jsonb, 0)
ON CONFLICT (id) DO NOTHING;
