-- Playback credentials and state are isolated from primary library authentication.
CREATE TABLE playback_grants (
 user_id text NOT NULL REFERENCES users(id), purpose text NOT NULL CHECK(purpose IN ('sdk','control')),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id,purpose),
 CHECK((payload->>'ownerId') IS NOT DISTINCT FROM user_id),
 CHECK((payload->>'purpose') IS NOT DISTINCT FROM purpose)
);
CREATE TABLE playback_oauth_attempts (
 state_hash text PRIMARY KEY CHECK(state_hash ~ '^[a-f0-9]{64}$'),
 user_id text NOT NULL REFERENCES users(id), purpose text NOT NULL CHECK(purpose IN ('sdk','control')),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'), expires_at timestamptz NOT NULL,
 consumed_at timestamptz, completed_at timestamptz,
 CHECK(completed_at IS NULL OR consumed_at IS NOT NULL),
 CHECK((payload->>'stateHash') IS NOT DISTINCT FROM state_hash),
 CHECK((payload->>'ownerId') IS NOT DISTINCT FROM user_id),
 CHECK((payload->>'purpose') IS NOT DISTINCT FROM purpose)
);
CREATE INDEX playback_oauth_owner ON playback_oauth_attempts(user_id,purpose);
CREATE INDEX playback_oauth_expiry ON playback_oauth_attempts(expires_at);
