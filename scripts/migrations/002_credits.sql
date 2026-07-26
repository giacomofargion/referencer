-- Per-user credit wallet + append-only ledger for purchases and match spends.

CREATE TABLE IF NOT EXISTS user_credits (
  clerk_user_id text PRIMARY KEY,
  balance integer NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_user_id text NOT NULL,
  delta integer NOT NULL,
  reason text NOT NULL CHECK (
    reason IN ('purchase', 'match_spend', 'refund', 'grant')
  ),
  stripe_session_id text NULL UNIQUE,
  upload_id uuid NULL REFERENCES client_uploads (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_credit_ledger_user
  ON credit_ledger (clerk_user_id, created_at DESC);

-- At most one starter grant per user (race-safe with concurrent first requests).
CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_one_grant
  ON credit_ledger (clerk_user_id)
  WHERE reason = 'grant';
