"""C2 behavior across the actual authenticated C1 persistence boundary."""
from copy import deepcopy
from pathlib import Path
from uuid import UUID

import pytest

from sortfm_ml.app import create_app
from test_app import AUTH, VERSION, feature_vector, fit_payload, request


def uid(number):
    return str(UUID(int=number, version=4))


def selection(number=1000, user="demo:alice", **options):
    return {"userId": user, "featureVersion": VERSION, "exposureId": uid(number),
            "modelVersion": None, "seed": 42, "config": options,
            "candidates": [{"trackId": f"demo:new-{i}", "features": feature_vector(i / 9),
                            "artistIds": [f"demo:artist-{i % 3}"]} for i in range(10)]}


def choose(app, payload=None):
    response = request(app, "POST", "/policy/select", AUTH, json=payload or selection())
    assert response.status_code == 200, response.text
    return response.json()


def event(selected, number=2000, revision=1, label=1, operation="upsert"):
    return {"userId": "demo:alice", "eventId": uid(number), "decisionId": uid(3000),
            "exposureId": selected["exposureId"], "trackId": selected["trackId"],
            "feedbackRevision": revision, "operation": operation, "label": label,
            "features": selected["candidate"]["features"], "occurredAt": "2026-11-07T12:00:00Z"}


def diagnostics(app):
    response = request(app, "GET", "/policy/diagnostics", AUTH, params={"userId": "demo:alice"})
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.parametrize("method,path", [("POST", "/policy/select"), ("POST", "/policy/feedback"),
                                         ("GET", "/policy/diagnostics"), ("GET", "/policy/exposure")])
def test_policy_routes_authenticate_before_validation(tmp_path, method, path):
    app = create_app(shared_secret="test-service-secret", storage_dir=tmp_path)
    assert request(app, method, path).status_code == 401
    assert request(app, method, path, AUTH).status_code == 422


def test_policy_select_is_reproducible_logged_and_explainable(tmp_path):
    app = create_app(shared_secret="test-service-secret", storage_dir=tmp_path / "first")
    original = choose(app)
    assert original["prediction"]["removalProbability"] is None
    assert original["policyVersion"].startswith("c2-")
    assert original["candidateCount"] == 10
    assert len(original["candidateSetHash"]) == 64
    assert original["selection"]["propensityEstimate"] is None
    assert original["selection"]["uncertainty"] >= 0
    assert len(original["contextNames"]) == len(original["selection"]["context"])
    assert choose(app) == original
    restored = create_app(shared_secret="test-service-secret", storage_dir=tmp_path / "first")
    assert choose(restored) == original
    explanation = request(restored, "GET", "/explain", AUTH,
                          params={"userId": "demo:alice", "exposureId": original["exposureId"]})
    assert explanation.json()["prediction"] == original["prediction"]
    other = create_app(shared_secret="test-service-secret", storage_dir=tmp_path / "second")
    replay = choose(other)
    assert replay["selection"] == original["selection"]
    assert diagnostics(restored)["counts"]["exposures"] == 1
    logged = request(restored, "GET", "/policy/exposure", AUTH,
                     params={"userId": "demo:alice", "exposureId": original["exposureId"]})
    assert logged.json()["decision"] == original


def test_policy_id_conflict_and_owner_isolation(tmp_path):
    app = create_app(shared_secret="test-service-secret", storage_dir=tmp_path)
    original = choose(app)
    conflicting = selection()
    conflicting["seed"] += 1
    assert request(app, "POST", "/policy/select", AUTH, json=conflicting).status_code == 409
    assert request(app, "GET", "/policy/exposure", AUTH,
                   params={"userId": "demo:bob", "exposureId": original["exposureId"]}).status_code == 404
    assert choose(app, selection(user="demo:bob"))["userId"] == "demo:bob"


