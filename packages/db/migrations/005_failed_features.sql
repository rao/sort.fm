CREATE TABLE soundnet_failures (
 track_id text NOT NULL REFERENCES tracks(track_id), feature_version text NOT NULL, attempt integer NOT NULL,
 lease_token uuid NOT NULL, error_code text NOT NULL, raw jsonb NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(track_id,feature_version,lease_token)
);
