-- Optional C2 coordination. No historical associations or changes to C1 feedback.
CREATE TABLE policy_owner_state (
 user_id text PRIMARY KEY REFERENCES users(id),sequence bigint NOT NULL DEFAULT 0 CHECK(sequence>=0 AND sequence<=9007199254740991)
);
CREATE TABLE policy_fit_receipts (
 user_id text PRIMARY KEY REFERENCES users(id),model_version text NOT NULL CHECK(length(model_version)>0),
 feedback_revision integer NOT NULL CHECK(feedback_revision>=0),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE policy_selection_intents (
 user_id text NOT NULL REFERENCES users(id),request_id uuid NOT NULL,fingerprint text NOT NULL,
 draft jsonb NOT NULL,feedback_revision integer NOT NULL CHECK(feedback_revision>=0),membership_revision integer NOT NULL CHECK(membership_revision>=0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,
 status text NOT NULL CHECK(status IN ('prepared','published','release_pending','closed','expired')),
 lease_id uuid,lease_until timestamptz,lease_started_at timestamptz,publication jsonb,
 PRIMARY KEY(user_id,request_id),CHECK(expires_at>created_at),CHECK((lease_id IS NULL)=(lease_until IS NULL))
);
CREATE INDEX policy_intent_recovery ON policy_selection_intents(lease_until,created_at) WHERE status='prepared';
CREATE TABLE policy_exposure_bindings (
 exposure_id uuid PRIMARY KEY,user_id text NOT NULL,request_id uuid NOT NULL,track_id text,
 published boolean NOT NULL DEFAULT false,reserved_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,
 closed_at timestamptz,closure_reason text CHECK(closure_reason IN ('consumed','skip','undo','abandoned','prefetch_discarded','expiry')),
 UNIQUE(user_id,exposure_id),FOREIGN KEY(user_id,request_id) REFERENCES policy_selection_intents(user_id,request_id),
 FOREIGN KEY(user_id,track_id) REFERENCES saved_tracks(user_id,track_id),CHECK(published=false OR track_id IS NOT NULL),
 CHECK((closed_at IS NULL)=(closure_reason IS NULL)),CHECK(expires_at>reserved_at)
);
CREATE INDEX policy_track_reservations ON policy_exposure_bindings(user_id,track_id,expires_at) WHERE closed_at IS NULL;
CREATE TABLE policy_release_commands (
 user_id text NOT NULL,release_id uuid NOT NULL,request_id uuid NOT NULL,fingerprint text NOT NULL,receipt jsonb NOT NULL,
 PRIMARY KEY(user_id,release_id),FOREIGN KEY(user_id,request_id) REFERENCES policy_selection_intents(user_id,request_id)
);
CREATE TABLE policy_delivery_events (
 event_id uuid PRIMARY KEY,user_id text NOT NULL REFERENCES users(id),sequence bigint NOT NULL CHECK(sequence>0 AND sequence<=9007199254740991),
 dedupe_key text NOT NULL,kind text NOT NULL CHECK(kind IN ('associate','release')),payload jsonb NOT NULL,
 request_id uuid NOT NULL,exposure_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 available_at timestamptz NOT NULL DEFAULT clock_timestamp(),attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 lease_id uuid,lease_until timestamptz,lease_started_at timestamptz,worker_id text,claimed_fit_receipt jsonb,
 completed_at timestamptz,receipt jsonb,disposition text CHECK(disposition IN ('acknowledged','absent_after_deadline')),error_code text,
 UNIQUE(user_id,sequence),UNIQUE(user_id,dedupe_key),
 FOREIGN KEY(user_id,request_id) REFERENCES policy_selection_intents(user_id,request_id),
 FOREIGN KEY(user_id,exposure_id) REFERENCES policy_exposure_bindings(user_id,exposure_id),
 CHECK((lease_id IS NULL)=(lease_until IS NULL)),CHECK((completed_at IS NULL)=(disposition IS NULL))
);
CREATE INDEX policy_delivery_ready ON policy_delivery_events(user_id,sequence,available_at) WHERE completed_at IS NULL;
CREATE FUNCTION protect_policy_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.event_id,NEW.user_id,NEW.sequence,NEW.dedupe_key,NEW.kind,NEW.payload,NEW.request_id,NEW.exposure_id,NEW.created_at)
 IS DISTINCT FROM (OLD.event_id,OLD.user_id,OLD.sequence,OLD.dedupe_key,OLD.kind,OLD.payload,OLD.request_id,OLD.exposure_id,OLD.created_at)
 THEN RAISE EXCEPTION 'POLICY_EVENT_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_policy_event BEFORE UPDATE ON policy_delivery_events FOR EACH ROW EXECUTE FUNCTION protect_policy_event();
