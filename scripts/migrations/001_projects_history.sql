-- Projects (client jobs), session assignment, and saved reference shortlists.

CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_user_id text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_projects_user
  ON projects (clerk_user_id, created_at DESC);

ALTER TABLE client_uploads
  ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES projects (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_client_uploads_project
  ON client_uploads (project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS saved_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  reference_track_id uuid NOT NULL REFERENCES reference_tracks (id) ON DELETE CASCADE,
  note text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, reference_track_id)
);

CREATE INDEX IF NOT EXISTS idx_saved_references_project
  ON saved_references (project_id, created_at DESC);
