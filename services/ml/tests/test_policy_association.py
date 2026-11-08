"""Associate cleanup telemetry with an already published C1 fit; never refit here."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from threading import Event

import pytest

from test_app import AUTH, feature_vector, fit_payload, request
from test_policy_reservations import Clock, inspect, make_app, release, stamp
from test_policy_service import choose, diagnostics, event as observe_event, selection, uid


def cleanup_event(selected, *, number=6000, sequence=1, revision=2, label=1,
                  operation="upsert", decision=7000):
    return {"eventId": uid(number), "sequence": sequence, "source": "cleanup",
            "decisionId": uid(decision), "exposureId": selected["exposureId"],
            "trackId": selected["trackId"], "policyVersion": selected["policyVersion"],
            "modelVersion": selected["modelVersion"], "operation": operation,
            "feedbackRevision": revision, "label": label,
            "features": deepcopy(selected["candidate"]["features"]),
            "occurredAt": "2026-11-07T12:00:00Z"}


def receipt(response):
    return {"modelVersion": response["modelVersion"],
            "synchronizedFeedbackRevision": response["feedbackRevision"]}


def publish(app, snapshot, event=None, revision=None):
    payload = deepcopy(snapshot)
    if event is not None:
        if event["operation"] == "upsert" and event["label"] is not None:
            previous = next((row for row in payload["examples"] if row["trackId"] == event["trackId"]), None)
            payload["examples"] = [row for row in payload["examples"] if row["trackId"] != event["trackId"]]
            payload["examples"].append({"trackId": event["trackId"], "decisionId": event["decisionId"],
                                         "features": deepcopy(event["features"]), "label": event["label"],
                                         "split": previous["split"] if previous else "train",
                                         "labeledAt": event["occurredAt"]})
        elif event["operation"] == "revoke":
            payload["examples"] = [row for row in payload["examples"]
                                   if row["decisionId"] != event["decisionId"]]
    payload["feedbackRevision"] = revision if revision is not None else event["feedbackRevision"]
    result = request(app, "POST", "/fit", AUTH, json=payload)
    assert result.status_code == 200, result.text
    return payload, receipt(result.json())


def prepare(path, index=0, label=1, user="demo:alice"):
    clock = Clock()
    app = make_app(path, clock)
    snapshot = fit_payload(user)
    result = request(app, "POST", "/fit", AUTH, json=snapshot)
    assert result.status_code == 200, result.text
    row = snapshot["examples"][index]
    payload = selection(user=user)
    payload["candidates"] = [{"trackId": row["trackId"], "features": row["features"]}]
    selected = choose(app, payload)
    event = cleanup_event(selected, label=label)
    snapshot, fitted = publish(app, snapshot, event)
    return app, clock, selected, event, snapshot, fitted


def body(event, fitted, user="demo:alice"):
    return {"userId": user, "event": deepcopy(event), "fitReceipt": deepcopy(fitted)}


def associate(app, event, fitted, user="demo:alice"):
    result = request(app, "POST", "/policy/associate", AUTH, json=body(event, fitted, user))
    assert result.status_code == 200, result.text
    return result.json()


def c1_files(path):
    return {str(file.relative_to(path)): file.read_bytes() for file in path.rglob("*")
            if file.is_file() and file.name not in ("policy.json", ".lock")}


def retire_before_reselection(app, selected, snapshot, revision=3):
    """Model the backend's completed Undo snapshot plus explicit old lease closure."""
    release(app, selected)
    snapshot = deepcopy(snapshot)
    snapshot["examples"] = [row for row in snapshot["examples"] if row["trackId"] != selected["trackId"]]
    return publish(app, snapshot, revision=revision)


@pytest.mark.parametrize("label", [0, 1])
def test_association_matches_published_fit_without_mutating_c1_or_calling_writers(tmp_path, monkeypatch, label):
    app, clock, selected, event, _, fitted = prepare(tmp_path, label=label)
    original = c1_files(tmp_path)

    def forbidden(_):
        pytest.fail("Association must not call ModelService.fit or ModelService.observe")

    monkeypatch.setattr(app.state.model_service, "fit", forbidden)
    monkeypatch.setattr(app.state.model_service, "observe", forbidden)
    response = associate(app, event, fitted)
    assert response == {"userId": "demo:alice", "eventId": event["eventId"], "sequence": 1,
                        "recordedAt": response["recordedAt"], "duplicate": False,
                        "fitReceipt": fitted, "eligibleForLearning": True}
    assert stamp(response["recordedAt"]) == clock.now
    assert c1_files(tmp_path) == original
    summary = diagnostics(app)
    assert summary["counts"]["activeRewards"] == 1
    assert summary["rewardSummary"]["sum"] == pytest.approx(
        .75 + .25 * (label - selected["prediction"]["removalProbability"]) ** 2)
    assert inspect(app, selected)["decision"] == selected


