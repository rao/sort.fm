"""HTTP contracts for the foundation service, without external providers."""

import asyncio
import copy
import json
from pathlib import Path
from typing import Any
from uuid import UUID

import httpx
import pytest
from fastapi import FastAPI, HTTPException

from sortfm_ml.app import create_app


INTERNAL_ROUTES = [
    ("POST", "/fit"),
    ("POST", "/score"),
    ("POST", "/observe"),
    ("GET", "/evaluation"),
    ("GET", "/explain"),
]


def request(
    application: FastAPI,
    method: str,
    path: str,
    headers: dict[str, str] | None = None,
    **kwargs: Any,
) -> httpx.Response:
    async def send() -> httpx.Response:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application),
            base_url="http://testserver",
        ) as client:
            return await client.request(
                method, path, headers=httpx.Headers(headers, encoding="utf-8"), **kwargs
            )

    return asyncio.run(send())


@pytest.mark.parametrize("shared_secret", [None, "test-service-secret"])
def test_health_is_public_and_reports_implemented_capabilities(
    monkeypatch: pytest.MonkeyPatch, shared_secret: str | None
) -> None:
    monkeypatch.delenv("ML_SERVICE_SHARED_SECRET", raising=False)
    response = request(create_app(shared_secret=shared_secret), "GET", "/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "service": "ml",
        "contractVersion": "1.0.0",
        "capabilities": {"scoring": True, "training": True},
    }


@pytest.mark.parametrize(("method", "path"), INTERNAL_ROUTES)
@pytest.mark.parametrize("shared_secret", [None, "", "   "])
def test_internal_routes_fail_closed_without_configured_secret(
    monkeypatch: pytest.MonkeyPatch,
    method: str,
    path: str,
    shared_secret: str | None,
) -> None:
    monkeypatch.delenv("ML_SERVICE_SHARED_SECRET", raising=False)
    response = request(
        create_app(shared_secret=shared_secret),
        method,
        path,
        headers={"Authorization": "Bearer supplied-token"},
    )

    assert response.status_code == 503
    body = response.json()
    assert set(body) == {"code", "message", "retryable"}
    assert body["code"] == "ML_NOT_CONFIGURED"
    assert body["message"]
    assert body["retryable"] is False
    assert "supplied-token" not in response.text


@pytest.mark.parametrize(("method", "path"), INTERNAL_ROUTES)
@pytest.mark.parametrize(
    "authorization",
    [None, "Bearer incorrect-token", "Basic test-service-secret", "Bearer", "Bearer ☃"],
)
def test_internal_routes_reject_missing_or_invalid_bearer_tokens(
    method: str, path: str, authorization: str | None
) -> None:
    headers = {"Authorization": authorization} if authorization is not None else None
    response = request(
        create_app(shared_secret="test-service-secret"), method, path, headers=headers
    )

    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"
    body = response.json()
    assert set(body) == {"code", "message", "retryable"}
    assert body["code"] == "UNAUTHORIZED"
    assert body["message"]
    assert body["retryable"] is False
    assert "test-service-secret" not in response.text
    assert "incorrect-token" not in response.text


@pytest.mark.parametrize(("method", "path"), INTERNAL_ROUTES)
def test_authorized_internal_routes_validate_required_inputs(
    method: str, path: str
) -> None:
    response = request(
        create_app(shared_secret="test-service-secret"),
        method,
        path,
        headers={"Authorization": "Bearer test-service-secret"},
    )

    assert response.status_code == 422
    body = response.json()
    assert set(body) == {"code", "message", "retryable"}
    assert body["code"] == "BAD_REQUEST"
    assert body["message"]
    assert body["retryable"] is False
    assert "test-service-secret" not in response.text


