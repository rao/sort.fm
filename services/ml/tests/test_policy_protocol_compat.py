"""Synthetic-only C2 v3 pinning, eligibility parity, and immutable migrations."""
from copy import deepcopy
from datetime import datetime, timezone
import json

import pytest

from sortfm_ml.app import create_app
from sortfm_ml.service import canonical, digest
from test_app import AUTH, fit_payload, request
from test_policy_service import choose, diagnostics, event, selection, uid


STRATEGIES = ["c1", "epsilon_greedy", "linucb", "random"]


def app_at(folder):
    return create_app(shared_secret="test-service-secret", storage_dir=folder,
                      policy_clock=lambda: datetime(2026, 11, 7, 12, tzinfo=timezone.utc))


def fit(app, revision=1):
    payload = {**fit_payload(), "feedbackRevision": revision}
    result = request(app, "POST", "/fit", AUTH, json=payload)
    assert result.status_code == 200, result.text
    return result.json()


def single(number=1000, strategy="linucb", candidate_index=0):
    payload = selection(number, strategy=strategy)
    payload["candidates"] = [payload["candidates"][candidate_index]]
    return payload


def pin(payload, fitted):
    return {**payload, "modelVersion": fitted["modelVersion"], "feedbackRevision": fitted["feedbackRevision"]}


def inspect(app, selected):
    result = request(app, "GET", "/policy/exposure", AUTH,
                     params={"userId": selected["userId"], "exposureId": selected["exposureId"]})
    assert result.status_code == 200, result.text
    return result.json()


def release(app, selected, number=4000):
    result = request(app, "POST", "/policy/release", AUTH,
                     json={"userId": selected["userId"], "requestId": uid(number),
                           "exposureId": selected["exposureId"], "reason": "abandoned"})
    assert result.status_code == 200, result.text
    return result.json()


def read_state(folder):
    return json.loads(next(folder.glob("*/policy.json")).read_text())["state"]


def write_state(folder, state):
    next(folder.glob("*/policy.json")).write_bytes(canonical({"state": state, "sha256": digest(state)}))


def downgrade(folder, version):
    """Produce a checksum-valid older-format synthetic ledger without rehashing requests."""
    state = read_state(folder)
    state.pop("associations", None)
    state["version"] = f"c2-linucb-v{version}"
    if version == 1:
        for key in ("schemaVersion", "reservations", "releaseRequests"):
            state.pop(key, None)
    else:
        state["schemaVersion"] = 2
    for entry in state["decisions"].values():
        entry["response"].pop("feedbackRevision", None)
        entry["response"]["policyVersion"] = state["version"]
        if version == 1:
            entry.pop("eligibility", None)
        elif entry["response"]["config"]["strategy"] == "c1":
            entry["eligibility"]["filteringApplied"] = False
    write_state(folder, state)
    path = next(folder.glob("*/exposures.json"))
    snapshots = json.loads(path.read_text())
    for snapshot in snapshots.values():
        snapshot["policyVersion"] = state["version"]
    path.write_bytes(canonical(snapshots))
    return deepcopy(state)


@pytest.mark.parametrize("strategy", STRATEGIES)
def test_fresh_pinned_selection_reports_actual_current_feedback_revision(tmp_path, strategy):
    app = app_at(tmp_path)
    fitted = fit(app)
    selected = choose(app, pin(single(strategy=strategy), fitted))
    assert selected["modelVersion"] == fitted["modelVersion"]
    assert selected["feedbackRevision"] == fitted["feedbackRevision"] == 1
    assert selected["policyVersion"] == "c2-linucb-v3"
    assert inspect(app, selected)["decision"] == selected


def test_unpinned_legacy_selection_reports_selected_bundle_revision_not_current_head(tmp_path):
    app = app_at(tmp_path)
    old = fit(app)
    current = fit(app, revision=2)
    assert old["modelVersion"] != current["modelVersion"]
    historical = {**single(), "modelVersion": old["modelVersion"]}
    selected = choose(app, historical)
    assert selected["modelVersion"] == old["modelVersion"]
    assert selected["feedbackRevision"] == 1
    fresh = choose(app, single(1001, candidate_index=1))
    assert fresh["feedbackRevision"] == 2
    assert fresh["modelVersion"] == current["modelVersion"]


