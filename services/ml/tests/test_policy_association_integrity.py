"""Association isolation from legacy observation and unpublished fit artifacts."""
from copy import deepcopy

import pytest

from sortfm_ml.app import create_app
from test_app import AUTH, VERSION, request
from test_policy_service import choose, diagnostics, event, selection, uid


def association(selected, revision=1, sequence=1, number=6000, operation="upsert", label=1):
    return {"userId": selected["userId"], "event": {
        **{key: value for key, value in event(selected, number=number, revision=revision,
                                             label=label, operation=operation).items() if key != "userId"},
        "sequence": sequence, "source": "cleanup", "policyVersion": selected["policyVersion"],
        "modelVersion": selected["modelVersion"]}}


def fit(app, selected, revision, present=True):
    payload = {"userId": selected["userId"], "featureVersion": VERSION,
               "feedbackRevision": revision, "evaluationSeed": 42, "examples": []}
    if present:
        payload["examples"] = [{"trackId": selected["trackId"], "decisionId": uid(3000),
            "label": 1, "split": "train", "features": selected["candidate"]["features"],
            "labeledAt": "2026-11-07T12:00:00Z"}]
    result = request(app, "POST", "/fit", AUTH, json=payload)
    assert result.status_code == 200, result.text
    return {"modelVersion": result.json()["modelVersion"], "synchronizedFeedbackRevision": revision}


def test_association_retry_advances_receipt_without_recounting(tmp_path):
    app = create_app(shared_secret="test-service-secret", storage_dir=tmp_path)
    selected = choose(app)
    payload = {**association(selected), "fitReceipt": fit(app, selected, 1)}
    first = request(app, "POST", "/policy/associate", AUTH, json=payload)
    assert first.status_code == 200, first.text
    assert first.json()["eligibleForLearning"]
    payload["fitReceipt"] = fit(app, selected, 2, present=False)
    replay = request(app, "POST", "/policy/associate", AUTH, json=payload)
    assert replay.status_code == 200, replay.text
    assert replay.json()["duplicate"]
    assert replay.json()["recordedAt"] == first.json()["recordedAt"]
    assert not replay.json()["eligibleForLearning"]
    assert diagnostics(app)["counts"]["activeRewards"] == 0


def test_association_undo_tombstone_blocks_legacy_reward_and_late_upsert(tmp_path):
    app = create_app(shared_secret="test-service-secret", storage_dir=tmp_path)
    selected = choose(app)
    assert request(app, "POST", "/observe", AUTH, json=event(selected)).status_code == 200
    receipt = fit(app, selected, 2)
    undo = {**association(selected, revision=2, sequence=2, operation="revoke", label=None),
            "fitReceipt": receipt}
    assert request(app, "POST", "/policy/associate", AUTH, json=undo).status_code == 200
    late = {**association(selected, sequence=1, number=6001), "fitReceipt": receipt}
    result = request(app, "POST", "/policy/associate", AUTH, json=late)
    assert result.status_code == 200, result.text
    assert not result.json()["eligibleForLearning"]
    assert diagnostics(app)["counts"]["activeRewards"] == 0


@pytest.mark.parametrize("strategy", ["epsilon_greedy", "linucb"])
def test_authenticated_cold_c1_selection_seeds_requested_policy(tmp_path, strategy):
    app = create_app(shared_secret="test-service-secret", storage_dir=tmp_path)
    fitted = request(app, "POST", "/fit", AUTH, json={"userId": "demo:alice",
        "featureVersion": VERSION, "evaluationSeed": 42, "feedbackRevision": 0, "examples": []}).json()
    first = choose(app, {**selection(strategy=strategy), "modelVersion": fitted["modelVersion"],
                         "feedbackRevision": 0})
    assert first["trainedRewards"] == 0
    assert first["config"]["strategy"] == strategy
    assert first["selection"]["selectionMethod"] == "c1"
    assert "no_reward_observations" in first["selection"]["reasons"]
    receipt = fit(app, first, 1)
    result = request(app, "POST", "/policy/associate", AUTH,
                     json={**association(first), "fitReceipt": receipt})
    assert result.status_code == 200, result.text
    assert result.json()["eligibleForLearning"]
    second = choose(app, {**selection(1001, strategy=strategy),
                          "modelVersion": receipt["modelVersion"], "feedbackRevision": 1})
    assert second["trainedRewards"] == 1
    assert second["selection"]["selectionMethod"] == strategy


def test_unpublished_fit_artifact_is_not_an_acceptable_receipt(tmp_path, monkeypatch):
    import sortfm_ml.service as service_module
    app = create_app(shared_secret="test-service-secret", storage_dir=tmp_path)
    selected = choose(app)
    initial = fit(app, selected, 1)
    before = set(tmp_path.glob("*/*.joblib"))
    original = service_module.atomic_bytes

    def fail_publication(path, data):
        if path.name == "current.json":
            raise OSError("injected manifest publication failure")
        return original(path, data)

    monkeypatch.setattr(service_module, "atomic_bytes", fail_publication)
    failed = request(app, "POST", "/fit", AUTH, json={"userId": selected["userId"],
        "featureVersion": VERSION, "evaluationSeed": 42, "feedbackRevision": 2, "examples": []})
    assert failed.status_code == 503
    orphan = (set(tmp_path.glob("*/*.joblib")) - before).pop().stem
    monkeypatch.setattr(service_module, "atomic_bytes", original)
    result = request(app, "POST", "/policy/associate", AUTH, json={**association(selected, revision=2),
        "fitReceipt": {"modelVersion": orphan, "synchronizedFeedbackRevision": 2}})
    assert result.status_code == 409, result.text
    assert result.json()["code"] == "STALE_FIT_RECEIPT"
    assert request(app, "POST", "/policy/associate", AUTH,
        json={**association(selected), "fitReceipt": initial}).json()["eligibleForLearning"]


def test_unknown_owner_association_never_initializes_a_c1_model(tmp_path):
    app = create_app(shared_secret="test-service-secret", storage_dir=tmp_path)
    selected = choose(app)
    receipt = fit(app, selected, 1)
    before = set(tmp_path.glob("*/*.joblib"))
    result = request(app, "POST", "/policy/associate", AUTH,
        json={**association(selected), "userId": "demo:unknown", "fitReceipt": receipt})
    assert result.status_code == 404
    assert set(tmp_path.glob("*/*.joblib")) == before
