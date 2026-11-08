"""Real localhost fit-to-association smoke; only temporary synthetic artifacts."""
from copy import deepcopy
from datetime import datetime, timezone
import os
import secrets
import socket
import subprocess
import sys
from tempfile import TemporaryDirectory
import time
from uuid import uuid4

import httpx

from sortfm_ml.cli import generate_synthetic
from sortfm_ml.policy_schemas import (
    PolicyAssociateResponse, PolicyDecision, PolicyDiagnostics, PolicyExposure,
    PolicyReleaseReceipt,
)
from sortfm_ml.schemas import ExplainResponse, FitResponse


def main():
    with TemporaryDirectory(prefix="sortfm-c2-association-smoke-") as directory:
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        secret = secrets.token_urlsafe(32)
        environment = dict(os.environ, ML_SERVICE_SHARED_SECRET=secret, ML_ARTIFACT_DIR=directory,
                           ML_POLICY_RESERVATION_TTL_SECONDS="30")
        headers = {"Authorization": f"Bearer {secret}"}
        process = None
        started = time.monotonic()
        with httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=30) as client:
            def start():
                server = subprocess.Popen(
                    [sys.executable, "-m", "uvicorn", "sortfm_ml.app:app", "--host", "127.0.0.1",
                     "--port", str(port), "--log-level", "warning"],
                    env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    if server.poll() is not None:
                        raise RuntimeError("Association smoke server exited before readiness")
                    try:
                        if client.get("/health").status_code == 200:
                            return server
                    except httpx.TransportError:
                        pass
                    time.sleep(.05)
                server.terminate()
                server.wait(timeout=5)
                raise RuntimeError("Association smoke server failed to start")

            def post(path, payload, schema=None):
                response = client.post(path, json=payload, headers=headers)
                assert response.status_code == 200, f"{path}: {response.text}"
                result = response.json()
                if schema is not None:
                    schema.model_validate(result)
                return result

            def get(path, params, schema):
                response = client.get(path, params=params, headers=headers)
                assert response.status_code == 200, f"{path}: {response.text}"
                result = response.json()
                schema.model_validate(result)
                return result

            def stats():
                return get("/policy/diagnostics", {"userId": data["userId"]}, PolicyDiagnostics)

            def inspect(chosen):
                return get("/policy/exposure", {"userId": data["userId"],
                           "exposureId": chosen["exposureId"]}, PolicyExposure)

            def fit_receipt(fitted):
                return {"modelVersion": fitted["modelVersion"],
                        "synchronizedFeedbackRevision": fitted["feedbackRevision"]}

            def select_request(row, fitted):
                return {"userId": data["userId"], "featureVersion": data["featureVersion"],
                        "exposureId": str(uuid4()), "seed": 42, "config": {"alpha": .6},
                        "modelVersion": fitted["modelVersion"], "feedbackRevision": fitted["feedbackRevision"],
                        "candidates": [{key: deepcopy(row[key]) for key in ("trackId", "features")}]}

            def cleanup_event(chosen, sequence, revision, label, operation="upsert", decision_id=None):
                return {"eventId": str(uuid4()), "sequence": sequence, "source": "cleanup",
                        "decisionId": decision_id or str(uuid4()), "exposureId": chosen["exposureId"],
                        "trackId": chosen["trackId"], "policyVersion": chosen["policyVersion"],
                        "modelVersion": chosen["modelVersion"], "operation": operation,
                        "feedbackRevision": revision, "label": label,
                        "features": deepcopy(chosen["candidate"]["features"]),
                        "occurredAt": datetime.now(timezone.utc).isoformat()}

            def associate(event, fitted):
                return post("/policy/associate", {"userId": data["userId"], "event": event,
                            "fitReceipt": fit_receipt(fitted)}, PolicyAssociateResponse)

            try:
                process = start()
                assert client.post("/policy/associate", json={}).status_code == 401
                assert client.post("/policy/associate", json={}, headers=headers).status_code == 422
                assert client.post("/policy/select", json={}).status_code == 401
                data = generate_synthetic(seed=42, size=180)
                initial_fit = post("/fit", data, FitResponse)
                train = [row for row in data["examples"] if row["split"] == "train"]

                original_request = select_request(train[0], initial_fit)
                original = post("/policy/select", original_request, PolicyDecision)
                assert original["modelVersion"] == initial_fit["modelVersion"]
                assert original["feedbackRevision"] == initial_fit["feedbackRevision"]
                expiry_request = select_request(train[3], initial_fit)
                expiring = post("/policy/select", expiry_request, PolicyDecision)
                assert inspect(expiring)["reservation"]["status"] == "active"

                # A2 owns the sole training write. Association follows its published full snapshot.
                reviewed = cleanup_event(original, sequence=1,
                                         revision=initial_fit["feedbackRevision"] + 1, label=0)
                reviewed["usefulness"] = .8
                completed = deepcopy(data)
                completed["feedbackRevision"] = reviewed["feedbackRevision"]
                completed_row = next(row for row in completed["examples"] if row["trackId"] == reviewed["trackId"])
                completed_row.update(decisionId=reviewed["decisionId"], label=reviewed["label"],
                                     features=deepcopy(reviewed["features"]), labeledAt=reviewed["occurredAt"])
                completed_fit = post("/fit", completed, FitResponse)
                accepted = associate(reviewed, completed_fit)
                assert accepted["duplicate"] is False
                assert accepted["eligibleForLearning"] is True
                assert associate(reviewed, completed_fit) == {**accepted, "duplicate": True}
                assert stats()["counts"]["activeRewards"] == 1
                assert post("/fit", completed, FitResponse) == completed_fit

                # SKIP gets its own sequence while C1 revision and model stay unchanged.
                skip_request = select_request(train[1], completed_fit)
                skipped = post("/policy/select", skip_request, PolicyDecision)
                skip_event = cleanup_event(skipped, sequence=2,
                                           revision=completed_fit["feedbackRevision"], label=None)
                skip_receipt = associate(skip_event, completed_fit)
                assert skip_receipt["eligibleForLearning"] is False
                assert skip_receipt["duplicate"] is False
                assert skip_receipt["sequence"] != accepted["sequence"]
                assert post("/fit", completed, FitResponse) == completed_fit
                assert stats()["modelVersion"] == completed_fit["modelVersion"]
                assert stats()["counts"]["activeRewards"] == 1
                assert inspect(skipped)["reservation"]["closureReason"] == "skip"
                assert post("/policy/select", skip_request, PolicyDecision) == skipped

                # The next synchronized snapshot removes the review before its Undo telemetry arrives.
                removed = deepcopy(completed)
                removed["feedbackRevision"] += 1
                removed["examples"] = [row for row in removed["examples"] if row["trackId"] != original["trackId"]]
                removed_fit = post("/fit", removed, FitResponse)
                old_retry = associate(reviewed, removed_fit)
                assert old_retry == {**accepted, "duplicate": True, "eligibleForLearning": False,
                                     "fitReceipt": fit_receipt(removed_fit)}
                assert stats()["counts"]["activeRewards"] == 0
                assert inspect(original)["reservation"]["status"] == "active"
                undo = cleanup_event(original, sequence=3, revision=removed_fit["feedbackRevision"],
                                     label=None, operation="revoke", decision_id=reviewed["decisionId"])
                undo_receipt = associate(undo, removed_fit)
                assert undo_receipt["eligibleForLearning"] is False
                original_closed = inspect(original)["reservation"]
                assert original_closed["status"] == "released"
                assert original_closed["closureReason"] == "undo"
                assert associate(undo, removed_fit) == {**undo_receipt, "duplicate": True}
                assert post("/policy/select", original_request, PolicyDecision) == original
                skip_retry = associate(skip_event, removed_fit)
                assert skip_retry == {**skip_receipt, "duplicate": True, "fitReceipt": fit_receipt(removed_fit)}

                discarded_request = select_request(train[2], removed_fit)
                discarded = post("/policy/select", discarded_request, PolicyDecision)
                release_request = {"userId": data["userId"], "requestId": str(uuid4()),
                                   "exposureId": discarded["exposureId"], "reason": "prefetch_discarded"}
                release_receipt = post("/policy/release", release_request, PolicyReleaseReceipt)
                assert release_receipt["outcome"] == "released"
                assert inspect(discarded)["reservation"]["closureReason"] == "explicit_release"

                # Exercise actual HTTP/server-clock expiry at the smallest allowed TTL.
                expiry_deadline = time.monotonic() + 40
                while inspect(expiring)["reservation"]["status"] == "active":
                    if time.monotonic() >= expiry_deadline:
                        raise AssertionError("Thirty-second synthetic lease failed to expire")
                    time.sleep(.1)
                expired = inspect(expiring)["reservation"]
                assert expired["status"] == "expired"
                assert expired["closedAt"] == expired["expiresAt"]
                assert post("/policy/select", expiry_request, PolicyDecision) == expiring
                assert inspect(expiring)["reservation"]["status"] == "expired"

                process.terminate()
                process.wait(timeout=5)
                process = start()
                assert associate(reviewed, removed_fit) == old_retry
                assert associate(undo, removed_fit) == {**undo_receipt, "duplicate": True}
                assert associate(skip_event, removed_fit) == skip_retry
                assert post("/policy/release", release_request, PolicyReleaseReceipt) == release_receipt
                for payload, chosen in ((original_request, original), (skip_request, skipped),
                                        (expiry_request, expiring), (discarded_request, discarded)):
                    assert post("/policy/select", payload, PolicyDecision) == chosen
                    assert inspect(chosen)["decision"] == chosen
                    explained = get("/explain", {"userId": data["userId"],
                                    "exposureId": chosen["exposureId"]}, ExplainResponse)
                    assert explained["prediction"] == chosen["prediction"]
                assert inspect(original)["reservation"]["closedAt"] == original_closed["closedAt"]
                assert inspect(expiring)["reservation"]["status"] == "expired"
                assert stats()["counts"]["activeRewards"] == 0
                assert post("/fit", removed, FitResponse) == removed_fit
                print("PASS real HTTP C2 association: authenticated pinned selection, fit-only training, "
                      "immutable duplicate receipts, same-revision SKIP, advancing-fit inactive replay, "
                      "Undo/release, 30-second expiry, restart and frozen C1 predictions; "
                      f"synthetic temporary artifacts only ({time.monotonic() - started:.2f}s)")
            finally:
                if process is not None and process.poll() is None:
                    process.terminate()
                    process.wait(timeout=5)


if __name__ == "__main__":
    main()