def test_direct_service_association_and_http_replay_share_durable_idempotency(tmp_path):
    app, clock, _, event, _, fitted = prepare(tmp_path)
    first = app.state.policy_service.associate(body(event, fitted))
    assert first["duplicate"] is False
    clock.advance(9)
    restored = make_app(tmp_path, clock)
    replay = associate(restored, event, fitted)
    assert replay == {**first, "duplicate": True}
    assert diagnostics(restored)["counts"]["activeRewards"] == 1


def test_fit_receipt_can_advance_without_changing_event_identity_or_recorded_at(tmp_path):
    app, clock, _, event, snapshot, fitted = prepare(tmp_path)
    first = associate(app, event, fitted)
    clock.advance(5)
    snapshot, later_fit = publish(app, snapshot, revision=3)
    replay = associate(app, event, later_fit)
    assert replay == {**first, "duplicate": True, "fitReceipt": later_fit}
    assert diagnostics(app)["counts"]["activeRewards"] == 1
    stale = request(app, "POST", "/policy/associate", AUTH, json=body(event, fitted))
    assert stale.status_code == 409


@pytest.mark.parametrize("change", [{"label": 0}, {"usefulness": .2}, {"sequence": 2},
                                    {"occurredAt": "2026-11-07T12:00:01Z"}])
def test_association_event_identity_is_immutable_even_with_valid_new_fit_receipt(tmp_path, change):
    app, _, _, event, snapshot, fitted = prepare(tmp_path)
    associate(app, event, fitted)
    _, newer = publish(app, snapshot, revision=3)
    result = request(app, "POST", "/policy/associate", AUTH, json=body(event | change, newer))
    assert result.status_code == 409
    assert diagnostics(app)["counts"]["activeRewards"] == 1


@pytest.mark.parametrize("change", ["model", "revision", "event_ahead", "missing_fit"])
def test_only_exact_current_published_fit_head_is_accepted(tmp_path, change):
    app, _, selected, event, _, fitted = prepare(tmp_path)
    if change == "model":
        fitted["modelVersion"] = selected["modelVersion"]
    elif change == "revision":
        fitted["synchronizedFeedbackRevision"] += 1
    elif change == "event_ahead":
        event["feedbackRevision"] += 1
    else:
        # /observe explicitly clears fitFingerprint; association must not accept its head.
        observed = observe_event(selected, number=8000, revision=3)
        observed["decisionId"] = uid(8001)
        result = request(app, "POST", "/observe", AUTH, json=observed)
        assert result.status_code == 200, result.text
        fitted = receipt(result.json())
    response = request(app, "POST", "/policy/associate", AUTH, json=body(event, fitted))
    assert response.status_code == (422 if change == "event_ahead" else 409)


def test_stale_pinned_fit_artifact_does_not_authorize_association(tmp_path):
    app, _, _, event, snapshot, fitted = prepare(tmp_path)
    _, newer = publish(app, snapshot, revision=3)
    assert newer["modelVersion"] != fitted["modelVersion"]
    response = request(app, "POST", "/policy/associate", AUTH, json=body(event, fitted))
    assert response.status_code == 409
    assert diagnostics(app)["counts"]["activeRewards"] == 0
    assert associate(app, event, newer)["eligibleForLearning"] is True


def test_coalesced_missing_review_is_accepted_as_inactive_and_keeps_audit(tmp_path):
    app, _, selected, event, snapshot, _ = prepare(tmp_path)
    snapshot["examples"] = [row for row in snapshot["examples"] if row["trackId"] != event["trackId"]]
    _, fitted = publish(app, snapshot, revision=8)
    response = associate(app, event, fitted)
    assert response["eligibleForLearning"] is False
    assert diagnostics(app)["counts"]["activeRewards"] == 0
    recorded = [row for row in inspect(app, selected)["feedback"] if row["eventId"] == event["eventId"]]
    assert len(recorded) == 1
    assert recorded[0]["eligibleForLearning"] is False