def test_factory_reads_environment_when_created(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ML_SERVICE_SHARED_SECRET", "first-environment-secret")
    first = create_app()
    monkeypatch.setenv("ML_SERVICE_SHARED_SECRET", "second-environment-secret")
    second = create_app()

    assert request(
        first, "POST", "/score", {"Authorization": "Bearer first-environment-secret"}
    ).status_code == 422
    assert request(
        first, "POST", "/score", {"Authorization": "Bearer second-environment-secret"}
    ).status_code == 401
    assert request(
        second, "POST", "/score", {"Authorization": "Bearer second-environment-secret"}
    ).status_code == 422


def test_explicit_secret_overrides_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ML_SERVICE_SHARED_SECRET", "environment-secret")
    application = create_app(shared_secret="explicit-secret")

    assert request(
        application, "POST", "/fit", {"Authorization": "Bearer explicit-secret"}
    ).status_code == 422
    assert request(
        application, "POST", "/fit", {"Authorization": "Bearer environment-secret"}
    ).status_code == 401


def test_explicit_empty_secret_does_not_fall_back_to_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ML_SERVICE_SHARED_SECRET", "environment-secret")
    response = request(
        create_app(shared_secret=""),
        "POST",
        "/fit",
        {"Authorization": "Bearer environment-secret"},
    )

    assert response.status_code == 503
    assert response.json()["code"] == "ML_NOT_CONFIGURED"


def test_unknown_route_uses_shared_error_envelope() -> None:
    response = request(create_app(shared_secret="test-service-secret"), "GET", "/missing")

    assert response.status_code == 404
    assert response.json() == {
        "code": "NOT_FOUND",
        "message": "The requested route was not found.",
        "retryable": False,
    }


def test_wrong_method_uses_shared_error_envelope_and_preserves_allow_header() -> None:
    response = request(
        create_app(shared_secret="test-service-secret"),
        "GET",
        "/score",
        {"Authorization": "Bearer test-service-secret"},
    )

    assert response.status_code == 405
    assert response.headers["allow"] == "POST"
    assert response.json() == {
        "code": "METHOD_NOT_ALLOWED",
        "message": "The HTTP method is not allowed for this route.",
        "retryable": False,
    }


def test_http_errors_hide_unstructured_details() -> None:
    application = create_app(shared_secret="test-service-secret")

    @application.get("/test-error")
    async def test_error() -> None:
        raise HTTPException(status_code=400, detail="private-provider-error")

    response = request(application, "GET", "/test-error")

    assert response.status_code == 400
    assert response.json() == {
        "code": "BAD_REQUEST",
        "message": "The request is invalid.",
        "retryable": False,
    }
    assert "private-provider-error" not in response.text


def test_validation_errors_use_shared_error_envelope_without_echoing_input() -> None:
    application = create_app(shared_secret="test-service-secret")

    @application.get("/test-validation")
    async def validated_endpoint(count: int) -> dict[str, int]:
        return {"count": count}

    response = request(application, "GET", "/test-validation?count=private-input")

    assert response.status_code == 422
    assert response.json() == {
        "code": "BAD_REQUEST",
        "message": "The request is invalid.",
        "retryable": False,
    }
    assert "private-input" not in response.text


@pytest.fixture(autouse=True)
def isolated_artifacts(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("ML_ARTIFACT_DIR", str(tmp_path / "artifacts"))


AUTH = {"Authorization": "Bearer test-service-secret"}
VERSION = "sortfm.features.v1"


def feature_vector(energy: float = 0.0) -> dict[str, Any]:
    return {
        "featureVersion": VERSION,
        "values": {"energy": energy, "recent_play_count": 0, "happiness": None},
        "provenance": "synthetic",
        "permittedForTraining": True,
    }


def fit_payload(user_id: str = "demo:alice") -> dict[str, Any]:
    return {
        "userId": user_id,
        "featureVersion": VERSION,
        "feedbackRevision": 1,
        "evaluationSeed": 42,
        "examples": [
            {
                "trackId": f"demo:track-{index}",
                "features": feature_vector(0.1 if index % 2 == 0 else 0.9),
                "decisionId": str(UUID(int=index + 1, version=4)),
                "label": index % 2,
                "split": "train" if index < 24 else "holdout",
                "labeledAt": "2026-11-07T12:00:00Z",
            }
            for index in range(44)
        ],
    }


def score_payload(user_id: str = "demo:alice", model_version: str | None = None) -> dict[str, Any]:
    return {
        "userId": user_id,
        "featureVersion": VERSION,
        "modelVersion": model_version,
        "candidates": [
            {"trackId": "demo:quiet", "features": feature_vector(0.1)},
            {"trackId": "demo:loud", "features": feature_vector(0.9)},
        ],
    }


def test_authenticated_fit_score_observe_and_evaluation_round_trip(tmp_path: Path) -> None:
    application = create_app(shared_secret="test-service-secret", storage_dir=tmp_path)
    fitted = request(application, "POST", "/fit", AUTH, json=fit_payload())
    assert fitted.status_code == 200, fitted.text
    fit_result = fitted.json()
    assert fit_result["trainedExamples"] == 24
    assert fit_result["metrics"]["heldOutExamples"] == 20
    assert fit_result["metrics"]["status"] == "available"
    version = fit_result["modelVersion"]

    scored = request(application, "POST", "/score", AUTH, json=score_payload())
    assert scored.status_code == 200, scored.text
    predictions = scored.json()["predictions"]
    assert [row["trackId"] for row in predictions] == ["demo:quiet", "demo:loud"]
    assert all(row["prediction"]["modelKind"] == "logistic" for row in predictions)
    assert predictions[0]["prediction"]["removalProbability"] < predictions[1]["prediction"]["removalProbability"]
    assert all(row["prediction"]["calibrated"] is False for row in predictions)
    evaluation = request(application, "GET", "/evaluation", AUTH, params={"userId": "demo:alice"})
    assert evaluation.status_code == 200
    assert evaluation.json() == fit_result["metrics"]

    example = fit_payload()["examples"][0]
    event = {
        "userId": "demo:alice",
        "eventId": str(UUID(int=100, version=4)),
        "decisionId": str(UUID(int=101, version=4)),
        "exposureId": str(UUID(int=102, version=4)),
        "trackId": example["trackId"],
        "feedbackRevision": 2,
        "operation": "upsert",
        "label": 1,
        "features": example["features"],
        "occurredAt": "2026-11-07T12:05:00-05:00",
    }
    observed = request(application, "POST", "/observe", AUTH, json=event)
    assert observed.status_code == 200, observed.text
    assert observed.json()["accepted"] is True
    assert observed.json()["feedbackRevision"] == 2
    assert observed.json()["modelVersion"] != version
    repeated = request(application, "POST", "/observe", AUTH, json=event)
    assert repeated.status_code == 200
    assert repeated.json() == observed.json()

    restored = create_app(shared_secret="test-service-secret", storage_dir=tmp_path)
    pinned = request(restored, "POST", "/score", AUTH, json=score_payload(model_version=version))
    assert pinned.status_code == 200
    assert pinned.json() == scored.json()
    other_user = request(restored, "POST", "/score", AUTH, json=score_payload("demo:bob", version))
    assert other_user.status_code == 404
    assert set(other_user.json()) <= {"code", "message", "retryable"}
    baseline = request(restored, "POST", "/score", AUTH, json=score_payload("demo:bob"))
    assert baseline.status_code == 200
    assert all(row["prediction"]["removalProbability"] is None for row in baseline.json()["predictions"])


def test_unknown_exposure_is_explicit_not_found() -> None:
    response = request(
        create_app(shared_secret="test-service-secret"), "GET", "/explain", AUTH,
        params={"userId": "demo:alice", "exposureId": str(UUID(int=100, version=4))},
    )
    assert response.status_code == 404
    assert set(response.json()) <= {"code", "message", "retryable"}


@pytest.mark.parametrize("path", ["/evaluation?userId=demo:alice&extra=private", "/explain?userId=demo:alice&exposureId=not-a-uuid", "/evaluation?userId=../alice"])
def test_query_contract_rejects_invalid_fields_without_echoing_input(path: str) -> None:
    response = request(create_app(shared_secret="test-service-secret"), "GET", path, AUTH)
    assert response.status_code == 422
    assert response.json()["code"] == "BAD_REQUEST"
    assert "private" not in response.text


@pytest.mark.parametrize("invalid", [float("nan"), float("inf"), -float("inf"), True, "0.2", -0.1, 1.1])
def test_score_rejects_nonfinite_and_out_of_contract_features(invalid: Any) -> None:
    payload = score_payload()
    payload["candidates"][0]["features"]["values"]["energy"] = invalid
    response = request(
        create_app(shared_secret="test-service-secret"), "POST", "/score",
        {**AUTH, "Content-Type": "application/json"}, content=json.dumps(payload),
    )
    assert response.status_code == 422
    assert response.json() == {"code": "BAD_REQUEST", "message": "The request is invalid.", "retryable": False}


def test_environment_artifact_directory_survives_new_app_instance() -> None:
    first = create_app(shared_secret="test-service-secret")
    fitted = request(first, "POST", "/fit", AUTH, json=fit_payload())
    assert fitted.status_code == 200
    second = create_app(shared_secret="test-service-secret")
    response = request(second, "POST", "/score", AUTH, json=score_payload())
    assert response.status_code == 200
    assert response.json()["modelVersion"] == fitted.json()["modelVersion"]


def test_keyed_score_preserves_explanation_across_retraining_and_restart(tmp_path: Path) -> None:
    application = create_app(shared_secret="test-service-secret", storage_dir=tmp_path)
    fitted = request(application, "POST", "/fit", AUTH, json=fit_payload())
    assert fitted.status_code == 200
    payload = score_payload()
    payload["candidates"] = [payload["candidates"][0]]
    exposure_id = str(UUID(int=500, version=4))
    payload["candidates"][0]["exposureId"] = exposure_id
    original = request(application, "POST", "/score", AUTH, json=payload)
    assert original.status_code == 200, original.text
    explanation = request(application, "GET", "/explain", AUTH, params={"userId": "demo:alice", "exposureId": exposure_id})
    assert explanation.status_code == 200, explanation.text
    assert explanation.json() == {"exposureId": exposure_id, "prediction": original.json()["predictions"][0]["prediction"]}

    event = {
        "userId": "demo:alice", "eventId": str(UUID(int=501, version=4)),
        "decisionId": str(UUID(int=502, version=4)), "exposureId": exposure_id,
        "trackId": "demo:track-0", "feedbackRevision": 2, "operation": "upsert",
        "label": 1, "features": feature_vector(0.1), "occurredAt": "2026-11-07T13:00:00Z",
    }
    observed = request(application, "POST", "/observe", AUTH, json=event)
    assert observed.status_code == 200, observed.text
    assert observed.json()["modelVersion"] != original.json()["modelVersion"]
    restored = create_app(shared_secret="test-service-secret", storage_dir=tmp_path)
    retried = request(restored, "POST", "/score", AUTH, json=payload)
    assert retried.status_code == 200, retried.text
    assert retried.json() == original.json()
    after = request(restored, "GET", "/explain", AUTH, params={"userId": "demo:alice", "exposureId": exposure_id})
    assert after.json() == explanation.json()
    unauthorized_owner = request(restored, "GET", "/explain", AUTH, params={"userId": "demo:bob", "exposureId": exposure_id})
    assert unauthorized_owner.status_code == 404

    for change in ["track", "features", "version"]:
        conflicting = copy.deepcopy(payload)
        if change == "track":
            conflicting["candidates"][0]["trackId"] = "demo:other"
        elif change == "features":
            conflicting["candidates"][0]["features"]["values"]["energy"] = 0.8
        else:
            conflicting["modelVersion"] = observed.json()["modelVersion"]
        response = request(restored, "POST", "/score", AUTH, json=conflicting)
        assert response.status_code == 409, response.text
        assert response.json()["code"] == "EXPOSURE_CONFLICT"


def test_failed_keyed_batch_does_not_partially_register_exposures() -> None:
    application = create_app(shared_secret="test-service-secret")
    payload = score_payload()
    payload["candidates"] = [payload["candidates"][0]]
    existing_id = str(UUID(int=600, version=4))
    payload["candidates"][0]["exposureId"] = existing_id
    original = request(application, "POST", "/score", AUTH, json=payload)
    assert original.status_code == 200
    new_id = str(UUID(int=601, version=4))
    failed_batch = copy.deepcopy(payload)
    fresh = {"trackId": "demo:fresh", "features": feature_vector(), "exposureId": new_id}
    failed_batch["candidates"][0]["trackId"] = "demo:conflict"
    failed_batch["candidates"].insert(0, fresh)
    response = request(application, "POST", "/score", AUTH, json=failed_batch)
    assert response.status_code == 409, response.text
    missing = request(application, "GET", "/explain", AUTH, params={"userId": "demo:alice", "exposureId": new_id})
    assert missing.status_code == 404


def test_response_validation_errors_use_safe_error_envelope() -> None:
    from sortfm_ml.schemas import ObserveResponse

    application = create_app(shared_secret="test-service-secret")

    @application.get("/test-invalid-response", response_model=ObserveResponse)
    def invalid_response() -> dict:
        return {"private-provider-error": "not-a-contract-response"}

    response = request(application, "GET", "/test-invalid-response")
    assert response.status_code == 500
    assert set(response.json()) == {"code", "message", "retryable"}
    assert response.json()["code"] == "INTERNAL_ERROR"
    assert "private-provider-error" not in response.text
