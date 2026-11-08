-- Additive reserve/seal protocol; 015 and existing Batch2 rows remain unchanged.
ALTER TABLE calibration_batches DROP CONSTRAINT calibration_batches_experiment_check;
ALTER TABLE calibration_batches ADD CONSTRAINT calibration_batches_experiment_check CHECK(experiment IN ('calibration-batch2-v1','calibration-batch3-v1'));
CREATE TABLE calibration_experiments (
 user_id text NOT NULL,batch_id uuid NOT NULL,phase text NOT NULL DEFAULT 'reserved' CHECK(phase IN ('reserved','ready')),
 reservation jsonb NOT NULL,seal_request jsonb,seal_receipt jsonb,
 PRIMARY KEY(user_id,batch_id),FOREIGN KEY(user_id,batch_id) REFERENCES calibration_batches(user_id,batch_id),
 CHECK((phase='reserved' AND seal_request IS NULL AND seal_receipt IS NULL) OR (phase='ready' AND seal_request IS NOT NULL AND seal_receipt IS NOT NULL))
);
CREATE UNIQUE INDEX calibration_experiment_seal_key ON calibration_experiments(user_id,(seal_request->>'idempotencyKey')) WHERE seal_request IS NOT NULL;
CREATE FUNCTION protect_calibration_experiment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'BATCH_SNAPSHOT_IMMUTABLE'; END IF;
 IF OLD.phase='ready' OR NEW.user_id<>OLD.user_id OR NEW.batch_id<>OLD.batch_id OR NEW.reservation IS DISTINCT FROM OLD.reservation OR NEW.phase<>'ready'
 THEN RAISE EXCEPTION 'BATCH_SNAPSHOT_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_calibration_experiment BEFORE UPDATE OR DELETE ON calibration_experiments FOR EACH ROW EXECUTE FUNCTION protect_calibration_experiment();
CREATE FUNCTION protect_calibration_experiment_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.experiment='calibration-batch3-v1' THEN RAISE EXCEPTION 'BATCH_SNAPSHOT_IMMUTABLE'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER protect_calibration_experiment_snapshot BEFORE UPDATE OR DELETE ON calibration_batches FOR EACH ROW EXECUTE FUNCTION protect_calibration_experiment_snapshot();
-- Defense in depth for direct writes: no labels, Undo, skips, status changes or
-- exposure renewal until sealing. All normal stores also check before projection.
CREATE FUNCTION guard_calibration_experiment_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id text; track text;
BEGIN
 owner_id:=NEW.user_id;
 IF TG_TABLE_NAME='calibration_undos' THEN
  SELECT track_id INTO track FROM calibration_labels WHERE user_id=owner_id AND label_id=NEW.label_id;
 ELSIF TG_TABLE_NAME='calibration_batch_skips' THEN
  SELECT track_id INTO track FROM calibration_batch_items WHERE user_id=owner_id AND batch_item_id=NEW.batch_item_id;
 ELSE track:=NEW.track_id;
 END IF;
 IF EXISTS(SELECT 1 FROM calibration_batch_items i JOIN calibration_batches b USING(user_id,batch_id)
  LEFT JOIN calibration_experiments x USING(user_id,batch_id)
  WHERE i.user_id=owner_id AND i.track_id=track AND b.experiment='calibration-batch3-v1' AND (x.phase IS DISTINCT FROM 'ready'))
 THEN RAISE EXCEPTION 'BATCH_NOT_READY'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_experiment_labels BEFORE INSERT OR UPDATE ON calibration_labels FOR EACH ROW EXECUTE FUNCTION guard_calibration_experiment_admission();
CREATE TRIGGER guard_experiment_undo BEFORE INSERT ON calibration_undos FOR EACH ROW EXECUTE FUNCTION guard_calibration_experiment_admission();
CREATE TRIGGER guard_experiment_skip BEFORE INSERT ON calibration_batch_skips FOR EACH ROW EXECUTE FUNCTION guard_calibration_experiment_admission();
CREATE TRIGGER guard_experiment_item BEFORE UPDATE ON calibration_batch_items FOR EACH ROW EXECUTE FUNCTION guard_calibration_experiment_admission();
CREATE TRIGGER guard_experiment_exposure BEFORE INSERT OR UPDATE ON exposures FOR EACH ROW EXECUTE FUNCTION guard_calibration_experiment_admission();