def test_snapshot_alone_does_not_fabricate_policy_reward_or_completed_history(tmp_path):
    app, clock, selected, _, _, _ = prepare(tmp_path)
    assert diagnostics(app)["counts"]["activeRewards"] == 0
    clock.advance(300)
    payload = {**selection(1001), "candidates": [selected["candidate"]]}
    assert choose(app, payload)["trackId"] == selected["trackId"]


def test_associated_completed_review_suppresses_after_expiry_and_full_fit_removal_clears_it(tmp_path):
    app, clock, selected, event, snapshot, fitted = prepare(tmp_path)
    associate(app, event, fitted)
    clock.advance(300)
    payload = {**selection(1001), "candidates": [selected["candidate"]]}
    result = request(app, "POST", "/policy/select", AUTH, json=payload)
    assert result.status_code == 409
    assert result.json()["code"] == "NO_ELIGIBLE_CANDIDATES"
    snapshot["examples"] = [row for row in snapshot["examples"] if row["trackId"] != event["trackId"]]
    _, newer = publish(app, snapshot, revision=3)
    assert diagnostics(app)["counts"]["activeRewards"] == 0
    replay = associate(app, event, newer)
    assert replay["duplicate"] is True
    assert replay["eligibleForLearning"] is False
    assert choose(app, payload)["trackId"] == selected["trackId"]


@pytest.mark.parametrize("mismatch", ["decision", "label", "features"])
def test_current_example_must_match_decision_label_and_normalized_features(tmp_path, mismatch):
    app, _, _, event, snapshot, _ = prepare(tmp_path)
    example = next(row for row in snapshot["examples"] if row["trackId"] == event["trackId"])
    if mismatch == "decision":
        example["decisionId"] = uid(7999)
    elif mismatch == "label":
        example["label"] = 0
    else:
        example["features"] = feature_vector(.45)
    _, fitted = publish(app, snapshot, revision=3)
    assert associate(app, event, fitted)["eligibleForLearning"] is False
    assert diagnostics(app)["counts"]["activeRewards"] == 0


def test_null_equivalent_current_fit_features_match_and_holdout_remains_excluded(tmp_path):
    app, _, _, event, snapshot, _ = prepare(tmp_path)
    example = next(row for row in snapshot["examples"] if row["trackId"] == event["trackId"])
    example["features"]["values"]["liveness"] = None
    _, fitted = publish(app, snapshot, revision=3)
    assert associate(app, event, fitted)["eligibleForLearning"] is True
    holdout, _, _, held_event, _, held_fit = prepare(tmp_path / "holdout", index=-1)
    assert associate(holdout, held_event, held_fit)["eligibleForLearning"] is False
    assert diagnostics(holdout)["counts"]["activeRewards"] == 0
    assert diagnostics(holdout)["counts"]["holdoutExcluded"] == 1


def test_explicit_usefulness_preserves_cleanup_reward_definition(tmp_path):
    app, _, selected, event, _, fitted = prepare(tmp_path)
    event["usefulness"] = .2
    associate(app, event, fitted)
    assert diagnostics(app)["rewardSummary"]["sum"] == pytest.approx(
        .75 * .2 + .25 * (1 - selected["prediction"]["removalProbability"]) ** 2)


def test_association_supersedes_legacy_direct_feedback_without_double_counting(tmp_path):
    app, _, selected, association, snapshot, _ = prepare(tmp_path)
    legacy = observe_event(selected, number=8000, revision=3)
    result = request(app, "POST", "/observe", AUTH, json=legacy)
    assert result.status_code == 200, result.text
    snapshot, fitted = publish(app, snapshot, legacy, revision=4)
    association.update(decisionId=legacy["decisionId"], feedbackRevision=3)
    assert diagnostics(app)["counts"]["activeRewards"] == 1
    assert associate(app, association, fitted)["eligibleForLearning"] is True
    feedback = {row["eventId"]: row for row in inspect(app, selected)["feedback"]}
    assert feedback[legacy["eventId"]]["eligibleForLearning"] is False
    assert feedback[association["eventId"]]["eligibleForLearning"] is True
    assert diagnostics(app)["counts"]["activeRewards"] == 1


def test_undo_tombstone_beats_late_upsert_and_does_not_refit(tmp_path):
    app, _, selected, upsert, snapshot, _ = prepare(tmp_path)
    undo = {**upsert, "eventId": uid(6001), "sequence": 2, "operation": "revoke", "label": None,
            "feedbackRevision": 3}
    _, fitted = publish(app, snapshot, undo)
    original = c1_files(tmp_path)
    assert associate(app, undo, fitted)["eligibleForLearning"] is False
    assert associate(app, upsert, fitted)["eligibleForLearning"] is False
    assert diagnostics(app)["counts"]["activeRewards"] == 0
    reservation = inspect(app, selected)["reservation"]
    assert reservation["status"] == "released"
    assert reservation["closureReason"] == "undo"
    assert c1_files(tmp_path) == original


