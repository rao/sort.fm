-- Coalescing durable /fit reconciliation. A owns transport; settlement only schedules work.
CREATE TABLE feedback_sync_jobs (
 user_id text PRIMARY KEY REFERENCES users(id), target_revision integer NOT NULL CHECK(target_revision>0),
 acknowledged_revision integer NOT NULL DEFAULT 0 CHECK(acknowledged_revision>=0),
 available_at timestamptz NOT NULL DEFAULT now(), lease_id uuid, lease_until timestamptz, worker_id text,
 updated_at timestamptz NOT NULL DEFAULT now(), CHECK(acknowledged_revision<=target_revision)
);
CREATE INDEX feedback_sync_ready ON feedback_sync_jobs(available_at,lease_until) WHERE target_revision>acknowledged_revision;
-- Existing feedback must also reach ML after upgrading/restarting the application.
INSERT INTO feedback_sync_jobs(user_id,target_revision)
 SELECT id,feedback_revision FROM users WHERE feedback_revision>0;
