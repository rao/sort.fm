"""HTTP contracts for the foundation service, without external providers."""

import asyncio

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
) -> httpx.Response:
    async def send() -> httpx.Response:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application),
            base_url="http://testserver",
        ) as client:
            return await client.request(
                method, path, headers=httpx.Headers(headers, encoding="utf-8")
            )

    return asyncio.run(send())


@pytest.mark.parametrize("shared_secret", [None, "test-service-secret"])
def test_health_is_public_and_reports_unavailable_capabilities(
    monkeypatch: pytest.MonkeyPatch, shared_secret: str | None
) -> None:
    monkeypatch.delenv("ML_SERVICE_SHARED_SECRET", raising=False)
    response = request(create_app(shared_secret=shared_secret), "GET", "/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "service": "ml",
        "contractVersion": "1.0.0",
        "capabilities": {"scoring": False, "training": False},
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
def test_authorized_internal_routes_report_not_implemented(
    method: str, path: str
) -> None:
    response = request(
        create_app(shared_secret="test-service-secret"),
        method,
        path,
        headers={"Authorization": "Bearer test-service-secret"},
    )

    assert response.status_code == 501
    body = response.json()
    assert set(body) == {"code", "message", "retryable"}
    assert body["code"] == "NOT_IMPLEMENTED"
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
    ).status_code == 501
    assert request(
        first, "POST", "/score", {"Authorization": "Bearer second-environment-secret"}
    ).status_code == 401
    assert request(
        second, "POST", "/score", {"Authorization": "Bearer second-environment-secret"}
    ).status_code == 501


def test_explicit_secret_overrides_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ML_SERVICE_SHARED_SECRET", "environment-secret")
    application = create_app(shared_secret="explicit-secret")

    assert request(
        application, "POST", "/fit", {"Authorization": "Bearer explicit-secret"}
    ).status_code == 501
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
