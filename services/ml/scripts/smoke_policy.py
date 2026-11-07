"""Real localhost C2 HTTP smoke: auth, feedback, Undo, restart, frozen logs."""
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
from sortfm_ml.policy_schemas import PolicyDecision, PolicyDiagnostics, PolicyExposure, PolicyReleaseReceipt


def main():
    with TemporaryDirectory(prefix="sortfm-c2-smoke-") as directory:
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        secret = secrets.token_urlsafe(32)
        environment = dict(os.environ, ML_SERVICE_SHARED_SECRET=secret, ML_ARTIFACT_DIR=directory)
        headers = {"Authorization": f"Bearer {secret}"}
        process = None
        with httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=30) as client:
            def start():
                server = subprocess.Popen([sys.executable, "-m", "uvicorn", "sortfm_ml.app:app",
                    "--host", "127.0.0.1", "--port", str(port), "--log-level", "warning"],
                    env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    if server.poll() is not None:
                        raise RuntimeError("Smoke server exited before readiness")
                    try:
                        if client.get("/health").status_code == 200:
                            return server
                    except httpx.TransportError:
                        pass
                    time.sleep(.05)
                server.terminate()
                server.wait(timeout=5)
                raise RuntimeError("Smoke server failed to start")

            def post(path, body):
                response = client.post(path, json=body, headers=headers)
                assert response.status_code == 200, response.text
                return response.json()

            def stats():
                response = client.get("/policy/diagnostics", params={"userId": data["userId"]}, headers=headers)
                assert response.status_code == 200, response.text
                PolicyDiagnostics.model_validate(response.json())
                return response.json()

            try:
                process = start()
                assert client.post("/policy/select", json={}).status_code == 401
                assert client.post("/policy/release", json={}).status_code == 401
                data = generate_synthetic(seed=42, size=180)
                fitted = post("/fit", data)
                train = [row for row in data["examples"] if row["split"] == "train"]
                candidate = {key: train[0][key] for key in ("trackId", "features")}
                selection = {"userId": data["userId"], "featureVersion": data["featureVersion"],
                    "exposureId": str(uuid4()), "candidates": [candidate], "seed": 42, "config": {"alpha": .6}}
                chosen = post("/policy/select", selection)
                PolicyDecision.model_validate(chosen)
                observed = {"userId": data["userId"], "eventId": str(uuid4()), "decisionId": str(uuid4()),
                    "exposureId": chosen["exposureId"], "trackId": chosen["trackId"], "feedbackRevision": 181,
                    "operation": "upsert", "label": 0, "features": candidate["features"], "occurredAt": "2026-11-07T15:00:00Z"}
                feedback = {**observed, "usefulness": .8}
                result = post("/policy/feedback", feedback)
                assert post("/policy/feedback", feedback) == result
                assert stats()["counts"]["activeRewards"] == 1
                assert stats()["labelDistribution"] == {"keep": 1, "remove": 0}
                more = {**selection, "exposureId": str(uuid4()), "candidates": [
                    {key: row[key] for key in ("trackId", "features")} for row in train[1:15]]}
                next_choice = post("/policy/select", more)
                assert next_choice["trainedRewards"] == 1
                assert next_choice["selection"]["selectionMethod"] == "linucb"
                assert next_choice["modelVersion"] != fitted["modelVersion"]
                released = {"userId": data["userId"], "requestId": str(uuid4()),
                            "exposureId": next_choice["exposureId"], "reason": "prefetch_discarded"}
                receipt = post("/policy/release", released)
                PolicyReleaseReceipt.model_validate(receipt)
                assert receipt["outcome"] == "released"
                assert post("/policy/release", released) == receipt
                # Release changes scheduling only, including when a C1 fit
                # already contains the track. It cannot erase learned rewards.
                assert stats()["counts"]["activeRewards"] == 1
                rescheduled = post("/policy/select", {**selection, "exposureId": str(uuid4()),
                    "candidates": [next_choice["candidate"]]})
                assert rescheduled["trackId"] == next_choice["trackId"]
                undo = {**observed, "eventId": str(uuid4()), "feedbackRevision": 182, "operation": "revoke", "label": None}
                post("/observe", undo)
                assert stats()["counts"]["activeRewards"] == 0
                assert post("/policy/select", selection) == chosen
                process.terminate()
                process.wait(timeout=5)
                process = start()
                assert post("/policy/select", selection) == chosen
                assert post("/policy/release", released) == receipt
                assert stats()["counts"]["activeRewards"] == 0
                explained = client.get("/explain", params={"userId": data["userId"], "exposureId": chosen["exposureId"]}, headers=headers)
                assert explained.json()["prediction"] == chosen["prediction"]
                log = client.get("/policy/exposure", params={"userId": data["userId"], "exposureId": chosen["exposureId"]}, headers=headers)
                assert log.status_code == 200
                PolicyExposure.model_validate(log.json())
                assert log.json()["decision"] == chosen
                assert log.json()["reservation"]["closureReason"] == "undo"
                print("PASS real HTTP C2: auth, cold fallback, LinUCB after KEEP feedback, rating, release/reschedule, immutable receipts, Undo, restart, C1 explain and lifecycle inspection; synthetic only")
            finally:
                if process is not None and process.poll() is None:
                    process.terminate()
                    process.wait(timeout=5)


if __name__ == "__main__":
    main()
