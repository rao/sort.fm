"""Synthetic acceptance-evidence caching and legacy reward isolation regressions."""
from copy import deepcopy
import gc
import json
import os
import shutil
import weakref

import pytest

from sortfm_ml.service import canonical, digest
from test_app import AUTH, request
from test_policy_association import associate, prepare, publish
from test_policy_reservations import make_app
from test_policy_service import diagnostics, event as observe_event, uid


def historical_association(path, user="demo:alice"):
    app, clock, selected, event, snapshot, receipt = prepare(path, user=user)
    associate(app, event, receipt, user)
    # Corrupting historical evidence must not corrupt the current C1 head.
    _, current = publish(app, snapshot, revision=3)
    assert current["modelVersion"] != receipt["modelVersion"]
    return app, clock, selected, event, receipt


def count_historical_loads(app, monkeypatch):
    calls, models = [], []
    original = app.state.model_service._load

    def counted(folder, user_id, version=None):
        if version is not None:
            calls.append((user_id, version))
        bundle = original(folder, user_id, version)
        if version is not None:
            models.append(weakref.ref(bundle["model"]))
        return bundle

    monkeypatch.setattr(app.state.model_service, "_load", counted)
    return calls, models


def summary(app, user="demo:alice"):
    return request(app, "GET", "/policy/diagnostics", AUTH, params={"userId": user})


def artifact(path, version, suffix):
    matches = list(path.glob(f"*/{version}{suffix}"))
    assert len(matches) == 1
    return matches[0]


def policy_state(path):
    file = next(path.glob("*/policy.json"))
    return file, json.loads(file.read_text())["state"]


def save_state(file, state):
    file.write_bytes(canonical({"state": state, "sha256": digest(state)}))


def test_warm_evidence_reuses_validation_without_retaining_loaded_models(tmp_path, monkeypatch):
    app, _, _, _, receipt = historical_association(tmp_path)
    calls, models = count_historical_loads(app, monkeypatch)
    assert summary(app).status_code == 200
    assert calls == [("demo:alice", receipt["modelVersion"])]
    calls.clear()

    assert summary(app).status_code == 200
    assert summary(app).status_code == 200
    assert calls == [], "Unchanged historical evidence should not deserialize C1 again"
    gc.collect()
    assert models and all(model() is None for model in models), "Cache must retain evidence, not model objects"


@pytest.mark.parametrize("suffix", [".joblib", ".json"])
def test_touching_either_immutable_file_revalidates_then_rewarms(tmp_path, monkeypatch, suffix):
    app, _, _, _, receipt = historical_association(tmp_path)
    calls, _ = count_historical_loads(app, monkeypatch)
    assert summary(app).status_code == 200
    calls.clear()
    file = artifact(tmp_path, receipt["modelVersion"], suffix)
    before = file.stat()
    os.utime(file, ns=(before.st_atime_ns, before.st_mtime_ns + 1_000_000_000))

    assert summary(app).status_code == 200
    assert calls == [("demo:alice", receipt["modelVersion"])]
    calls.clear()
    assert summary(app).status_code == 200
    assert calls == []


@pytest.mark.parametrize("suffix", [".joblib", ".json"])
def test_replaced_inode_with_identical_bytes_size_and_mtime_revalidates(tmp_path, monkeypatch, suffix):
    app, _, _, _, receipt = historical_association(tmp_path)
    calls, _ = count_historical_loads(app, monkeypatch)
    assert summary(app).status_code == 200
    calls.clear()
    file = artifact(tmp_path, receipt["modelVersion"], suffix)
    before = file.stat()
    replacement = file.with_name(file.name + ".replacement")
    replacement.write_bytes(file.read_bytes())
    os.utime(replacement, ns=(before.st_atime_ns, before.st_mtime_ns))
    os.replace(replacement, file)
    assert file.stat().st_ino != before.st_ino
    assert file.stat().st_size == before.st_size
    assert file.stat().st_mtime_ns == before.st_mtime_ns

    assert summary(app).status_code == 200
    assert calls == [("demo:alice", receipt["modelVersion"])]


@pytest.mark.parametrize("suffix", [".joblib", ".json"])
def test_ctime_only_change_invalidates_cached_evidence(tmp_path, monkeypatch, suffix):
    app, _, _, _, receipt = historical_association(tmp_path)
    calls, _ = count_historical_loads(app, monkeypatch)
    assert summary(app).status_code == 200
    calls.clear()
    file = artifact(tmp_path, receipt["modelVersion"], suffix)
    before = file.stat()
    file.chmod((before.st_mode & 0o777) ^ 0o100)
    after = file.stat()
    assert (after.st_ino, after.st_size, after.st_mtime_ns) == (
        before.st_ino, before.st_size, before.st_mtime_ns)
    assert after.st_ctime_ns != before.st_ctime_ns

    assert summary(app).status_code == 200
    assert calls == [("demo:alice", receipt["modelVersion"])]


