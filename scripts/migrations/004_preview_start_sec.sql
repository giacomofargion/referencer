-- Offset (seconds) into the iTunes preview where the loudest window starts.
-- Used for A/B playback so intros don't dominate listening.
ALTER TABLE reference_tracks
  ADD COLUMN IF NOT EXISTS preview_start_sec double precision;
