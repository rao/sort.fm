-- An import pass captures this before its first provider request. Settled removals,
-- restorations and successful publications invalidate older in-flight snapshots.
ALTER TABLE users ADD COLUMN membership_revision integer NOT NULL DEFAULT 0 CHECK(membership_revision>=0);
