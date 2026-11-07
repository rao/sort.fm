CREATE TABLE review_work (
 command_id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), decision_id uuid NOT NULL,
 operation text NOT NULL CHECK(operation IN ('review','undo')),
 available_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,command_id), FOREIGN KEY(user_id,decision_id) REFERENCES review_decisions(user_id,decision_id)
);
CREATE INDEX review_work_ready ON review_work(available_at,created_at) WHERE completed_at IS NULL;
CREATE TABLE review_work_leases (
 user_id text PRIMARY KEY REFERENCES users(id), command_id uuid NOT NULL, lease_id uuid NOT NULL,
 lease_until timestamptz NOT NULL, worker_id text NOT NULL,
 FOREIGN KEY(user_id,command_id) REFERENCES review_work(user_id,command_id)
);
CREATE TABLE review_effects (
 user_id text NOT NULL REFERENCES users(id), effect_key text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('create_archive','add_archive')),
 request jsonb NOT NULL, state text NOT NULL CHECK(state IN ('intent','confirmed','retryable')),
 remote_id text, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,effect_key), CHECK(state<>'confirmed' OR remote_id IS NOT NULL)
);
-- Existing in-flight commands become restartable without touching their journal.
INSERT INTO review_work(command_id,user_id,decision_id,operation,created_at)
 SELECT decision_id,user_id,decision_id,'review',created_at FROM review_decisions
 WHERE result->>'status' IN ('PENDING','FAILED_RETRYABLE');
INSERT INTO review_work(command_id,user_id,decision_id,operation,created_at)
 SELECT command_id,user_id,decision_id,'undo',created_at FROM undo_commands WHERE settled_at IS NULL;
