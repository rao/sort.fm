"""Reservation migration, durability, and feedback races at the real C1 boundary."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
from threading import Event

import pytest

from sortfm_ml.app import create_app
from sortfm_ml.service import canonical, digest
from test_app import AUTH, fit_payload, request
from test_policy_service import choose, diagnostics, event, selection, uid


START = datetime(2026, 11, 7, 12, 0, tzinfo=timezone.utc)


class Clock:
    def __init__(self):
        self.now = START

    def __call__(self):
        return self.now

    def at(self, seconds):
        self.now = START + timedelta(seconds=seconds)


def application(folder, clock, ttl=300):
    return create_app(shared_secret="test-service-secret", storage_dir=folder,
                      policy_clock=clock, policy_reservation_ttl_seconds=ttl)


def one_candidate(number=1000, **config):
    payload = selection(number, **config)
    row = fit_payload()["examples"][0]
    payload["candidates"] = [{"trackId": row["trackId"], "features": row["features"]}]
    return payload


def release_payload(selected, number=4000):
    return {"userId": selected["userId"], "requestId": uid(number),
            "exposureId": selected["exposureId"], "reason": "abandoned"}


def release(app, selected, number=4000):
    result = request(app, "POST", "/policy/release", AUTH,
                     json=release_payload(selected, number))
    assert result.status_code == 200, result.text
    return result.json()


def inspection(app, selected):
    result = request(app, "GET", "/policy/exposure", AUTH,
                     params={"userId": selected["userId"], "exposureId": selected["exposureId"]})
    assert result.status_code == 200, result.text
    return result.json()


def read_state(folder):
    return json.loads(next(folder.glob("*/policy.json")).read_text())["state"]


def write_state(folder, state):
    next(folder.glob("*/policy.json")).write_bytes(canonical({"state": state, "sha256": digest(state)}))


def legacy_artifact(folder):
    """Create an actual checksum-valid pre-lifecycle ledger without changing retry identity."""
    state = read_state(folder)
    for key in ("schemaVersion", "reservations", "releaseRequests"):
        state.pop(key, None)
    state["version"] = "c2-linucb-v1"
    state["decisions"] = {
        key: {"fingerprint": entry["fingerprint"],
              "response": {**entry["response"], "policyVersion": "c2-linucb-v1"}}
        for key, entry in state["decisions"].items()
    }
    write_state(folder, state)
    snapshots_path = next(folder.glob("*/exposures.json"))
    snapshots = json.loads(snapshots_path.read_text())
    for snapshot in snapshots.values():
        snapshot["policyVersion"] = "c2-linucb-v1"
    snapshots_path.write_bytes(canonical(snapshots))
    return deepcopy(state)


def assert_no_candidate(app, number=1001):
    result = request(app, "POST", "/policy/select", AUTH, json=one_candidate(number))
    assert result.status_code == 409, result.text
    assert result.json()["code"] == "NO_ELIGIBLE_CANDIDATES"


def test_legacy_migration_uses_original_deadline_and_preserves_decisions_snapshots(tmp_path):
    clock = Clock()
    app = application(tmp_path, clock)
    selected = choose(app, one_candidate())
    old = legacy_artifact(tmp_path)
    old_decision = old["decisions"][selected["exposureId"]]["response"]
    snapshots_path = next(tmp_path.glob("*/exposures.json"))
    original_snapshots = snapshots_path.read_bytes()
    clock.at(600)
    restored = application(tmp_path, clock, ttl=900)

    assert choose(restored, one_candidate()) == old_decision
    migrated = read_state(tmp_path)
    assert migrated["schemaVersion"] == 2
    assert migrated["version"] == "c2-linucb-v2"
    assert migrated["decisions"] == old["decisions"]
    assert migrated["events"] == old["events"]
    assert snapshots_path.read_bytes() == original_snapshots
    reservation = inspection(restored, old_decision)["reservation"]
    assert reservation["status"] == "expired"
    assert datetime.fromisoformat(reservation["expiresAt"]) == START + timedelta(seconds=300)
    assert reservation["closedAt"] == reservation["expiresAt"]
    newer = choose(restored, one_candidate(1001))
    assert newer["trackId"] == old_decision["trackId"]
    assert newer["policyVersion"] == "c2-linucb-v2"
    assert newer["step"] == old_decision["step"] + 1


def test_legacy_retry_repairs_missing_prediction_with_original_version(tmp_path):
    clock = Clock()
    app = application(tmp_path, clock)
    selected = choose(app, one_candidate())
    old = legacy_artifact(tmp_path)
    old_decision = old["decisions"][selected["exposureId"]]["response"]
    path = next(tmp_path.glob("*/exposures.json"))
    original = json.loads(path.read_text())[selected["exposureId"]]
    path.write_bytes(canonical({}))
    clock.at(301)

    restored = application(tmp_path, clock)
    assert choose(restored, one_candidate()) == old_decision
    assert json.loads(path.read_text())[selected["exposureId"]] == original
    assert inspection(restored, old_decision)["reservation"]["status"] == "expired"
    assert choose(restored, one_candidate(1001))["trackId"] == selected["trackId"]


@pytest.mark.parametrize("created_at", ["not-a-time", "2026-11-07T12:00:00", "2026-02-30T12:00:00Z"])
def test_legacy_invalid_timestamps_fail_closed_without_overwriting_artifact(tmp_path, created_at):
    clock = Clock()
    app = application(tmp_path, clock)
    selected = choose(app, one_candidate())
    old = legacy_artifact(tmp_path)
    old["decisions"][selected["exposureId"]]["response"]["createdAt"] = created_at
    write_state(tmp_path, old)
    path = next(tmp_path.glob("*/policy.json"))
    original = path.read_bytes()

    result = request(application(tmp_path, clock), "POST", "/policy/select", AUTH,
                     json=one_candidate())
    assert result.status_code == 503, result.text
    assert result.json()["code"] == "POLICY_STATE_UNAVAILABLE"
    assert path.read_bytes() == original


@pytest.mark.parametrize("damage", ["checksum", "future_schema", "missing_reservation"])
def test_lifecycle_corruption_does_not_reset_or_partially_migrate(tmp_path, damage):
    clock = Clock()
    app = application(tmp_path, clock)
    selected = choose(app, one_candidate())
    path = next(tmp_path.glob("*/policy.json"))
    envelope = json.loads(path.read_text())
    if damage == "checksum":
        envelope["sha256"] = "0" * 64
    else:
        if damage == "future_schema":
            envelope["state"]["schemaVersion"] = 100
        else:
            del envelope["state"]["reservations"][selected["exposureId"]]
        envelope["sha256"] = digest(envelope["state"])
    path.write_bytes(canonical(envelope))
    original = path.read_bytes()

    result = request(application(tmp_path, clock), "POST", "/policy/release", AUTH,
                     json=release_payload(selected))
    assert result.status_code == 503, result.text
    assert result.json()["code"] == "POLICY_STATE_UNAVAILABLE"
    assert path.read_bytes() == original


def test_release_closure_and_idempotency_receipt_commit_atomically(tmp_path, monkeypatch):
    import sortfm_ml.policy_service as policy_module
    clock = Clock()
    app = application(tmp_path, clock)
    selected = choose(app, one_candidate())
    path = next(tmp_path.glob("*/policy.json"))
    original = path.read_bytes()
    atomic_write = policy_module.atomic_bytes

    def fail_policy_write(target, data):
        if target.name == "policy.json":
            raise OSError("injected before atomic publication")
        return atomic_write(target, data)

    monkeypatch.setattr(policy_module, "atomic_bytes", fail_policy_write)
    failed = request(app, "POST", "/policy/release", AUTH, json=release_payload(selected))
    assert failed.status_code == 503, failed.text
    assert path.read_bytes() == original
    monkeypatch.setattr(policy_module, "atomic_bytes", atomic_write)

    restored = application(tmp_path, clock)
    assert inspection(restored, selected)["reservation"]["status"] == "active"
    assert uid(4000) not in read_state(tmp_path)["releaseRequests"]
    receipt = release(restored, selected)
    stored = read_state(tmp_path)
    assert stored["reservations"][selected["exposureId"]]["status"] == "released"
    assert stored["releaseRequests"][uid(4000)]["response"] == receipt
    clock.at(1000)
    assert release(application(tmp_path, clock), selected) == receipt
    assert choose(restored, one_candidate()) == selected


def test_expiry_write_failure_does_not_claim_durability_and_terminal_closure_survives_rollback(tmp_path, monkeypatch):
    import sortfm_ml.policy_service as policy_module
    clock = Clock()
    app = application(tmp_path, clock)
    selected = choose(app, one_candidate())
    path = next(tmp_path.glob("*/policy.json"))
    original = path.read_bytes()
    atomic_write = policy_module.atomic_bytes

    def fail_policy_write(target, data):
        if target.name == "policy.json":
            raise OSError("injected expiry write failure")
        return atomic_write(target, data)

    clock.at(300)
    monkeypatch.setattr(policy_module, "atomic_bytes", fail_policy_write)
    failed = request(app, "GET", "/policy/exposure", AUTH,
                     params={"userId": selected["userId"], "exposureId": selected["exposureId"]})
    assert failed.status_code == 503, failed.text
    assert path.read_bytes() == original
    monkeypatch.setattr(policy_module, "atomic_bytes", atomic_write)
    clock.at(200)
    assert inspection(application(tmp_path, clock), selected)["reservation"]["status"] == "active"
    clock.at(300)
    expired = inspection(app, selected)["reservation"]
    assert expired["status"] == "expired"
    clock.at(100)
    restored = application(tmp_path, clock)
    replay = inspection(restored, selected)["reservation"]
    assert replay["status"] == "expired"
    assert replay["closedAt"] == expired["closedAt"]
    assert choose(restored, one_candidate(1001))["trackId"] == selected["trackId"]


def test_existing_valid_undo_is_not_resurrected_by_v1_migration(tmp_path):
    clock = Clock()
    app = application(tmp_path, clock)
    selected = choose(app, one_candidate())
    observed = event(selected)
    assert request(app, "POST", "/observe", AUTH, json=observed).status_code == 200
    undo = {**observed, "eventId": uid(2001), "feedbackRevision": 2,
            "operation": "revoke", "label": None}
    assert request(app, "POST", "/observe", AUTH, json=undo).status_code == 200
    old = legacy_artifact(tmp_path)
    clock.at(10)
    restored = application(tmp_path, clock)

    newer = choose(restored, one_candidate(1001))
    assert newer["trackId"] == selected["trackId"]
    previous = inspection(restored, selected)
    assert previous["decision"] == old["decisions"][selected["exposureId"]]["response"]
    assert previous["reservation"]["status"] == "released"
    assert previous["reservation"]["closureReason"] == "undo"
    assert diagnostics(restored)["counts"]["activeRewards"] == 0


def test_legacy_stale_undo_does_not_unsuppress_newer_committed_review(tmp_path):
    clock = Clock()
    app = application(tmp_path, clock)
    selected = choose(app, one_candidate())
    first = event(selected)
    assert request(app, "POST", "/observe", AUTH, json=first).status_code == 200
    newer = {**first, "decisionId": uid(3001), "eventId": uid(2001), "feedbackRevision": 2}
    assert request(app, "POST", "/observe", AUTH, json=newer).status_code == 200
    old_undo = {**first, "eventId": uid(2002), "feedbackRevision": 3,
                "operation": "revoke", "label": None}
    assert request(app, "POST", "/observe", AUTH, json=old_undo).status_code == 200
    legacy_artifact(tmp_path)
    clock.at(301)
    restored = application(tmp_path, clock)

    assert_no_candidate(restored)
    assert inspection(restored, selected)["reservation"]["status"] == "expired"
    assert diagnostics(restored)["counts"]["committedEvents"] == 3


@pytest.mark.parametrize("closure", ["release", "expiry"])
def test_delayed_feedback_for_closed_exposure_keeps_reward_and_protects_newer_lease(tmp_path, closure):
    clock = Clock()
    app = application(tmp_path, clock)
    assert request(app, "POST", "/fit", AUTH, json=fit_payload()).status_code == 200
    old = choose(app, one_candidate())
    if closure == "release":
        release(app, old)
    else:
        clock.at(300)
        assert inspection(app, old)["reservation"]["status"] == "expired"
    newer = choose(app, one_candidate(1001))
    delayed = event(old, revision=2)
    accepted = request(app, "POST", "/policy/feedback", AUTH, json={**delayed, "usefulness": .25})
    assert accepted.status_code == 200, accepted.text
    assert diagnostics(app)["counts"]["activeRewards"] == 1
    original_new_lease = inspection(app, newer)["reservation"]
    assert original_new_lease["status"] == "active"
    assert release(app, old, number=4001)["outcome"] == "already_closed"
    assert inspection(app, newer)["reservation"] == original_new_lease
    assert_no_candidate(app, number=1002)
    clock.at(1000)
    assert_no_candidate(app, number=1002)
    assert diagnostics(app)["counts"]["activeRewards"] == 1
    assert choose(app, one_candidate()) == old


def test_old_undo_after_delayed_new_review_cannot_close_new_exposure(tmp_path):
    clock = Clock()
    app = application(tmp_path, clock)
    old = choose(app, one_candidate())
    release(app, old)
    newer = choose(app, one_candidate(1001))
    first = event(old)
    assert request(app, "POST", "/observe", AUTH, json=first).status_code == 200
    second = {**event(newer, number=2001, revision=2), "decisionId": uid(3001), "label": 0}
    assert request(app, "POST", "/observe", AUTH, json=second).status_code == 200
    stale = {**first, "eventId": uid(2002), "feedbackRevision": 3,
             "operation": "revoke", "label": None}
    assert request(app, "POST", "/observe", AUTH, json=stale).status_code == 200
    assert inspection(app, newer)["reservation"]["status"] == "active"
    assert_no_candidate(app, number=1002)
    clock.at(400)
    assert_no_candidate(app, number=1002)


def test_release_and_select_serialize_under_the_same_user_lock(tmp_path, monkeypatch):
    import sortfm_ml.policy_service as policy_module
    clock = Clock()
    app = application(tmp_path, clock)
    selected = choose(app, one_candidate())
    write_entered, allow_write, selection_started = Event(), Event(), Event()
    atomic_write = policy_module.atomic_bytes

    def pause_release_write(target, data):
        if target.name == "policy.json" and uid(4000) in json.loads(data)["state"].get("releaseRequests", {}):
            write_entered.set()
            assert allow_write.wait(10), "release write was never unblocked"
        return atomic_write(target, data)

    def next_selection():
        selection_started.set()
        return choose(application(tmp_path, clock), one_candidate(1001))

    monkeypatch.setattr(policy_module, "atomic_bytes", pause_release_write)
    with ThreadPoolExecutor(max_workers=2) as executor:
        released = executor.submit(release, app, selected)
        try:
            assert write_entered.wait(10), "release failed to enter durable write"
            next_selected = executor.submit(next_selection)
            assert selection_started.wait(10)
            assert not next_selected.done(), "selection passed the lock before release publication"
        finally:
            allow_write.set()
        receipt, newer = released.result(timeout=10), next_selected.result(timeout=10)
    assert receipt["outcome"] == "released"
    assert newer["trackId"] == selected["trackId"]
    assert inspection(app, newer)["reservation"]["status"] == "active"
    assert read_state(tmp_path)["releaseRequests"][uid(4000)]["response"] == receipt


def test_pending_c1_observe_does_not_extend_expiry_or_get_cancelled_by_release(tmp_path, monkeypatch):
    clock = Clock()
    app = application(tmp_path, clock)
    assert request(app, "POST", "/fit", AUTH, json=fit_payload()).status_code == 200
    selected = choose(app, one_candidate())
    staged, allow_c1_commit = Event(), Event()
    models = app.state.model_service
    original_observe = models.observe

    def delayed_observe(payload):
        staged.set()
        assert allow_c1_commit.wait(10), "C1 commit was never unblocked"
        return original_observe(payload)

    monkeypatch.setattr(models, "observe", delayed_observe)
    with ThreadPoolExecutor(max_workers=1) as executor:
        pending = executor.submit(request, app, "POST", "/policy/feedback", AUTH,
                                  json={**event(selected, revision=2), "usefulness": .5})
        try:
            assert staged.wait(10), "feedback did not stage its intent"
            assert diagnostics(app)["counts"]["pendingEvents"] == 1
            assert diagnostics(app)["counts"]["activeRewards"] == 0
            clock.at(300)
            assert inspection(app, selected)["reservation"]["status"] == "expired"
            newer = choose(app, one_candidate(1001))
            assert release(app, selected)["outcome"] == "already_closed"
            assert diagnostics(app)["counts"]["pendingEvents"] == 1
            assert inspection(app, newer)["reservation"]["status"] == "active"
        finally:
            allow_c1_commit.set()
        committed = pending.result(timeout=10)
    assert committed.status_code == 200, committed.text
    summary = diagnostics(app)
    assert summary["counts"]["pendingEvents"] == 0
    assert summary["counts"]["activeRewards"] == 1
    assert summary["counts"]["committedEvents"] == 1
    assert_no_candidate(app, number=1002)
    clock.at(700)
    assert_no_candidate(app, number=1002)
    assert choose(app, one_candidate()) == selected


@pytest.mark.parametrize("operation", ["replay", "conflict", "unknown"])
def test_release_replay_or_error_durably_reconciles_other_expired_leases(tmp_path, operation):
    clock = Clock()
    app = application(tmp_path, clock)
    old = choose(app, one_candidate())
    receipt = release(app, old)
    newer = choose(app, one_candidate(1001))
    clock.at(301)
    payload = release_payload(old)
    expected_status = 200
    if operation == "conflict":
        payload["reason"] = "skip"
        expected_status = 409
    elif operation == "unknown":
        payload.update(requestId=uid(4001), exposureId=uid(9999))
        expected_status = 404

    response = request(app, "POST", "/policy/release", AUTH, json=payload)
    assert response.status_code == expected_status, response.text
    if operation == "replay":
        assert response.json() == receipt
    # Inspect the disk before any read endpoint can conceal a missed publication.
    persisted = read_state(tmp_path)
    lease = persisted["reservations"][newer["exposureId"]]
    assert lease["status"] == "expired"
    assert lease["closedAt"] == lease["expiresAt"]
    assert persisted["releaseRequests"][uid(4000)]["response"] == receipt
    assert uid(4001) not in persisted["releaseRequests"]
    clock.at(100)
    restored = application(tmp_path, clock)
    assert inspection(restored, newer)["reservation"]["status"] == "expired"


def test_fresh_release_of_expired_lease_publishes_expiry_and_receipt_atomically(tmp_path, monkeypatch):
    import sortfm_ml.policy_service as policy_module
    clock = Clock()
    app = application(tmp_path, clock)
    selected = choose(app, one_candidate())
    path = next(tmp_path.glob("*/policy.json"))
    original = path.read_bytes()
    atomic_write = policy_module.atomic_bytes
    writes = []

    def fail_receipt_transaction(target, data):
        if target.name == "policy.json":
            writes.append(json.loads(data)["state"])
            raise OSError("injected expiry and receipt publication failure")
        return atomic_write(target, data)

    clock.at(301)
    monkeypatch.setattr(policy_module, "atomic_bytes", fail_receipt_transaction)
    response = request(app, "POST", "/policy/release", AUTH, json=release_payload(selected))
    assert response.status_code == 503, response.text
    assert len(writes) == 1
    assert writes[0]["reservations"][selected["exposureId"]]["status"] == "expired"
    assert uid(4000) in writes[0]["releaseRequests"]
    assert path.read_bytes() == original
    monkeypatch.setattr(policy_module, "atomic_bytes", atomic_write)
    clock.at(100)
    assert inspection(application(tmp_path, clock), selected)["reservation"]["status"] == "active"
    clock.at(301)
    receipt = release(app, selected)
    state = read_state(tmp_path)
    lease = state["reservations"][selected["exposureId"]]
    assert receipt["outcome"] == "already_closed"
    assert lease["status"] == "expired"
    assert receipt["effectiveClosedAt"] == receipt["expiresAt"] == lease["closedAt"]
    assert state["releaseRequests"][uid(4000)]["response"] == receipt


@pytest.mark.parametrize("damage", ["receipt_track", "receipt_exposure", "request_fingerprint",
                                    "receipt_deadline", "receipt_closed_at", "request_unknown_exposure",
                                    "receipt_request_id", "lease_exposure", "lease_created_at", "missing_lease"])
def test_checksum_valid_receipt_or_lease_reference_corruption_fails_closed(tmp_path, damage):
    clock = Clock()
    app = application(tmp_path, clock)
    selected = choose(app, one_candidate())
    release(app, selected)
    newer = choose(app, one_candidate(1001))
    state = read_state(tmp_path)
    record = state["releaseRequests"][uid(4000)]
    lease = state["reservations"][selected["exposureId"]]
    if damage == "receipt_track":
        record["response"]["trackId"] = "demo:some-other-track"
    elif damage == "receipt_exposure":
        record["response"]["exposureId"] = newer["exposureId"]
    elif damage == "request_fingerprint":
        record["fingerprint"] = "0" * 64
    elif damage == "receipt_deadline":
        record["response"]["expiresAt"] = (START + timedelta(seconds=301)).isoformat()
    elif damage == "receipt_closed_at":
        record["response"]["effectiveClosedAt"] = (START + timedelta(seconds=1)).isoformat()
    elif damage == "request_unknown_exposure":
        record["request"]["exposureId"] = uid(9999)
        record["response"]["exposureId"] = uid(9999)
        record["fingerprint"] = digest(record["request"])
    elif damage == "receipt_request_id":
        record["response"]["requestId"] = uid(4001)
    elif damage == "lease_exposure":
        lease["exposureId"] = newer["exposureId"]
    elif damage == "lease_created_at":
        lease["reservedAt"] = (START - timedelta(seconds=1)).isoformat()
    else:
        del state["reservations"][selected["exposureId"]]
    write_state(tmp_path, state)
    path = next(tmp_path.glob("*/policy.json"))
    original = path.read_bytes()

    response = request(application(tmp_path, clock), "POST", "/policy/release", AUTH,
                       json=release_payload(selected))
    assert response.status_code == 503, response.text
    assert response.json()["code"] == "POLICY_STATE_UNAVAILABLE"
    assert path.read_bytes() == original


@pytest.mark.parametrize("damage", ["partial_new_ledger", "new_decision_metadata", "unsupported_version"])
def test_checksum_valid_unsupported_legacy_shapes_are_not_migrated(tmp_path, damage):
    clock = Clock()
    app = application(tmp_path, clock)
    selected = choose(app, one_candidate())
    state = legacy_artifact(tmp_path)
    if damage == "partial_new_ledger":
        state["reservations"] = {}
    elif damage == "new_decision_metadata":
        state["decisions"][selected["exposureId"]]["eligibility"] = {
            "evaluatedAt": START.isoformat(), "filteringApplied": True, "exclusions": []}
    else:
        state["version"] = "c2-linucb-v0"
    write_state(tmp_path, state)
    path = next(tmp_path.glob("*/policy.json"))
    original = path.read_bytes()

    response = request(application(tmp_path, clock), "GET", "/policy/exposure", AUTH,
                       params={"userId": selected["userId"], "exposureId": selected["exposureId"]})
    assert response.status_code == 503, response.text
    assert response.json()["code"] == "POLICY_STATE_UNAVAILABLE"
    assert path.read_bytes() == original


@pytest.mark.parametrize("damage", ["missing_primary", "duplicate_primary", "primary_recorded_at"])
def test_explicit_release_requires_one_matching_primary_receipt(tmp_path, damage):
    clock = Clock()
    app = application(tmp_path, clock)
    selected = choose(app, one_candidate())
    release(app, selected)
    state = read_state(tmp_path)
    if damage == "missing_primary":
        state["releaseRequests"] = {}
    elif damage == "duplicate_primary":
        duplicate = deepcopy(state["releaseRequests"][uid(4000)])
        duplicate["request"]["requestId"] = uid(4001)
        duplicate["response"]["requestId"] = uid(4001)
        duplicate["fingerprint"] = digest(duplicate["request"])
        state["releaseRequests"][uid(4001)] = duplicate
    else:
        state["releaseRequests"][uid(4000)]["response"]["recordedAt"] = (START + timedelta(seconds=1)).isoformat()
    write_state(tmp_path, state)
    path = next(tmp_path.glob("*/policy.json"))
    original = path.read_bytes()

    response = request(application(tmp_path, clock), "GET", "/policy/exposure", AUTH,
                       params={"userId": selected["userId"], "exposureId": selected["exposureId"]})
    assert response.status_code == 503, response.text
    assert response.json()["code"] == "POLICY_STATE_UNAVAILABLE"
    assert path.read_bytes() == original


@pytest.mark.parametrize("damage", ["duplicate_tracks", "foreign_track", "duplicate_blocker",
                                    "unknown_blocker", "wrong_track_blocker", "future_blocker",
                                    "wrong_filtering", "selected_excluded", "wrong_available_count",
                                    "c1_wrong_available_count"])
def test_checksum_valid_eligibility_audit_corruption_fails_closed(tmp_path, damage):
    clock = Clock()
    app = application(tmp_path, clock)
    first = choose(app, selection())
    second = choose(app, selection(1001))
    assert first["trackId"] != second["trackId"]
    third_payload = selection(1002, strategy="c1")
    third_payload["candidates"] = [first["candidate"]]
    third = choose(app, third_payload)
    assert third["trackId"] == first["trackId"]
    state = read_state(tmp_path)
    entry = state["decisions"][second["exposureId"]]
    snapshot = entry["eligibility"]
    exclusion = snapshot["exclusions"][0]
    assert exclusion["trackId"] == first["trackId"]
    if damage == "duplicate_tracks":
        snapshot["exclusions"].append(deepcopy(exclusion))
    elif damage == "foreign_track":
        exclusion["trackId"] = "demo:outside-candidate-set"
    elif damage == "duplicate_blocker":
        exclusion["blockingExposureIds"] *= 2
    elif damage == "unknown_blocker":
        exclusion["blockingExposureIds"] = [uid(9999)]
    elif damage == "wrong_track_blocker":
        exclusion["blockingExposureIds"] = [second["exposureId"]]
    elif damage == "future_blocker":
        exclusion["blockingExposureIds"] = [third["exposureId"]]
    elif damage == "wrong_filtering":
        snapshot["filteringApplied"] = False
    elif damage == "selected_excluded":
        exclusion.update(trackId=second["trackId"], blockingExposureIds=[], completedReview=True)
    elif damage == "wrong_available_count":
        entry["response"]["availableCount"] += 1
    else:
        state["decisions"][third["exposureId"]]["response"]["availableCount"] = 0
    write_state(tmp_path, state)
    path = next(tmp_path.glob("*/policy.json"))
    original = path.read_bytes()

    response = request(application(tmp_path, clock), "GET", "/policy/exposure", AUTH,
                       params={"userId": second["userId"], "exposureId": second["exposureId"]})
    assert response.status_code == 503, response.text
    assert response.json()["code"] == "POLICY_STATE_UNAVAILABLE"
    assert path.read_bytes() == original
