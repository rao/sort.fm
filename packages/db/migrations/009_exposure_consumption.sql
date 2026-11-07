-- Preserve historical decisions, including any legacy duplicate exposure usage.
-- Only the earliest command is recorded as consumer; no new command may reuse it.
CREATE TABLE exposure_consumptions (
 user_id text NOT NULL, exposure_id uuid NOT NULL, decision_id uuid NOT NULL,
 PRIMARY KEY(user_id,exposure_id),
 FOREIGN KEY(user_id,exposure_id) REFERENCES exposures(user_id,exposure_id),
 FOREIGN KEY(user_id,decision_id) REFERENCES review_decisions(user_id,decision_id)
);
INSERT INTO exposure_consumptions(user_id,exposure_id,decision_id)
 SELECT DISTINCT ON(user_id,exposure_id) user_id,exposure_id,decision_id
 FROM review_decisions ORDER BY user_id,exposure_id,created_at,decision_id;