def test_undo_tombstone_blocks_old_upsert_even_if_later_fit_repeats_same_example(tmp_path):
    app, _, _, first, snapshot, _ = prepare(tmp_path)
    undo = {**first, "eventId": uid(6001), "sequence": 2, "operation": "revoke", "label": None,
            "feedbackRevision": 3}
    # A newer fit receipt does not make an older event the latest decision again.
    _, fitted = publish(app, snapshot, revision=4)
    assert associate(app, undo, fitted)["eligibleForLearning"] is False
    assert associate(app, first, fitted)["eligibleForLearning"] is False
    assert diagnostics(app)["counts"]["activeRewards"] == 0
    redo = {**first, "eventId": uid(6002), "sequence": 3, "feedbackRevision": 4}
    assert associate(app, redo, fitted)["eligibleForLearning"] is True
    assert diagnostics(app)["counts"]["activeRewards"] == 1


def test_latest_sequence_wins_for_reaffirmed_same_decision_and_exposure(tmp_path):
    app, _, _, first, _, fitted = prepare(tmp_path)
    latest = {**first, "eventId": uid(6001), "sequence": 2, "usefulness": .1}
    assert associate(app, latest, fitted)["eligibleForLearning"] is True
    assert associate(app, first, fitted)["eligibleForLearning"] is False
    assert diagnostics(app)["counts"]["activeRewards"] == 1
    again = associate(app, latest, fitted)
    assert again["duplicate"] is True
    assert again["eligibleForLearning"] is True


def test_decision_cannot_be_reassociated_with_another_exposure(tmp_path):
    app, _, old, first, snapshot, fitted = prepare(tmp_path)
    associate(app, first, fitted)
    snapshot, _ = retire_before_reselection(app, old, snapshot)
    payload = {**selection(1001, strategy="c1"), "candidates": [old["candidate"]]}
    newer = choose(app, payload)
    latest = cleanup_event(newer, number=6001, sequence=2, revision=4)
    _, fitted = publish(app, snapshot, latest)
    result = request(app, "POST", "/policy/associate", AUTH, json=body(latest, fitted))
    assert result.status_code == 409
    assert associate(app, first, fitted)["eligibleForLearning"] is True
    assert diagnostics(app)["counts"]["activeRewards"] == 1


def test_later_skip_cannot_assign_a_different_decision_to_consumed_exposure(tmp_path):
    app, _, selected, first, snapshot, fitted = prepare(tmp_path)
    associate(app, first, fitted)
    skipped = cleanup_event(selected, number=6001, sequence=2, revision=3, label=None, decision=7001)
    _, fitted = publish(app, snapshot, skipped)
    result = request(app, "POST", "/policy/associate", AUTH, json=body(skipped, fitted))
    assert result.status_code == 409
    assert associate(app, first, fitted)["eligibleForLearning"] is True
    assert diagnostics(app)["counts"]["activeRewards"] == 1


@pytest.mark.parametrize("operation,label", [("upsert", None), ("revoke", None)])
def test_skip_and_undo_close_only_their_original_exposure(tmp_path, operation, label):
    app, _, old, strong, snapshot, _ = prepare(tmp_path)
    snapshot, _ = retire_before_reselection(app, old, snapshot)
    original_closure = inspect(app, old)["reservation"]
    newer_request = selection(1001, strategy="c1")
    newer_request["candidates"] = [old["candidate"]]
    newer = choose(app, newer_request)
    terminal = {**strong, "eventId": uid(6001), "sequence": 2, "operation": operation,
                "label": label, "feedbackRevision": 4}
    _, fitted = publish(app, snapshot, terminal)
    assert associate(app, terminal, fitted)["eligibleForLearning"] is False
    after = inspect(app, old)["reservation"]
    assert after["status"] == "released"
    assert after["closedAt"] == original_closure["closedAt"]
    assert after["closureReason"] == original_closure["closureReason"]
    assert inspect(app, newer)["reservation"]["status"] == "active"
    assert diagnostics(app)["counts"]["activeRewards"] == 0