@pytest.mark.parametrize("suffix", [".joblib", ".json"])
@pytest.mark.parametrize("damage", ["corrupt", "missing"])
def test_warm_cache_cannot_hide_missing_or_corrupt_historical_evidence(tmp_path, monkeypatch, suffix, damage):
    app, _, _, _, receipt = historical_association(tmp_path)
    calls, _ = count_historical_loads(app, monkeypatch)
    assert summary(app).status_code == 200
    calls.clear()
    file = artifact(tmp_path, receipt["modelVersion"], suffix)
    if damage == "missing":
        file.unlink()
    else:
        file.write_bytes(b"corrupt synthetic acceptance evidence")

    response = summary(app)
    assert response.status_code == 503, response.text
    assert response.json()["code"] == "POLICY_STATE_UNAVAILABLE"
    if damage == "corrupt":
        assert calls == [("demo:alice", receipt["modelVersion"])], "Changed evidence must undergo C1 verification"


@pytest.mark.parametrize("field", ["fingerprint", "revision"])
def test_cached_actual_evidence_still_rejects_changed_association_claim(tmp_path, monkeypatch, field):
    app, _, _, event, _ = historical_association(tmp_path)
    calls, _ = count_historical_loads(app, monkeypatch)
    assert summary(app).status_code == 200
    calls.clear()
    file, state = policy_state(tmp_path)
    record = state["associations"][event["eventId"]]
    if field == "fingerprint":
        record["fitFingerprint"] = "0" * 64
    else:
        record["fitReceipt"]["synchronizedFeedbackRevision"] += 1
    save_state(file, state)

    response = summary(app)
    assert response.status_code == 503, response.text
    assert response.json()["code"] == "POLICY_STATE_UNAVAILABLE"
    assert calls == [], "Compare each claim against cached actual evidence, not a cached acceptance boolean"


def test_cache_is_owner_scoped_even_when_other_owner_claims_identical_version(tmp_path, monkeypatch):
    app, _, _, alice_event, alice_receipt = historical_association(tmp_path)
    bob, _, _, bob_event, _ = historical_association(tmp_path, user="demo:bob")
    calls, _ = count_historical_loads(app, monkeypatch)
    assert summary(app).status_code == 200
    calls.clear()
    alice_dir = artifact(tmp_path, alice_receipt["modelVersion"], ".json").parent
    alice_state = json.loads((alice_dir / "policy.json").read_text())["state"]
    alice_record = alice_state["associations"][alice_event["eventId"]]
    with bob.state.model_service._locked("demo:bob") as bob_dir:
        file = bob_dir / "policy.json"
        state = json.loads(file.read_text())["state"]
        record = state["associations"][bob_event["eventId"]]
        record["fitReceipt"] = deepcopy(alice_record["fitReceipt"])
        record["fitFingerprint"] = alice_record["fitFingerprint"]
        for suffix in (".json", ".joblib"):
            shutil.copyfile(alice_dir / (alice_receipt["modelVersion"] + suffix),
                            bob_dir / (alice_receipt["modelVersion"] + suffix))
        save_state(file, state)

    response = summary(app, "demo:bob")
    assert response.status_code == 503, response.text
    assert response.json()["code"] == "POLICY_STATE_UNAVAILABLE"
    assert ("demo:bob", alice_receipt["modelVersion"]) in calls, "Owner must be revalidated despite matching version text"


def test_evidence_cache_evicts_when_distinct_receipts_exceed_capacity(tmp_path, monkeypatch):
    import sortfm_ml.policy_service as policy_module

    monkeypatch.setattr(policy_module, "EVIDENCE_CACHE_SIZE", 2, raising=False)
    app, clock, _, first, snapshot, receipt = prepare(tmp_path)
    associate(app, first, receipt)
    versions = [receipt["modelVersion"]]
    for revision in (3, 4):
        snapshot, receipt = publish(app, snapshot, revision=revision)
        event = {**first, "eventId": uid(6000 + revision), "sequence": revision,
                 "feedbackRevision": revision}
        associate(app, event, receipt)
        versions.append(receipt["modelVersion"])
    publish(app, snapshot, revision=5)
    restored = make_app(tmp_path, clock)
    calls, _ = count_historical_loads(restored, monkeypatch)

    assert summary(restored).status_code == 200
    assert {version for _, version in calls} == set(versions)
    calls.clear()
    assert summary(restored).status_code == 200
    assert calls, "Three distinct receipts cannot remain cached at capacity two"
    assert all(version in versions for _, version in calls)


def test_delayed_old_association_does_not_erase_newer_legacy_decision_reward(tmp_path):
    app, _, selected, old_association, snapshot, _ = prepare(tmp_path)
    newer = observe_event(selected, number=8000, revision=3)
    assert newer["decisionId"] != old_association["decisionId"]
    response = request(app, "POST", "/observe", AUTH, json=newer)
    assert response.status_code == 200, response.text
    _, receipt = publish(app, snapshot, newer, revision=4)
    before = diagnostics(app)
    assert before["counts"]["activeRewards"] == 1

    historical = associate(app, old_association, receipt)
    assert historical["eligibleForLearning"] is False
    after = diagnostics(app)
    assert after["counts"]["activeRewards"] == 1
    assert after["rewardSummary"] == before["rewardSummary"]