def test_policy_off_returns_exact_c1_rank_and_does_not_filter_history(tmp_path):
    app = create_app(shared_secret="test-service-secret", storage_dir=tmp_path)
    payload = selection(strategy="c1")
    selected = choose(app, payload)
    service = app.state.model_service
    with service._locked("demo:alice") as folder:
        bundle = service._load(folder, "demo:alice")
        expected = bundle["model"].rank(payload["candidates"], bundle["version"], limit=10)
    assert selected["rankedTrackIds"] == [item["trackId"] for item in expected]
    assert selected["trackId"] == expected[0]["trackId"]
    again = choose(app, selection(1001, strategy="c1"))
    assert again["rankedTrackIds"] == selected["rankedTrackIds"]


def test_feedback_updates_policy_once_and_undo_removes_reward(tmp_path):
    app = create_app(shared_secret="test-service-secret", storage_dir=tmp_path)
    # Explicit train identity makes the active policy example unambiguous.
    payload = selection()
    payload["candidates"] = [fit_payload()["examples"][0] | {"artistIds": []}]
    payload["candidates"] = [{k: v for k, v in payload["candidates"][0].items()
                              if k in ("trackId", "features", "artistIds")}]
    assert request(app, "POST", "/fit", AUTH, json=fit_payload()).status_code == 200
    selected = choose(app, payload)
    observed = event(selected, revision=2)
    response = request(app, "POST", "/policy/feedback", AUTH, json={**observed, "usefulness": .4})
    assert response.status_code == 200, response.text
    assert request(app, "POST", "/policy/feedback", AUTH, json={**observed, "usefulness": .4}).json() == response.json()
    summary = diagnostics(app)
    assert summary["counts"]["activeRewards"] == 1
    expected_reward = .75 * .4 + .25 * (1 - selected["prediction"]["removalProbability"]) ** 2
    assert summary["rewardSummary"]["sum"] == pytest.approx(expected_reward)
    assert summary["labelDistribution"] == {"keep": 0, "remove": 1}
    revoked = {**observed, "eventId": uid(2001), "feedbackRevision": 3, "operation": "revoke", "label": None}
    assert request(app, "POST", "/observe", AUTH, json=revoked).status_code == 200
    assert diagnostics(app)["counts"]["activeRewards"] == 0
    assert choose(app, payload) == selected


def test_holdout_and_skip_never_train_bandit(tmp_path):
    app = create_app(shared_secret="test-service-secret", storage_dir=tmp_path)
    fit = fit_payload()
    assert request(app, "POST", "/fit", AUTH, json=fit).status_code == 200
    candidate = fit["examples"][-1]
    payload = selection()
    payload["candidates"] = [{"trackId": candidate["trackId"], "features": candidate["features"]}]
    selected = choose(app, payload)
    assert request(app, "POST", "/observe", AUTH, json=event(selected, revision=2)).status_code == 200
    stats = diagnostics(app)
    assert stats["counts"]["activeRewards"] == 0
    assert stats["counts"]["holdoutExcluded"] == 1
    skipped = choose(app, selection(1002))
    assert request(app, "POST", "/observe", AUTH, json=event(skipped, 2002, 3, None) | {"decisionId": uid(3002)}).status_code == 200
    assert diagnostics(app)["counts"]["skips"] == 1
    assert diagnostics(app)["counts"]["activeRewards"] == 0


@pytest.mark.parametrize("change", ["track", "features"])
def test_policy_feedback_must_match_frozen_exposure(tmp_path, change):
    app = create_app(shared_secret="test-service-secret", storage_dir=tmp_path)
    observed = event(choose(app))
    if change == "track":
        observed["trackId"] = "demo:wrong"
    else:
        observed["features"] = feature_vector(.123)
    assert request(app, "POST", "/observe", AUTH, json=observed).status_code == 409
    assert diagnostics(app)["counts"]["activeRewards"] == 0


def test_no_repeat_and_empty_candidates_fail_explicitly(tmp_path):
    app = create_app(shared_secret="test-service-secret", storage_dir=tmp_path)
    payload = selection()
    payload["candidates"] = payload["candidates"][:1]
    choose(app, payload)
    payload["exposureId"] = uid(1001)
    result = request(app, "POST", "/policy/select", AUTH, json=payload)
    assert result.status_code == 409
    assert result.json()["code"] == "NO_ELIGIBLE_CANDIDATES"


