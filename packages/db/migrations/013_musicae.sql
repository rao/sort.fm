-- Independent provider history: never relabel or overwrite SoundNet rows.
CREATE TABLE musicae_requests (
 request_id uuid PRIMARY KEY, expected_tracks jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('reserved','started','responded','complete','failed','indeterminate')),
 envelope jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), started_at timestamptz,
 responded_at timestamptz, finished_at timestamptz
);
CREATE TABLE musicae_jobs (
 track_id text NOT NULL REFERENCES tracks(track_id), feature_version text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','success','quarantined','unavailable','failed')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3), priority_rank integer NOT NULL DEFAULT 1000000,
 request_id uuid REFERENCES musicae_requests(request_id), error_code text,
 available_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(track_id,feature_version)
);
CREATE INDEX musicae_jobs_ready ON musicae_jobs(priority_rank,available_at,track_id) WHERE status='pending';
CREATE TABLE musicae_features (
 track_id text NOT NULL REFERENCES tracks(track_id), feature_version text NOT NULL,
 provider text NOT NULL DEFAULT 'musicae' CHECK(provider='musicae'),
 quality text NOT NULL CHECK(quality IN ('success','quarantined')), raw jsonb NOT NULL, normalized jsonb NOT NULL,
 data_quality jsonb NOT NULL, request_id uuid NOT NULL REFERENCES musicae_requests(request_id), fetched_at timestamptz NOT NULL,
 PRIMARY KEY(track_id,feature_version)
);
CREATE TABLE musicae_control (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 active_request uuid REFERENCES musicae_requests(request_id), lease_until timestamptz,
 next_start_at timestamptz NOT NULL DEFAULT clock_timestamp(), paused_until timestamptz NOT NULL DEFAULT clock_timestamp(),
 remaining integer CHECK(remaining>=0), quota_limit integer CHECK(quota_limit>=0), quota_reset_at timestamptz,
 consecutive_failures integer NOT NULL DEFAULT 0 CHECK(consecutive_failures>=0), blocked_reason text,
 request_count integer NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO musicae_control(singleton) VALUES(true);
CREATE VIEW available_audio_features AS
 SELECT track_id,feature_version,normalized FROM audio_features
 UNION ALL
 SELECT m.track_id,m.feature_version,m.normalized FROM musicae_features m
 WHERE m.quality='success' AND NOT EXISTS(SELECT 1 FROM audio_features s WHERE s.track_id=m.track_id AND s.feature_version=m.feature_version);