def test_cold_legacy_request_does_not_invent_published_feedback_revision(tmp_path):
    selected = choose(app_at(tmp_path), single())
    assert selected["feedbackRevision"] is None


def test_legitimate_published_revision_zero_is_distinct_from_cold_state(tmp_path):
    app = app_at(tmp_path)
    fitted = fit(app, revision=0)
    selected = choose(app, pin(single(), fitted))
    assert selected["feedbackRevision"] == 0
    assert selected["modelVersion"] == fitted["modelVersion"]


@pytest.mark.parametrize("bad_revision", [None, -1, True, 1.5, "1"])
def test_feedback_revision_uses_strict_existing_count_validation(tmp_path, bad_revision):
    app = app_at(tmp_path)
    fitted = fit(app)
    payload = {**pin(single(), fitted), "feedbackRevision": bad_revision}
    result = request(app, "POST", "/policy/select", AUTH, json=payload)
    assert result.status_code == 422, result.text


@pytest.mark.parametrize("model_field", ["absent", "null"])
def test_revision_requires_explicit_nonnull_model_pin(tmp_path, model_field):
    app = app_at(tmp_path)
    payload = {**single(), "feedbackRevision": 0}
    if model_field == "absent":
        del payload["modelVersion"]
    result = request(app, "POST", "/policy/select", AUTH, json=payload)
    assert result.status_code == 422, result.text
    assert diagnostics(app)["counts"]["exposures"] == 0


@pytest.mark.parametrize("pin_kind", ["stale_pair", "old_model_current_revision", "current_model_old_revision", "future_revision"])
def test_fresh_selection_rejects_any_pin_other_than_exact_published_head(tmp_path, pin_kind):
    app = app_at(tmp_path)
    old = fit(app)
    current = fit(app, revision=2)
    payload = pin(single(), old if pin_kind == "stale_pair" else current)
    if pin_kind == "old_model_current_revision":
        payload["modelVersion"] = old["modelVersion"]
    elif pin_kind == "current_model_old_revision":
        payload["feedbackRevision"] = 1
    elif pin_kind == "future_revision":
        payload["feedbackRevision"] = 3
    result = request(app, "POST", "/policy/select", AUTH, json=payload)
    assert result.status_code == 409, result.text
    assert diagnostics(app)["counts"]["exposures"] == 0


def test_pinned_historical_retry_precedes_current_head_check_without_renewing_lease(tmp_path):
    app = app_at(tmp_path)
    fitted = fit(app)
    payload = pin(single(), fitted)
    selected = choose(app, payload)
    receipt = release(app, selected)
    original_lease = inspect(app, selected)["reservation"]
    current = fit(app, revision=2)
    restored = app_at(tmp_path)
    assert choose(restored, payload) == selected
    assert inspect(restored, selected)["reservation"] == original_lease
    assert release(restored, selected) == receipt
    changed = pin(payload, current)
    conflict = request(restored, "POST", "/policy/select", AUTH, json=changed)
    assert conflict.status_code == 409, conflict.text
    assert diagnostics(restored)["counts"]["exposures"] == 1


@pytest.mark.parametrize("strategy", STRATEGIES)
def test_every_fresh_strategy_obeys_same_live_reservation_filter(tmp_path, strategy):
    app = app_at(tmp_path)
    first = choose(app, single())
    result = request(app, "POST", "/policy/select", AUTH, json=single(1001, strategy))
    assert result.status_code == 409, result.text
    assert result.json()["code"] == "NO_ELIGIBLE_CANDIDATES"
    release(app, first)
    selected = choose(app, single(1001, strategy))
    assert selected["trackId"] == first["trackId"]
    assert inspect(app, selected)["eligibility"]["filteringApplied"] is True


@pytest.mark.parametrize("strategy", STRATEGIES)
def test_every_fresh_strategy_obeys_same_completed_review_filter_after_release(tmp_path, strategy):
    app = app_at(tmp_path)
    first = choose(app, single())
    observed = request(app, "POST", "/observe", AUTH, json=event(first))
    assert observed.status_code == 200, observed.text
    release(app, first)
    result = request(app, "POST", "/policy/select", AUTH, json=single(1001, strategy))
    assert result.status_code == 409, result.text
    assert result.json()["code"] == "NO_ELIGIBLE_CANDIDATES"


