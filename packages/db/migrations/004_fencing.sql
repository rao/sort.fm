ALTER TABLE undo_commands ADD COLUMN settled_at timestamptz;
CREATE UNIQUE INDEX one_pending_undo ON undo_commands(user_id,decision_id) WHERE settled_at IS NULL;
ALTER TABLE provider_limits ADD COLUMN permit_token uuid;