@pytest.mark.parametrize("patch", [{"alpha": -1}, {"alpha": 11}, {"ridge": 0}, {"epsilon": 1.01},
                                    {"maxExplorationFraction": -1}, {"unknown": 1}])
def test_configuration_is_strict(tmp_path, patch):
    app = create_app(shared_secret="test-service-secret", storage_dir=tmp_path)
    assert request(app, "POST", "/policy/select", AUTH, json=selection(**patch)).status_code == 422


def test_review_reward_values_both_keep_and_remove_without_inventing_probabilities():
    from sortfm_ml.policy_service import review_reward
    assert review_reward(0, {"removalProbability": .8})["reward"] == pytest.approx(.91)
    assert review_reward(1, {"removalProbability": .8})["reward"] == pytest.approx(.76)
    assert review_reward(0, {"removalProbability": None})["reward"] == .75
    assert review_reward(1, {"removalProbability": .8}, 0)["reward"] == pytest.approx(.01)
    assert review_reward(1, {"removalProbability": .8})["usefulnessSource"] == "completed_review_proxy"


def test_reordering_candidate_set_is_an_identical_retry(tmp_path):
    app = create_app(shared_secret="test-service-secret", storage_dir=tmp_path)
    original = choose(app)
    payload = selection()
    payload["candidates"].reverse()
    assert choose(app, payload) == original


def test_retry_completes_interrupted_prediction_snapshot_without_resampling(tmp_path, monkeypatch):
    import sortfm_ml.policy_service as policy_module
    app = create_app(shared_secret="test-service-secret", storage_dir=tmp_path)
    original_write = policy_module.atomic_bytes

    def fail_snapshot(path, data):
        if path.name == "exposures.json":
            raise OSError("injected disk failure")
        return original_write(path, data)

    monkeypatch.setattr(policy_module, "atomic_bytes", fail_snapshot)
    result = request(app, "POST", "/policy/select", AUTH, json=selection())
    assert result.status_code == 503
    pending = diagnostics(app)["latestDecision"]
    assert pending is not None
    monkeypatch.setattr(policy_module, "atomic_bytes", original_write)
    assert choose(app) == pending
    assert diagnostics(app)["counts"]["exposures"] == 1
    assert request(app, "GET", "/explain", AUTH, params={"userId": "demo:alice", "exposureId": uid(1000)}).status_code == 200


def test_failed_c1_feedback_remains_inert_until_successful_retry(tmp_path, monkeypatch):
    from sortfm_ml.service import ServiceError
    app = create_app(shared_secret="test-service-secret", storage_dir=tmp_path)
    selected = choose(app)
    observed = event(selected)
    models = app.state.model_service
    original = models.observe

    def fail(_):
        raise ServiceError(503, "STORAGE_UNAVAILABLE", "Injected publication failure", True)

    monkeypatch.setattr(models, "observe", fail)
    assert request(app, "POST", "/observe", AUTH, json=observed).status_code == 503
    assert diagnostics(app)["counts"]["pendingEvents"] == 1
    assert diagnostics(app)["counts"]["activeRewards"] == 0
    monkeypatch.setattr(models, "observe", original)
    assert request(app, "POST", "/observe", AUTH, json=observed).status_code == 200
    assert diagnostics(app)["counts"]["pendingEvents"] == 0
    assert diagnostics(app)["counts"]["committedEvents"] == 1


@pytest.mark.parametrize("damage", ["missing", "corrupt", "wrong_checksum"])
def test_policy_storage_never_silently_resets(tmp_path, damage):
    import json
    app = create_app(shared_secret="test-service-secret", storage_dir=tmp_path)
    choose(app)
    path = next(tmp_path.glob("*/policy.json"))
    if damage == "missing":
        path.unlink()
    elif damage == "corrupt":
        path.write_text("{")
    else:
        envelope = json.loads(path.read_text())
        envelope["state"]["decisions"] = {}
        path.write_text(json.dumps(envelope))
    result = request(app, "POST", "/policy/select", AUTH, json=selection(1001))
    assert result.status_code == 503
    assert result.json()["code"] == "POLICY_STATE_UNAVAILABLE"


