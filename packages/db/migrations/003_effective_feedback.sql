-- A pending replacement must not silently change the training dataset/revision.
-- The newest feedback revision per track is authoritative, including null/revoked tombstones.
CREATE OR REPLACE VIEW ml_training_examples AS
 SELECT f.user_id,f.decision_id,d.track_id,f.label,f.split,f.occurred_at AS labeled_at,e.payload->'features' AS features
 FROM feedback f JOIN review_decisions d USING(user_id,decision_id)
 JOIN exposures e ON e.user_id=d.user_id AND e.exposure_id=d.exposure_id
 WHERE NOT f.revoked AND f.label IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM feedback newer JOIN review_decisions nd USING(user_id,decision_id)
  WHERE newer.user_id=f.user_id AND nd.track_id=d.track_id AND newer.revision>f.revision
 );