@pytest.mark.parametrize("strategy", STRATEGIES)
def test_every_strategy_selects_from_identical_remaining_candidate_set(tmp_path, strategy):
    app = app_at(tmp_path)
    reserved = choose(app, single())
    reviewed = choose(app, single(1001, candidate_index=1))
    assert request(app, "POST", "/observe", AUTH, json=event(reviewed)).status_code == 200
    release(app, reviewed)
    payload = selection(1002, strategy=strategy)
    payload["candidates"] = payload["candidates"][:3]
    selected = choose(app, payload)
    assert selected["trackId"] == payload["candidates"][2]["trackId"]
    assert selected["availableCount"] == 1
    audit = inspect(app, selected)["eligibility"]
    assert audit["filteringApplied"] is True
    assert audit["exclusions"] == [
        {"trackId": reserved["trackId"], "blockingExposureIds": [reserved["exposureId"]], "completedReview": False},
        {"trackId": reviewed["trackId"], "blockingExposureIds": [], "completedReview": True},
    ]
    if strategy == "c1":
        assert selected["rankedTrackIds"] == [selected["trackId"]]


@pytest.mark.parametrize("old_version", [1, 2])
def test_old_storage_migrates_without_rewriting_decisions_or_prediction_snapshots(tmp_path, old_version):
    app = app_at(tmp_path)
    selected = choose(app, single())
    old = downgrade(tmp_path, old_version)
    frozen = old["decisions"][selected["exposureId"]]["response"]
    snapshots = next(tmp_path.glob("*/exposures.json"))
    snapshot_bytes = snapshots.read_bytes()
    restored = app_at(tmp_path)
    assert choose(restored, single()) == frozen
    migrated = read_state(tmp_path)
    assert migrated["version"] == "c2-linucb-v3"
    assert migrated["schemaVersion"] == 3
    assert migrated["associations"] == {}
    assert migrated["decisions"] == old["decisions"]
    assert migrated["events"] == old["events"]
    if old_version == 2:
        assert migrated["reservations"] == old["reservations"]
        assert migrated["releaseRequests"] == old["releaseRequests"]
    assert snapshots.read_bytes() == snapshot_bytes
    assert "feedbackRevision" not in choose(restored, single())


def test_v2_release_receipts_remain_immutable_through_schema3_migration(tmp_path):
    app = app_at(tmp_path)
    selected = choose(app, single())
    receipt = release(app, selected)
    old = downgrade(tmp_path, 2)
    restored = app_at(tmp_path)
    assert release(restored, selected) == receipt
    migrated = read_state(tmp_path)
    assert migrated["schemaVersion"] == 3
    assert migrated["releaseRequests"] == old["releaseRequests"]
    assert migrated["reservations"] == old["reservations"]
    assert migrated["decisions"] == old["decisions"]


def test_v2_c1_bypassed_filter_history_replays_unchanged_but_new_c1_cannot_bypass(tmp_path):
    app = app_at(tmp_path)
    first_payload, second_payload = single(strategy="c1"), single(1001, "c1")
    first = choose(app, first_payload)
    release(app, first)
    second = choose(app, second_payload)
    old = downgrade(tmp_path, 2)
    # v2 legitimately allowed multiple live C1 exposures for one track. Recreate
    # that history; the preserved request fingerprints were generated by the API.
    old["reservations"][first["exposureId"]].update(status="active", closedAt=None, closureReason=None)
    old["releaseRequests"] = {}
    old["decisions"][second["exposureId"]]["eligibility"]["exclusions"] = [
        {"trackId": first["trackId"], "blockingExposureIds": [first["exposureId"]], "completedReview": False}
    ]
    write_state(tmp_path, old)
    restored = app_at(tmp_path)
    assert choose(restored, first_payload) == old["decisions"][first["exposureId"]]["response"]
    assert choose(restored, second_payload) == old["decisions"][second["exposureId"]]["response"]
    assert inspect(restored, second)["eligibility"]["filteringApplied"] is False
    assert read_state(tmp_path)["decisions"] == old["decisions"]
    result = request(restored, "POST", "/policy/select", AUTH, json=single(1002, "c1"))
    assert result.status_code == 409, result.text
    assert result.json()["code"] == "NO_ELIGIBLE_CANDIDATES"


