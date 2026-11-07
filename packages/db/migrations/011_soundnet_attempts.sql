-- Private request evidence, separate from public DTOs and successful feature caches.
-- Lease token keeps attempts unique even after an operator resets a failed job.
CREATE TABLE soundnet_attempts (
 lease_token uuid PRIMARY KEY,
 track_id text NOT NULL REFERENCES tracks(track_id),
 feature_version text NOT NULL,
 attempt integer NOT NULL CHECK(attempt > 0),
 endpoint text NOT NULL CHECK(endpoint IN ('spotify_id','title_artist')),
 expected_track jsonb NOT NULL,
 outcome text NOT NULL DEFAULT 'started',
 raw jsonb,
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 finished_at timestamptz
);
CREATE INDEX soundnet_attempts_track ON soundnet_attempts(track_id,feature_version,started_at);
