CREATE TABLE users (
 id text PRIMARY KEY, spotify_user_id text UNIQUE, profile jsonb NOT NULL DEFAULT '{}',
 is_authorized boolean NOT NULL DEFAULT false, feedback_revision integer NOT NULL DEFAULT 0 CHECK(feedback_revision>=0), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE oauth_credentials (
 user_id text PRIMARY KEY REFERENCES users(id), encrypted_payload text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE auth_sessions (hash text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), expires_at timestamptz NOT NULL);
CREATE INDEX auth_sessions_owner ON auth_sessions(user_id);
CREATE TABLE oauth_attempts (state_hash text PRIMARY KEY, encrypted_payload text NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE tracks (track_id text PRIMARY KEY, card jsonb NOT NULL, fetched_at timestamptz NOT NULL);
CREATE TABLE saved_tracks (
 user_id text NOT NULL REFERENCES users(id), track_id text NOT NULL REFERENCES tracks(track_id), original_added_at timestamptz NOT NULL,
 synced_at timestamptz NOT NULL, current_status text NOT NULL CHECK(current_status IN ('saved','kept','deferred','archived','unliked')), PRIMARY KEY(user_id,track_id)
);
CREATE TABLE library_snapshots (
 user_id text NOT NULL REFERENCES users(id), job_id uuid NOT NULL, page_offset integer NOT NULL, observation jsonb NOT NULL, PRIMARY KEY(user_id,job_id,page_offset)
);
CREATE TABLE taste_context (user_id text PRIMARY KEY REFERENCES users(id), context jsonb NOT NULL);
CREATE TABLE exposures (
 exposure_id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), track_id text NOT NULL REFERENCES tracks(track_id), payload jsonb NOT NULL,
 served_at timestamptz NOT NULL, UNIQUE(user_id,exposure_id), UNIQUE(user_id,exposure_id,track_id)
);
CREATE TABLE review_decisions (
 decision_id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), track_id text NOT NULL, exposure_id uuid NOT NULL,
 idempotency_key uuid NOT NULL, request_fingerprint text NOT NULL, request jsonb NOT NULL, result jsonb,
 created_at timestamptz NOT NULL, UNIQUE(user_id,idempotency_key), UNIQUE(user_id,decision_id),
 FOREIGN KEY(user_id,track_id) REFERENCES saved_tracks(user_id,track_id),
 FOREIGN KEY(user_id,exposure_id,track_id) REFERENCES exposures(user_id,exposure_id,track_id)
);
CREATE TABLE current_decisions (
 user_id text NOT NULL, track_id text NOT NULL, decision_id uuid NOT NULL,
 PRIMARY KEY(user_id,track_id), FOREIGN KEY(user_id,track_id) REFERENCES saved_tracks(user_id,track_id), FOREIGN KEY(user_id,decision_id) REFERENCES review_decisions(user_id,decision_id)
);
CREATE TABLE undo_commands (
 command_id uuid PRIMARY KEY, user_id text NOT NULL, decision_id uuid NOT NULL, idempotency_key uuid NOT NULL,
 request_fingerprint text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL,
 UNIQUE(user_id,idempotency_key), FOREIGN KEY(user_id,decision_id) REFERENCES review_decisions(user_id,decision_id)
);
CREATE TABLE spotify_mutations (
 mutation_id uuid PRIMARY KEY, user_id text NOT NULL, decision_id uuid NOT NULL,
 status text NOT NULL CHECK(status IN ('PENDING','COMPLETE','FAILED_RETRYABLE','FAILED_TERMINAL','UNDONE')),
 step text NOT NULL CHECK(step IN ('NONE','PENDING','ARCHIVED_PLAYLIST_INSERTED','UNLIKED','RESTORED','RECONCILING')),
 attempts integer NOT NULL CHECK(attempts>=0), archive_playlist_id text, updated_at timestamptz NOT NULL,
 FOREIGN KEY(user_id,decision_id) REFERENCES review_decisions(user_id,decision_id), UNIQUE(user_id,decision_id)
);
CREATE TABLE feedback (
 user_id text NOT NULL, decision_id uuid NOT NULL, revision integer NOT NULL CHECK(revision>0), label smallint CHECK(label IN(0,1)), revoked boolean NOT NULL,
 split text NOT NULL CHECK(split IN('train','holdout')), occurred_at timestamptz NOT NULL,
 PRIMARY KEY(user_id,decision_id), FOREIGN KEY(user_id,decision_id) REFERENCES review_decisions(user_id,decision_id), CHECK(NOT revoked OR label IS NULL)
);
CREATE TABLE archive_playlists (user_id text PRIMARY KEY REFERENCES users(id), spotify_playlist_id text NOT NULL);
CREATE TABLE archive_records (
 user_id text NOT NULL, decision_id uuid NOT NULL, track_id text NOT NULL REFERENCES tracks(track_id), playlist_id text NOT NULL, inserted_at timestamptz NOT NULL,
 PRIMARY KEY(user_id,decision_id), FOREIGN KEY(user_id,decision_id) REFERENCES review_decisions(user_id,decision_id)
);
CREATE TABLE import_jobs (
 user_id text NOT NULL REFERENCES users(id), job_type text NOT NULL, payload jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,job_type)
);
CREATE TABLE audio_features (
 track_id text NOT NULL REFERENCES tracks(track_id), feature_version text NOT NULL, provider text NOT NULL CHECK(provider='soundnet'), raw jsonb NOT NULL,
 normalized jsonb NOT NULL, data_quality jsonb NOT NULL, fetched_at timestamptz NOT NULL, PRIMARY KEY(track_id,feature_version)
);
CREATE TABLE soundnet_jobs (
 track_id text NOT NULL REFERENCES tracks(track_id), feature_version text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','running','success','failed')), attempts integer NOT NULL DEFAULT 0,
 available_at timestamptz NOT NULL DEFAULT now(), lease_token uuid, lease_until timestamptz, error_code text, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(track_id,feature_version)
);
CREATE INDEX soundnet_ready ON soundnet_jobs(status,available_at,lease_until);
CREATE TABLE provider_limits (provider text PRIMARY KEY, next_start_at timestamptz NOT NULL DEFAULT now(), paused_until timestamptz NOT NULL DEFAULT now());
INSERT INTO provider_limits(provider) VALUES ('soundnet');
CREATE TABLE provider_smoke (provider text PRIMARY KEY, verified_at timestamptz NOT NULL, report jsonb NOT NULL);
CREATE TABLE model_runs (
 run_id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), model_version text NOT NULL, feature_version text NOT NULL,
 payload jsonb NOT NULL, created_at timestamptz NOT NULL, UNIQUE(user_id,model_version)
);
CREATE TABLE interaction_events (
 event_id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), event_type text NOT NULL, payload jsonb NOT NULL, occurred_at timestamptz NOT NULL
);
CREATE INDEX events_owner_time ON interaction_events(user_id,occurred_at);
-- Separate deduplication from time-series storage: hypertable uniqueness includes partition time.
CREATE TABLE ml_telemetry (
 event_id uuid NOT NULL, user_id text NOT NULL, model_version text, event_type text NOT NULL,
 prediction_score double precision CHECK(prediction_score BETWEEN 0 AND 1), uncertainty double precision CHECK(uncertainty BETWEEN 0 AND 1),
 processing_latency_ms double precision NOT NULL CHECK(processing_latency_ms>=0), occurred_at timestamptz NOT NULL,
 PRIMARY KEY(occurred_at,event_id)
);
CREATE INDEX telemetry_owner_time ON ml_telemetry(user_id,occurred_at DESC);
CREATE VIEW ml_training_examples AS
 SELECT f.user_id, f.decision_id, d.track_id, f.label, f.split, f.occurred_at AS labeled_at, e.payload->'features' AS features
 FROM feedback f JOIN review_decisions d USING(user_id,decision_id)
 JOIN current_decisions c ON c.user_id=d.user_id AND c.decision_id=d.decision_id
 JOIN exposures e ON e.user_id=d.user_id AND e.exposure_id=d.exposure_id
 WHERE NOT f.revoked AND f.label IS NOT NULL;