def test_fit_snapshot_removal_and_rebase_preserve_frozen_decisions(tmp_path):
    from sortfm_ml.bandit import build_context, LinearUCB
    import numpy as np
    app = create_app(shared_secret="test-service-secret", storage_dir=tmp_path)
    fitted = fit_payload()
    assert request(app, "POST", "/fit", AUTH, json=fitted).status_code == 200
    row = fitted["examples"][0]
    payload = selection()
    payload["candidates"] = [{"trackId": row["trackId"], "features": row["features"]}]
    selected = choose(app, payload)
    observed = event(selected, revision=2)
    assert request(app, "POST", "/observe", AUTH, json=observed).status_code == 200
    after = choose(app, selection(1001, alpha=.7))
    assert after["trainedRewards"] == 1
    assert after["modelVersion"] != selected["modelVersion"]
    with app.state.model_service._locked("demo:alice") as folder:
        bundle = app.state.model_service._load(folder, "demo:alice")
        training = [selected["candidate"]]
        x = build_context(bundle["model"], training, bundle["model"].predict(training, bundle["version"]))
    reward = .75 + .25 * (1 - selected["prediction"]["removalProbability"]) ** 2
    expected = LinearUCB(x.shape[1], alpha=.7).fit(x, np.array([reward])).scores(np.array([after["selection"]["context"]]))
    assert after["selection"]["predictedReward"] == pytest.approx(expected["mean"][0])
    assert after["selection"]["uncertainty"] == pytest.approx(expected["uncertainty"][0])
    fitted["feedbackRevision"] = 3
    fitted["examples"] = [row for row in fitted["examples"] if row["trackId"] != selected["trackId"]]
    assert request(app, "POST", "/fit", AUTH, json=fitted).status_code == 200
    assert diagnostics(app)["counts"]["activeRewards"] == 0
    assert choose(app, payload) == selected