@pytest.mark.parametrize("operation", ["upsert", "revoke"])
def test_skip_and_undo_close_live_target_without_touching_other_track_lease(tmp_path, operation):
    app, _, old, strong, snapshot, _ = prepare(tmp_path)
    other = choose(app, selection(1001))
    assert old["trackId"] != other["trackId"]
    assert inspect(app, old)["reservation"]["status"] == "active"
    terminal = {**strong, "eventId": uid(6001), "sequence": 2, "operation": operation,
                "label": None, "feedbackRevision": 3}
    _, fitted = publish(app, snapshot, terminal)
    assert associate(app, terminal, fitted)["eligibleForLearning"] is False
    assert inspect(app, old)["reservation"]["status"] == "released"
    assert inspect(app, other)["reservation"]["status"] == "active"


def test_delayed_old_undo_cannot_deactivate_newer_review(tmp_path):
    app, _, old, first, snapshot, fitted = prepare(tmp_path)
    associate(app, first, fitted)
    snapshot, _ = retire_before_reselection(app, old, snapshot)
    newer_request = selection(1001, strategy="c1")
    newer_request["candidates"] = [old["candidate"]]
    newer = choose(app, newer_request)
    latest = cleanup_event(newer, number=6002, sequence=3, revision=4, decision=7001)
    snapshot, fitted = publish(app, snapshot, latest)
    assert associate(app, latest, fitted)["eligibleForLearning"] is True
    stale_undo = {**first, "eventId": uid(6001), "sequence": 2, "operation": "revoke",
                  "label": None, "feedbackRevision": 3}
    assert associate(app, stale_undo, fitted)["eligibleForLearning"] is False
    assert diagnostics(app)["counts"]["activeRewards"] == 1
    assert inspect(app, newer)["reservation"]["status"] == "active"


def test_feedback_after_expiry_or_release_keeps_terminal_closure(tmp_path):
    app, clock, selected, event, _, fitted = prepare(tmp_path)
    release(app, selected)
    frozen = inspect(app, selected)["reservation"]
    clock.advance(301)
    assert associate(app, event, fitted)["eligibleForLearning"] is True
    after = inspect(app, selected)["reservation"]
    assert after["status"] == frozen["status"]
    assert after["closedAt"] == frozen["closedAt"]


@pytest.mark.parametrize("field,value", [("trackId", "demo:wrong"), ("policyVersion", "c2-wrong"),
                                        ("features", feature_vector(.45))])
def test_association_rejects_exposure_identity_or_feature_mismatch(tmp_path, field, value):
    app, _, _, event, _, fitted = prepare(tmp_path)
    result = request(app, "POST", "/policy/associate", AUTH, json=body(event | {field: value}, fitted))
    assert result.status_code == 409
    assert diagnostics(app)["counts"]["activeRewards"] == 0


def test_event_model_version_is_frozen_prediction_version_not_current_fit_version(tmp_path):
    app, _, selected, event, _, fitted = prepare(tmp_path)
    assert selected["modelVersion"] != fitted["modelVersion"]
    wrong = {**event, "modelVersion": fitted["modelVersion"]}
    assert request(app, "POST", "/policy/associate", AUTH, json=body(wrong, fitted)).status_code == 409
    assert associate(app, event, fitted)["eligibleForLearning"] is True


def test_unknown_and_foreign_exposure_return_same_not_found_without_learning(tmp_path):
    app, _, _, event, _, fitted = prepare(tmp_path)
    bob_snapshot = fit_payload("demo:bob")
    bob_snapshot["feedbackRevision"] = 2
    bob_fit = request(app, "POST", "/fit", AUTH, json=bob_snapshot)
    assert bob_fit.status_code == 200
    bob_receipt = receipt(bob_fit.json())
    unknown = {**event, "exposureId": uid(1999)}
    first = request(app, "POST", "/policy/associate", AUTH, json=body(unknown, fitted))
    second = request(app, "POST", "/policy/associate", AUTH, json=body(event, bob_receipt, "demo:bob"))
    assert first.status_code == second.status_code == 404
    assert first.json() == second.json()
    assert diagnostics(app)["counts"]["activeRewards"] == 0


def test_association_event_id_and_sequence_are_user_scoped(tmp_path):
    app, _, _, alice_event, _, alice_fit = prepare(tmp_path)
    _, _, _, bob_event, _, bob_fit = prepare(tmp_path, user="demo:bob")
    assert alice_event["eventId"] == bob_event["eventId"]
    alice = associate(app, alice_event, alice_fit)
    bob = associate(app, bob_event, bob_fit, user="demo:bob")
    assert alice["duplicate"] is False
    assert bob["duplicate"] is False
    assert bob["userId"] == "demo:bob"
    assert associate(app, alice_event, alice_fit)["duplicate"] is True


