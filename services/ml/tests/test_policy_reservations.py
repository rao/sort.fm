"""Behavioral lease tests across the authenticated C2/C1 service boundary."""
from datetime import datetime, timedelta, timezone

import pytest

from sortfm_ml.app import create_app
from sortfm_ml.policy_service import PolicyService
from sortfm_ml.service import ModelService
from test_app import AUTH, fit_payload, request
from test_policy_service import choose, diagnostics, event, selection, uid


class Clock:
    def __init__(self):
        self.now = datetime(2026, 11, 7, 12, tzinfo=timezone.utc)

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += timedelta(seconds=seconds)


def stamp(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def make_app(path, clock, ttl=300):
    return create_app(shared_secret="test-service-secret", storage_dir=path,
                      policy_clock=clock, policy_reservation_ttl_seconds=ttl)


def single(number=1000, **options):
    payload = selection(number, **options)
    payload["candidates"] = payload["candidates"][:1]
    return payload


def inspect(app, selected, user="demo:alice"):
    result = request(app, "GET", "/policy/exposure", AUTH,
                     params={"userId": user, "exposureId": selected["exposureId"]})
    assert result.status_code == 200, result.text
    return result.json()


def release_payload(selected, number=5000, reason="abandoned", user="demo:alice"):
    return {"userId": user, "requestId": uid(number),
            "exposureId": selected["exposureId"], "reason": reason}


def release(app, selected, number=5000, reason="abandoned", user="demo:alice"):
    result = request(app, "POST", "/policy/release", AUTH,
                     json=release_payload(selected, number, reason, user))
    assert result.status_code == 200, result.text
    return result.json()


def assert_exhausted(app, payload):
    result = request(app, "POST", "/policy/select", AUTH, json=payload)
    assert result.status_code == 409, result.text
    assert result.json()["code"] == "NO_ELIGIBLE_CANDIDATES"


def fitted_selection(app, index=0, number=1000):
    fitted = fit_payload()
    result = request(app, "POST", "/fit", AUTH, json=fitted)
    assert result.status_code == 200, result.text
    row = fitted["examples"][index]
    payload = selection(number)
    payload["candidates"] = [{"trackId": row["trackId"], "features": row["features"]}]
    return choose(app, payload), payload, fitted


def observe(app, payload):
    result = request(app, "POST", "/observe", AUTH, json=payload)
    assert result.status_code == 200, result.text
    return result.json()


def test_cold_selection_expires_at_exact_server_clock_boundary(tmp_path):
    clock = Clock()
    app = make_app(tmp_path, clock)
    selected = choose(app, single())
    original = inspect(app, selected)
    reservation = original["reservation"]
    assert reservation["status"] == "active"
    assert reservation["closureReason"] is None
    assert reservation["closedAt"] is None
    assert stamp(reservation["reservedAt"]) == clock.now
    assert stamp(reservation["evaluatedAt"]) == clock.now
    assert stamp(reservation["expiresAt"]) == clock.now + timedelta(seconds=300)
    clock.advance(299.999)
    assert_exhausted(app, single(1001))
    clock.advance(.001)
    expired = inspect(app, selected)["reservation"]
    assert expired["status"] == "expired"
    assert expired["closureReason"] == "expiry"
    assert expired["closedAt"] == expired["expiresAt"]
    assert choose(app, single(1001))["trackId"] == selected["trackId"]
    assert inspect(app, selected)["decision"] == original["decision"]


def test_historical_select_retry_never_reacquires_or_renews_after_restart(tmp_path):
    clock = Clock()
    app = make_app(tmp_path, clock, 30)
    selected = choose(app, single())
    frozen = inspect(app, selected)["reservation"]
    clock.advance(31)
    restored = make_app(tmp_path, clock, 900)
    assert choose(restored, single()) == selected
    old = inspect(restored, selected)["reservation"]
    assert old["expiresAt"] == frozen["expiresAt"]
    assert old["status"] == "expired"
    newer = choose(restored, single(1001))
    assert stamp(inspect(restored, newer)["reservation"]["expiresAt"]) == clock.now + timedelta(seconds=900)
    assert choose(restored, single()) == selected
    assert_exhausted(restored, single(1002))


@pytest.mark.parametrize("ending", ["expiry", "release"])
def test_durable_terminal_closure_survives_clock_rollback(tmp_path, ending):
    clock = Clock()
    app = make_app(tmp_path, clock)
    selected = choose(app, single())
    if ending == "expiry":
        clock.advance(300)
    else:
        clock.advance(10)
        release(app, selected)
    closed = inspect(app, selected)["reservation"]
    clock.advance(-600)
    restored = make_app(tmp_path, clock)
    after = inspect(restored, selected)["reservation"]
    assert after["status"] == closed["status"]
    assert after["closedAt"] == closed["closedAt"]
    assert after["closureReason"] == closed["closureReason"]
    assert choose(restored, single(1001))["trackId"] == selected["trackId"]


@pytest.mark.parametrize("ttl", [29, 901, 0, -1, True, 30.5])
def test_invalid_ttl_rejected_at_startup_by_service_and_app(tmp_path, ttl):
    with pytest.raises(ValueError):
        PolicyService(ModelService(tmp_path), clock=Clock(), reservation_ttl_seconds=ttl)
    with pytest.raises(ValueError):
        make_app(tmp_path, Clock(), ttl)


@pytest.mark.parametrize("ttl", [30, 900])
def test_ttl_boundaries_and_environment_configuration(tmp_path, monkeypatch, ttl):
    clock = Clock()
    monkeypatch.setenv("ML_POLICY_RESERVATION_TTL_SECONDS", str(ttl))
    app = create_app(shared_secret="test-service-secret", storage_dir=tmp_path, policy_clock=clock)
    selected = choose(app, single())
    assert stamp(inspect(app, selected)["reservation"]["expiresAt"]) == clock.now + timedelta(seconds=ttl)


@pytest.mark.parametrize("value", ["29", "901", "not-a-duration", "30.5"])
def test_invalid_environment_ttl_fails_startup(tmp_path, monkeypatch, value):
    monkeypatch.setenv("ML_POLICY_RESERVATION_TTL_SECONDS", value)
    with pytest.raises(ValueError):
        create_app(shared_secret="test-service-secret", storage_dir=tmp_path, policy_clock=Clock())


@pytest.mark.parametrize("reason", ["skip", "abandoned", "prefetch_discarded"])
def test_release_receipt_is_immutable_and_does_not_change_predictions_or_reward(tmp_path, reason):
    clock = Clock()
    app = make_app(tmp_path, clock)
    selected = choose(app, single())
    before = inspect(app, selected)
    original_model = diagnostics(app)["modelVersion"]
    clock.advance(7)
    receipt = release(app, selected, reason=reason)
    assert receipt == {"userId": "demo:alice", "requestId": uid(5000),
                       "exposureId": selected["exposureId"], "trackId": selected["trackId"],
                       "outcome": "released", "recordedAt": receipt["recordedAt"],
                       "expiresAt": before["reservation"]["expiresAt"],
                       "effectiveClosedAt": receipt["recordedAt"]}
    assert stamp(receipt["recordedAt"]) == clock.now
    clock.advance(400)
    restored = make_app(tmp_path, clock)
    assert release(restored, selected, reason=reason) == receipt
    after = inspect(restored, selected)
    assert after["decision"] == before["decision"]
    assert after["reservation"]["status"] == "released"
    assert after["reservation"]["closureReason"] == "explicit_release"
    assert after["reservation"]["closedAt"] == receipt["effectiveClosedAt"]
    assert diagnostics(restored)["counts"]["activeRewards"] == 0
    assert diagnostics(restored)["modelVersion"] == original_model
    assert choose(restored, single()) == selected
    explained = request(restored, "GET", "/explain", AUTH,
                        params={"userId": "demo:alice", "exposureId": selected["exposureId"]})
    assert explained.status_code == 200
    assert explained.json()["prediction"] == selected["prediction"]
    assert choose(restored, single(1001))["trackId"] == selected["trackId"]


def test_release_fresh_request_on_closed_lease_reports_original_closure(tmp_path):
    clock = Clock()
    app = make_app(tmp_path, clock)
    selected = choose(app, single())
    clock.advance(300)
    expired = release(app, selected)
    assert expired["outcome"] == "already_closed"
    assert expired["effectiveClosedAt"] == expired["expiresAt"]
    clock.advance(20)
    again = release(app, selected, 5001)
    assert again["outcome"] == "already_closed"
    assert again["effectiveClosedAt"] == expired["effectiveClosedAt"]
    assert stamp(again["recordedAt"]) == clock.now
    assert release(app, selected) == expired


def test_release_idempotency_conflicts_on_exposure_or_reason_change(tmp_path):
    clock = Clock()
    app = make_app(tmp_path, clock)
    first = choose(app, single())
    release(app, first)
    second = choose(app, single(1001))
    for changed in [release_payload(first, reason="skip"), release_payload(second)]:
        response = request(app, "POST", "/policy/release", AUTH, json=changed)
        assert response.status_code == 409
    assert inspect(app, second)["reservation"]["status"] == "active"


def test_release_is_scoped_to_user_and_exposure_not_track_or_request_globally(tmp_path):
    clock = Clock()
    app = make_app(tmp_path, clock)
    first = choose(app, single())
    for target in [first["exposureId"], uid(1999)]:
        result = request(app, "POST", "/policy/release", AUTH,
                         json={**release_payload(first, user="demo:bob"), "exposureId": target})
        assert result.status_code == 404
    assert inspect(app, first)["reservation"]["status"] == "active"
    bob_payload = single(user="demo:bob")
    bob = choose(app, bob_payload)
    assert release(app, bob, user="demo:bob")["userId"] == "demo:bob"
    assert release(app, first)["userId"] == "demo:alice"


def test_release_fails_closed_when_service_auth_is_unconfigured(tmp_path, monkeypatch):
    monkeypatch.delenv("ML_SERVICE_SHARED_SECRET", raising=False)
    app = create_app(storage_dir=tmp_path, policy_clock=Clock())
    result = request(app, "POST", "/policy/release", AUTH,
                     json=release_payload({"exposureId": uid(1000)}))
    assert result.status_code == 503
    assert result.json()["code"] == "ML_NOT_CONFIGURED"


@pytest.mark.parametrize("change", [{"reason": "undo"}, {"reason": None}, {"requestId": "bad"},
                                    {"exposureId": "bad"}, {"userId": ""}, {"ttlSeconds": 1}])
def test_release_authentication_precedes_strict_body_validation(tmp_path, change):
    app = make_app(tmp_path, Clock())
    payload = release_payload({"exposureId": uid(1000)}) | change
    assert request(app, "POST", "/policy/release", json=payload).status_code == 401
    result = request(app, "POST", "/policy/release", AUTH, json=payload)
    assert result.status_code == 422
    assert result.json()["code"] == "BAD_REQUEST"


def test_old_release_cannot_close_other_live_lease_for_same_track(tmp_path):
    clock = Clock()
    app = make_app(tmp_path, clock)
    first = choose(app, single(strategy="c1"))
    clock.advance(1)
    second = choose(app, single(1001, strategy="c1"))
    assert first["trackId"] == second["trackId"]
    release(app, first)
    assert inspect(app, second)["reservation"]["status"] == "active"
    assert_exhausted(app, single(1002))
    assert release(app, first, 5001)["outcome"] == "already_closed"
    assert inspect(app, second)["reservation"]["status"] == "active"
    release(app, second, 5002)
    assert choose(app, single(1002))["trackId"] == first["trackId"]


def test_skip_never_rewards_and_lost_release_still_expires(tmp_path):
    clock = Clock()
    app = make_app(tmp_path, clock)
    selected = choose(app, single())
    observe(app, event(selected, label=None))
    assert diagnostics(app)["counts"]["activeRewards"] == 0
    assert diagnostics(app)["counts"]["skips"] == 1
    assert_exhausted(app, single(1001))
    clock.advance(300)
    assert choose(app, single(1001))["trackId"] == selected["trackId"]
    assert diagnostics(app)["counts"]["activeRewards"] == 0


def test_client_feedback_timestamp_cannot_renew_server_lease(tmp_path):
    clock = Clock()
    app = make_app(tmp_path, clock)
    selected = choose(app, single())
    frozen = inspect(app, selected)["reservation"]
    observe(app, {**event(selected, label=None), "occurredAt": "2036-11-07T12:00:00Z"})
    after = inspect(app, selected)["reservation"]
    assert after["reservedAt"] == frozen["reservedAt"]
    assert after["expiresAt"] == frozen["expiresAt"]
    clock.advance(300)
    assert choose(app, single(1001))["trackId"] == selected["trackId"]


@pytest.mark.parametrize("ending", ["expiry", "release"])
@pytest.mark.parametrize("label", [0, 1])
def test_completed_review_remains_suppressed_after_lease_closure(tmp_path, ending, label):
    clock = Clock()
    app = make_app(tmp_path, clock)
    selected, payload, _ = fitted_selection(app)
    observe(app, event(selected, revision=2, label=label))
    before = diagnostics(app)
    assert before["counts"]["activeRewards"] == 1
    if ending == "release":
        release(app, selected)
    clock.advance(300)
    payload["exposureId"] = uid(1001)
    assert_exhausted(app, payload)
    assert diagnostics(app)["rewardSummary"] == before["rewardSummary"]


def test_holdout_completed_review_stays_suppressed_without_learning(tmp_path):
    clock = Clock()
    app = make_app(tmp_path, clock)
    selected, payload, _ = fitted_selection(app, -1)
    observe(app, event(selected, revision=2))
    release(app, selected)
    clock.advance(300)
    payload["exposureId"] = uid(1001)
    assert_exhausted(app, payload)
    stats = diagnostics(app)
    assert stats["counts"]["activeRewards"] == 0
    assert stats["counts"]["holdoutExcluded"] == 1


@pytest.mark.parametrize("ending", ["expiry", "release"])
def test_delayed_feedback_after_closure_keeps_c1_rules_and_then_suppresses(tmp_path, ending):
    clock = Clock()
    app = make_app(tmp_path, clock)
    selected, payload, _ = fitted_selection(app)
    if ending == "release":
        release(app, selected)
    else:
        clock.advance(300)
        inspect(app, selected)
    closure = inspect(app, selected)["reservation"]
    payload["exposureId"] = uid(1001)
    newer = choose(app, payload)
    observed = event(selected, revision=2)
    original = observe(app, observed)
    assert observe(app, observed) == original
    assert diagnostics(app)["counts"]["activeRewards"] == 1
    release(app, newer, 5001)
    payload["exposureId"] = uid(1002)
    assert_exhausted(app, payload)
    assert inspect(app, selected)["reservation"]["closedAt"] == closure["closedAt"]
    assert inspect(app, selected)["reservation"]["closureReason"] == closure["closureReason"]


def test_valid_undo_closes_only_its_live_lease_and_preserves_frozen_response(tmp_path):
    clock = Clock()
    app = make_app(tmp_path, clock)
    selected = choose(app, single())
    observed = event(selected)
    observe(app, observed)
    clock.advance(10)
    observe(app, {**observed, "eventId": uid(2001), "feedbackRevision": 2,
                  "operation": "revoke", "label": None})
    reservation = inspect(app, selected)["reservation"]
    assert reservation["status"] == "released"
    assert reservation["closureReason"] == "undo"
    assert stamp(reservation["closedAt"]) == clock.now
    assert choose(app, single()) == selected
    assert diagnostics(app)["counts"]["activeRewards"] == 0
    assert choose(app, single(1001))["trackId"] == selected["trackId"]


@pytest.mark.parametrize("ending", ["expiry", "release"])
def test_undo_never_reopens_or_changes_an_existing_terminal_closure(tmp_path, ending):
    clock = Clock()
    app = make_app(tmp_path, clock)
    selected = choose(app, single())
    observed = event(selected)
    observe(app, observed)
    if ending == "release":
        release(app, selected)
    else:
        clock.advance(300)
    closed = inspect(app, selected)["reservation"]
    clock.advance(1)
    observe(app, {**observed, "eventId": uid(2001), "feedbackRevision": 2,
                  "operation": "revoke", "label": None})
    after = inspect(app, selected)["reservation"]
    assert after["status"] == closed["status"]
    assert after["closedAt"] == closed["closedAt"]
    assert after["closureReason"] == closed["closureReason"]
    assert choose(app, single(1001))["trackId"] == selected["trackId"]


def test_stale_undo_and_old_release_preserve_newer_completed_review_and_lease(tmp_path):
    clock = Clock()
    app = make_app(tmp_path, clock)
    old = choose(app, single())
    old_event = event(old)
    observe(app, old_event)
    release(app, old)
    newer = choose(app, single(1001, strategy="c1"))
    observe(app, {**event(newer, 2001, 2), "decisionId": uid(3001)})
    observe(app, {**old_event, "eventId": uid(2002), "feedbackRevision": 3,
                  "operation": "revoke", "label": None})
    release(app, old, 5001)
    assert inspect(app, newer)["reservation"]["status"] == "active"
    clock.advance(300)
    assert_exhausted(app, single(1002))


def test_full_fit_removal_allows_reselection_only_after_live_lease_ends(tmp_path):
    clock = Clock()
    app = make_app(tmp_path, clock)
    selected, payload, fitted = fitted_selection(app)
    observe(app, event(selected, revision=2))
    fitted["feedbackRevision"] = 3
    fitted["examples"] = [row for row in fitted["examples"] if row["trackId"] != selected["trackId"]]
    assert request(app, "POST", "/fit", AUTH, json=fitted).status_code == 200
    payload["exposureId"] = uid(1001)
    assert_exhausted(app, payload)
    clock.advance(300)
    assert choose(app, payload)["trackId"] == selected["trackId"]
    assert diagnostics(app)["counts"]["activeRewards"] == 0


def test_disabled_c1_preserves_full_rank_and_still_creates_lease(tmp_path):
    clock = Clock()
    app = make_app(tmp_path, clock)
    first = choose(app, selection(strategy="c1"))
    second = choose(app, selection(1001, strategy="c1"))
    assert first["rankedTrackIds"] == second["rankedTrackIds"]
    assert first["trackId"] == second["trackId"]
    assert inspect(app, second)["reservation"]["status"] == "active"
    candidate = {**single(1002), "candidates": [second["candidate"]]}
    assert_exhausted(app, candidate)


def test_eligibility_snapshot_explains_live_leases_and_completed_reviews(tmp_path):
    clock = Clock()
    app = make_app(tmp_path, clock)
    first, _, fitted = fitted_selection(app)
    observe(app, event(first, revision=2))
    second = choose(app, selection(1001))
    candidates = [first["candidate"], second["candidate"],
                  {"trackId": fitted["examples"][1]["trackId"], "features": fitted["examples"][1]["features"]}]
    payload = {**selection(1002), "candidates": candidates}
    third = choose(app, payload)
    frozen = inspect(app, third)["eligibility"]
    assert frozen["filteringApplied"] is True
    assert stamp(frozen["evaluatedAt"]) == clock.now
    excluded = {row["trackId"]: row for row in frozen["exclusions"]}
    assert excluded[first["trackId"]] == {"trackId": first["trackId"],
                                          "blockingExposureIds": [first["exposureId"]],
                                          "completedReview": True}
    assert excluded[second["trackId"]] == {"trackId": second["trackId"],
                                           "blockingExposureIds": [second["exposureId"]],
                                           "completedReview": False}
    clock.advance(300)
    release(app, first)
    assert inspect(app, third)["eligibility"] == frozen
    # Expiry removes live-lease exclusions; the completed review still blocks.
    later = choose(app, {**payload, "exposureId": uid(1003)})
    latest_exclusions = inspect(app, later)["eligibility"]["exclusions"]
    assert latest_exclusions == [{"trackId": first["trackId"], "blockingExposureIds": [],
                                  "completedReview": True}]


def test_fixed_clock_history_replay_is_deterministic_without_erasing_selection_history(tmp_path):
    decisions = []
    inspections = []
    for folder in (tmp_path / "first", tmp_path / "second"):
        clock = Clock()
        app = make_app(folder, clock)
        first = choose(app, single())
        clock.advance(10)
        release(app, first)
        second = choose(app, single(1001))
        assert second["step"] == 1
        assert diagnostics(app)["counts"]["exposures"] == 2
        assert first["policyStateVersion"] != second["policyStateVersion"]
        decisions.append(second)
        inspections.append(inspect(app, first))
    assert decisions[0] == decisions[1]
    assert inspections[0] == inspections[1]