def test_competing_selects_reserve_unique_tracks(tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    from sortfm_ml.policy_service import PolicyService
    from sortfm_ml.service import ModelService
    def run(i):
        return PolicyService(ModelService(tmp_path)).select(selection(1000 + i))
    with ThreadPoolExecutor(max_workers=4) as executor:
        selected = list(executor.map(run, range(8)))
    assert len({row["trackId"] for row in selected}) == 8
    assert sorted(row["step"] for row in selected) == list(range(8))


def test_missing_audio_and_no_training_permission_still_allow_safe_selection(tmp_path):
    app = create_app(shared_secret="test-service-secret", storage_dir=tmp_path)
    payload = selection()
    payload["candidates"] = [{"trackId": "demo:no-audio", "features": {"featureVersion": VERSION,
                                "values": {}, "permittedForTraining": False, "provenance": "synthetic"}}]
    selected = choose(app, payload)
    assert selected["prediction"]["removalProbability"] is None
    assert request(app, "POST", "/observe", AUTH, json=event(selected)).status_code == 422
    assert diagnostics(app)["counts"]["activeRewards"] == 0


def test_policy_feedback_rejects_unknown_exposure_and_rating_on_skip(tmp_path):
    app = create_app(shared_secret="test-service-secret", storage_dir=tmp_path)
    observed = event(choose(app))
    result = request(app, "POST", "/policy/feedback", AUTH, json={**observed, "label": None, "usefulness": .5})
    assert result.status_code == 422
    observed["exposureId"] = uid(9999)
    result = request(app, "POST", "/policy/feedback", AUTH, json=observed)
    assert result.status_code == 404


def test_keyed_c1_score_can_retry_policy_selected_prediction(tmp_path):
    app = create_app(shared_secret="test-service-secret", storage_dir=tmp_path)
    selected = choose(app)
    payload = {"userId": "demo:alice", "featureVersion": VERSION, "modelVersion": None,
               "candidates": [{"trackId": selected["trackId"], "features": selected["candidate"]["features"],
                               "exposureId": selected["exposureId"]}]}
    response = request(app, "POST", "/score", AUTH, json=payload)
    assert response.status_code == 200, response.text
    assert response.json()["predictions"][0]["prediction"] == selected["prediction"]


def test_reinstated_decision_restores_no_repeat_reservation(tmp_path):
    app = create_app(shared_secret="test-service-secret", storage_dir=tmp_path)
    payload = selection()
    payload["candidates"] = payload["candidates"][:1]
    selected = choose(app, payload)
    first = event(selected)
    assert request(app, "POST", "/observe", AUTH, json=first).status_code == 200
    undo = {**first, "eventId": uid(2001), "feedbackRevision": 2, "operation": "revoke", "label": None}
    assert request(app, "POST", "/observe", AUTH, json=undo).status_code == 200
    redo = {**first, "eventId": uid(2002), "feedbackRevision": 3}
    assert request(app, "POST", "/observe", AUTH, json=redo).status_code == 200
    payload["exposureId"] = uid(1001)
    response = request(app, "POST", "/policy/select", AUTH, json=payload)
    assert response.status_code == 409
    assert response.json()["code"] == "NO_ELIGIBLE_CANDIDATES"


def test_unrelated_c1_observation_does_not_depend_on_policy_storage(tmp_path):
    app = create_app(shared_secret="test-service-secret", storage_dir=tmp_path)
    selected = choose(app)
    next(tmp_path.glob("*/policy.json")).write_text("{")
    observed = {**event(selected), "exposureId": uid(12345), "trackId": "demo:c1-direct"}
    assert request(app, "POST", "/observe", AUTH, json=observed).status_code == 200


def test_null_equivalent_fit_features_keep_policy_reward_active(tmp_path):
    app = create_app(shared_secret="test-service-secret", storage_dir=tmp_path)
    fitted = fit_payload()
    assert request(app, "POST", "/fit", AUTH, json=fitted).status_code == 200
    payload = selection()
    first = fitted["examples"][0]
    payload["candidates"] = [{"trackId": first["trackId"], "features": first["features"]}]
    observed = event(choose(app, payload), revision=2)
    assert request(app, "POST", "/observe", AUTH, json=observed).status_code == 200
    assert diagnostics(app)["counts"]["activeRewards"] == 1
    first.update(decisionId=observed["decisionId"], label=observed["label"])
    first["features"]["values"]["liveness"] = None
    fitted["feedbackRevision"] = 3
    assert request(app, "POST", "/fit", AUTH, json=fitted).status_code == 200
    assert diagnostics(app)["counts"]["activeRewards"] == 1


def test_rejected_feedback_can_be_corrected_without_poisoning_event_id(tmp_path):
    app = create_app(shared_secret="test-service-secret", storage_dir=tmp_path)
    selected = choose(app)
    assert request(app, "POST", "/fit", AUTH, json=fit_payload()).status_code == 200
    stale = event(selected, revision=0)
    response = request(app, "POST", "/observe", AUTH, json=stale)
    assert response.status_code == 409
    assert response.json()["code"] == "STALE_REVISION"
    assert diagnostics(app)["counts"]["pendingEvents"] == 0
    assert request(app, "POST", "/observe", AUTH, json={**stale, "feedbackRevision": 2}).status_code == 200


def test_noop_old_decision_revoke_does_not_release_active_track(tmp_path):
    app = create_app(shared_secret="test-service-secret", storage_dir=tmp_path)
    payload = selection()
    payload["candidates"] = payload["candidates"][:1]
    selected = choose(app, payload)
    first = event(selected)
    assert request(app, "POST", "/observe", AUTH, json=first).status_code == 200
    newer = {**first, "decisionId": uid(3001), "eventId": uid(2001), "feedbackRevision": 2}
    assert request(app, "POST", "/observe", AUTH, json=newer).status_code == 200
    noop = {**first, "operation": "revoke", "label": None, "eventId": uid(2002), "feedbackRevision": 3}
    assert request(app, "POST", "/observe", AUTH, json=noop).status_code == 200
    payload["exposureId"] = uid(1001)
    response = request(app, "POST", "/policy/select", AUTH, json=payload)
    assert response.status_code == 409
    assert response.json()["code"] == "NO_ELIGIBLE_CANDIDATES"