@pytest.mark.parametrize("patch", [{"source": "calibration"}, {"sequence": 0}, {"sequence": True},
                                   {"sequence": 1.5}, {"sequence": "1"}, {"eventId": "invalid"},
                                   {"label": 2}, {"usefulness": 1.1}, {"unexpected": True},
                                   {"operation": "revoke", "label": 1},
                                   {"label": None, "usefulness": .5}])
def test_association_authentication_and_strict_cleanup_event_validation(tmp_path, patch):
    app, _, _, event, _, fitted = prepare(tmp_path)
    payload = body(event | patch, fitted)
    assert request(app, "POST", "/policy/associate", json=payload).status_code == 401
    result = request(app, "POST", "/policy/associate", AUTH, json=payload)
    assert result.status_code == 422
    assert result.json()["code"] == "BAD_REQUEST"


@pytest.mark.parametrize("location", ["request", "receipt"])
def test_association_rejects_extra_envelope_or_fit_receipt_fields(tmp_path, location):
    app, _, _, event, _, fitted = prepare(tmp_path)
    payload = body(event, fitted)
    (payload if location == "request" else payload["fitReceipt"])["unrecognized"] = 1
    assert request(app, "POST", "/policy/associate", AUTH, json=payload).status_code == 422


def test_policy_write_failure_does_not_claim_association_and_retry_recovers_once(tmp_path, monkeypatch):
    import sortfm_ml.policy_service as module

    app, clock, _, event, _, fitted = prepare(tmp_path)
    original_c1 = c1_files(tmp_path)
    policy = next(tmp_path.glob("*/policy.json"))
    original_policy = policy.read_bytes()
    original_write = module.atomic_bytes

    def fail(path, data):
        if path.name == "policy.json":
            raise OSError("Injected association publication failure")
        return original_write(path, data)

    monkeypatch.setattr(module, "atomic_bytes", fail)
    result = request(app, "POST", "/policy/associate", AUTH, json=body(event, fitted))
    assert result.status_code == 503
    assert policy.read_bytes() == original_policy
    assert c1_files(tmp_path) == original_c1
    monkeypatch.setattr(module, "atomic_bytes", original_write)
    restored = make_app(tmp_path, clock)
    assert associate(restored, event, fitted)["duplicate"] is False
    assert associate(restored, event, fitted)["duplicate"] is True
    assert diagnostics(restored)["counts"]["activeRewards"] == 1


def test_competing_identical_associations_publish_one_event_and_one_reward(tmp_path):
    app, clock, _, event, _, fitted = prepare(tmp_path)

    def run(_):
        instance = make_app(tmp_path, clock)
        return instance.state.policy_service.associate(body(event, fitted))

    with ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(run, range(8)))
    assert sum(not row["duplicate"] for row in results) == 1
    assert len({row["recordedAt"] for row in results}) == 1
    assert diagnostics(app)["counts"]["activeRewards"] == 1


def test_association_head_validation_and_publication_share_c1_user_lock(tmp_path, monkeypatch):
    import fcntl
    import sortfm_ml.policy_service as module

    app, _, _, event, snapshot, fitted = prepare(tmp_path)
    inside_write, allow_write, fit_started = Event(), Event(), Event()
    original_write = module.atomic_bytes

    def pause_association(path, data):
        if path.name == "policy.json":
            inside_write.set()
            assert allow_write.wait(5), "Timed out releasing injected association write barrier"
        return original_write(path, data)

    monkeypatch.setattr(module, "atomic_bytes", pause_association)

    def fit_next():
        fit_started.set()
        return publish(app, snapshot, revision=3)

    with ThreadPoolExecutor(max_workers=2) as executor:
        association = executor.submit(app.state.policy_service.associate, body(event, fitted))
        try:
            assert inside_write.wait(5)
            # A separate descriptor cannot acquire the actual C1 user lock while
            # association is between head validation and durable publication.
            with next(tmp_path.glob("*/.lock")).open("a+") as lock:
                with pytest.raises(BlockingIOError):
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            publication = executor.submit(fit_next)
            assert fit_started.wait(5)
            assert not publication.done(), "C1 publication overtook association's locked policy write"
        finally:
            allow_write.set()
        assert association.result(timeout=5)["eligibleForLearning"] is True
        _, newer = publication.result(timeout=5)
    assert associate(app, event, newer)["duplicate"] is True
