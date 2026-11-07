ALTER TABLE exposures ADD COLUMN purpose text NOT NULL DEFAULT 'review' CHECK(purpose IN ('review','calibration'));
CREATE TABLE calibration_labels (
 label_id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), track_id text NOT NULL,
 exposure_id uuid NOT NULL, idempotency_key uuid NOT NULL, request_fingerprint text NOT NULL, request jsonb NOT NULL,
 submitted_label smallint NOT NULL CHECK(submitted_label IN (0,1)),
 label smallint CHECK(label IN (0,1)), revoked boolean NOT NULL DEFAULT false,
 revision integer NOT NULL CHECK(revision>0), split text NOT NULL CHECK(split IN ('train','holdout')),
 created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
 UNIQUE(user_id,label_id), UNIQUE(user_id,idempotency_key), UNIQUE(user_id,exposure_id),
 FOREIGN KEY(user_id,track_id) REFERENCES saved_tracks(user_id,track_id),
 FOREIGN KEY(user_id,exposure_id,track_id) REFERENCES exposures(user_id,exposure_id,track_id),
 CHECK((revoked AND label IS NULL) OR (NOT revoked AND label IS NOT NULL AND label=submitted_label)), CHECK(updated_at>=created_at)
);
CREATE INDEX calibration_owner_track ON calibration_labels(user_id,track_id,revision DESC);
CREATE TABLE calibration_undos (
 command_id uuid PRIMARY KEY, user_id text NOT NULL, label_id uuid NOT NULL,
 idempotency_key uuid NOT NULL, request_fingerprint text NOT NULL, request jsonb NOT NULL, created_at timestamptz NOT NULL,
 UNIQUE(user_id,idempotency_key), UNIQUE(user_id,label_id),
 FOREIGN KEY(user_id,label_id) REFERENCES calibration_labels(user_id,label_id)
);
CREATE VIEW unified_feedback AS
 SELECT f.user_id,f.decision_id,d.track_id,d.exposure_id,f.revision,f.label,f.revoked,f.split,f.occurred_at,'review'::text AS source
 FROM feedback f JOIN review_decisions d USING(user_id,decision_id)
 UNION ALL
 SELECT user_id,label_id,track_id,exposure_id,revision,label,revoked,split,updated_at,'calibration'::text FROM calibration_labels;
-- Select tombstones BEFORE filtering labels; older preference labels must never revive.
CREATE VIEW effective_feedback AS
 SELECT DISTINCT ON(user_id,track_id) * FROM unified_feedback ORDER BY user_id,track_id,revision DESC,decision_id;
CREATE OR REPLACE VIEW ml_training_examples AS
 SELECT f.user_id,f.decision_id,f.track_id,f.label,f.split,f.occurred_at AS labeled_at,e.payload->'features' AS features
 FROM effective_feedback f JOIN exposures e ON e.user_id=f.user_id AND e.exposure_id=f.exposure_id
 WHERE NOT f.revoked AND f.label IS NOT NULL;