@pytest.mark.parametrize("old_version", [1, 2])
def test_old_snapshot_repair_retains_original_policy_tag_and_missing_revision(tmp_path, old_version):
    app = app_at(tmp_path)
    selected = choose(app, single())
    old = downgrade(tmp_path, old_version)
    snapshots = next(tmp_path.glob("*/exposures.json"))
    original = json.loads(snapshots.read_text())[selected["exposureId"]]
    snapshots.write_bytes(canonical({}))
    result = choose(app_at(tmp_path), single())
    assert result == old["decisions"][selected["exposureId"]]["response"]
    assert "feedbackRevision" not in result
    assert json.loads(snapshots.read_text())[selected["exposureId"]] == original


@pytest.mark.parametrize("damage", ["missing_map", "array_map", "nonobject_entry"])
def test_schema3_association_container_corruption_fails_closed(tmp_path, damage):
    app = app_at(tmp_path)
    selected = choose(app, single())
    state = read_state(tmp_path)
    assert state["schemaVersion"] == 3
    if damage == "missing_map":
        del state["associations"]
    elif damage == "array_map":
        state["associations"] = []
    else:
        state["associations"][uid(9000)] = []
    write_state(tmp_path, state)
    path = next(tmp_path.glob("*/policy.json"))
    original = path.read_bytes()
    response = request(app_at(tmp_path), "GET", "/policy/exposure", AUTH,
                       params={"userId": selected["userId"], "exposureId": selected["exposureId"]})
    assert response.status_code == 503, response.text
    assert response.json()["code"] == "POLICY_STATE_UNAVAILABLE"
    assert path.read_bytes() == original


@pytest.mark.parametrize("damage", ["event_id", "owner_fingerprint", "track", "policy_tag",
                                    "prediction_model", "features", "receipt_revision", "receipt_model",
                                    "fit_fingerprint", "recorded_at", "duplicate_sequence",
                                    "exposure_decision_rebind"])
def test_checksum_valid_association_evidence_corruption_fails_closed(tmp_path, damage):
    from test_policy_association import associate, prepare
    app, clock, selected, cleanup, _, fitted = prepare(tmp_path)
    associate(app, cleanup, fitted)
    state = read_state(tmp_path)
    entry = state["associations"][cleanup["eventId"]]
    stored_event = entry["event"]
    if damage == "event_id":
        stored_event["eventId"] = uid(9000)
    elif damage == "owner_fingerprint":
        entry["fingerprint"] = digest({"userId": "demo:another-owner", "event": stored_event})
    elif damage == "track":
        stored_event["trackId"] = "demo:another-track"
    elif damage == "policy_tag":
        stored_event["policyVersion"] = "c2-linucb-v1"
    elif damage == "prediction_model":
        stored_event["modelVersion"] = fitted["modelVersion"]
        assert stored_event["modelVersion"] != selected["modelVersion"]
    elif damage == "features":
        stored_event["features"]["values"]["energy"] = .333
    elif damage == "receipt_revision":
        entry["fitReceipt"]["synchronizedFeedbackRevision"] = cleanup["feedbackRevision"] - 1
    elif damage == "receipt_model":
        entry["fitReceipt"]["modelVersion"] = selected["modelVersion"]
    elif damage == "fit_fingerprint":
        entry["fitFingerprint"] = "0" * 64
    elif damage == "recorded_at":
        entry["recordedAt"] = "2026-11-07T12:00:00"
    else:
        duplicate = deepcopy(entry)
        duplicate["event"]["eventId"] = uid(9000)
        if damage == "exposure_decision_rebind":
            duplicate["event"]["sequence"] += 1
            duplicate["event"]["decisionId"] = uid(9001)
        duplicate["fingerprint"] = digest({"userId": state["userId"], "event": duplicate["event"]})
        state["associations"][uid(9000)] = duplicate
    if damage != "owner_fingerprint":
        entry["fingerprint"] = digest({"userId": state["userId"], "event": stored_event})
    write_state(tmp_path, state)
    path = next(tmp_path.glob("*/policy.json"))
    original = path.read_bytes()
    restored = create_app(shared_secret="test-service-secret", storage_dir=tmp_path, policy_clock=clock)
    response = request(restored, "GET", "/policy/exposure", AUTH,
                       params={"userId": selected["userId"], "exposureId": selected["exposureId"]})
    assert response.status_code == 503, response.text
    assert response.json()["code"] == "POLICY_STATE_UNAVAILABLE"
    assert path.read_bytes() == original
