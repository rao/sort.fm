ALTER TABLE library_snapshots ADD COLUMN pass integer NOT NULL DEFAULT 0 CHECK(pass>=0);
ALTER TABLE library_snapshots DROP CONSTRAINT library_snapshots_pkey;
ALTER TABLE library_snapshots ADD PRIMARY KEY(user_id,job_id,pass,page_offset);
CREATE TABLE library_membership (
 user_id text NOT NULL, track_id text NOT NULL, job_id uuid NOT NULL, pass integer NOT NULL,
 PRIMARY KEY(user_id,track_id), FOREIGN KEY(user_id,track_id) REFERENCES saved_tracks(user_id,track_id)
);
CREATE TABLE library_state (
 user_id text PRIMARY KEY REFERENCES users(id), job_id uuid NOT NULL, pass integer NOT NULL,
 source_total integer NOT NULL CHECK(source_total>=0), observed_at timestamptz NOT NULL
);
