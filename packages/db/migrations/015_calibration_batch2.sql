CREATE TABLE calibration_batches (
 batch_id uuid PRIMARY KEY,user_id text NOT NULL REFERENCES users(id),experiment text NOT NULL CHECK(experiment='calibration-batch2-v1'),
 seed integer NOT NULL CHECK(seed>=0),algorithm_version text NOT NULL,model_version text NOT NULL,selected_at timestamptz NOT NULL,
 snapshot jsonb NOT NULL,UNIQUE(user_id,experiment),UNIQUE(user_id,batch_id)
);
CREATE TABLE calibration_batch_items (
 batch_item_id uuid PRIMARY KEY,user_id text NOT NULL,batch_id uuid NOT NULL,track_id text NOT NULL,
 sampling_group text NOT NULL CHECK(sampling_group IN ('A','B','C')),
 assignment text NOT NULL CHECK(assignment IN ('sealed_evaluation','train')),
 provenance jsonb NOT NULL,candidate jsonb NOT NULL,selected_at timestamptz NOT NULL,
 position integer NOT NULL CHECK(position>=0),status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','labeled','skipped','revoked')),
 exposure_id uuid NOT NULL,replacement_for uuid REFERENCES calibration_batch_items(batch_item_id),
 UNIQUE(user_id,track_id),UNIQUE(user_id,batch_item_id),UNIQUE(user_id,batch_id,position),UNIQUE(replacement_for),
 FOREIGN KEY(user_id,batch_id) REFERENCES calibration_batches(user_id,batch_id),
 FOREIGN KEY(user_id,track_id) REFERENCES saved_tracks(user_id,track_id),
 FOREIGN KEY(user_id,exposure_id,track_id) REFERENCES exposures(user_id,exposure_id,track_id),
 CHECK((sampling_group='A')=(assignment='sealed_evaluation'))
);
CREATE TABLE calibration_batch_exposures (
 user_id text NOT NULL,batch_item_id uuid NOT NULL,exposure_id uuid NOT NULL,PRIMARY KEY(user_id,exposure_id),
 FOREIGN KEY(user_id,batch_item_id) REFERENCES calibration_batch_items(user_id,batch_item_id),
 FOREIGN KEY(user_id,exposure_id) REFERENCES exposures(user_id,exposure_id)
);
CREATE TABLE calibration_batch_skips (
 user_id text NOT NULL,idempotency_key uuid NOT NULL,exposure_id uuid NOT NULL,batch_item_id uuid NOT NULL,created_at timestamptz NOT NULL,
 PRIMARY KEY(user_id,idempotency_key),UNIQUE(user_id,batch_item_id),
 FOREIGN KEY(user_id,batch_item_id) REFERENCES calibration_batch_items(user_id,batch_item_id),
 FOREIGN KEY(user_id,exposure_id) REFERENCES calibration_batch_exposures(user_id,exposure_id)
);
-- Sealed means absent from both fitting and routinely displayed evaluation. The
-- ordinary train/holdout assignments stay untouched, including all old tombstones.
CREATE OR REPLACE VIEW ml_training_examples AS
 SELECT f.user_id,f.decision_id,f.track_id,f.label,f.split,f.occurred_at AS labeled_at,e.payload->'features' AS features
 FROM effective_feedback f JOIN exposures e ON e.user_id=f.user_id AND e.exposure_id=f.exposure_id
 WHERE NOT f.revoked AND f.label IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM calibration_batch_items b WHERE b.user_id=f.user_id AND b.track_id=f.track_id AND b.assignment='sealed_evaluation');
-- Reservations/provenance cannot be deleted or reassigned through a later label,
-- Skip, Undo, or ordinary application update. Removing a reservation needs an
-- explicit future migration, never an automatic release of the evaluation set.
CREATE FUNCTION protect_calibration_batch_item() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'BATCH_RESERVATION_IMMUTABLE'; END IF;
 IF (to_jsonb(NEW)-'status'-'exposure_id') IS DISTINCT FROM (to_jsonb(OLD)-'status'-'exposure_id') THEN RAISE EXCEPTION 'BATCH_RESERVATION_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_calibration_batch_item BEFORE UPDATE OR DELETE ON calibration_batch_items FOR EACH ROW EXECUTE FUNCTION protect_calibration_batch_item();
