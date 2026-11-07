"""FastAPI application factory."""

import os
import secrets
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError, ResponseValidationError
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from starlette.exceptions import HTTPException as StarletteHTTPException

from .schemas import (
    EvaluationQuery, ExplainQuery, ExplainResponse, FitRequest, FitResponse,
    MLHealth, ModelMetrics, ObserveRequest, ObserveResponse, ScoreRequest, ScoreResponse,
)
from .service import ModelService, ServiceError


def create_app(
    shared_secret: str | None = None, storage_dir: str | Path | None = None
) -> FastAPI:
    """Capture configuration once so each application has independent credentials."""
    configured_secret = (
        os.getenv("ML_SERVICE_SHARED_SECRET") if shared_secret is None else shared_secret
    )
    application = FastAPI(title="sort.fm ML", version="1.0.0")
    model_service = ModelService(
        os.getenv("ML_ARTIFACT_DIR", "artifacts") if storage_dir is None else storage_dir
    )
    application.state.model_service = model_service

    @application.exception_handler(ServiceError)
    async def model_error(_request: Request, error: ServiceError) -> JSONResponse:
        return JSONResponse(
            status_code=error.status,
            content={"code": error.code, "message": error.message, "retryable": error.retryable},
        )

    @application.exception_handler(ResponseValidationError)
    async def response_error(_request: Request, _error: ResponseValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=500,
            content={"code": "INTERNAL_ERROR", "message": "The service response is invalid.", "retryable": False},
        )

    @application.exception_handler(StarletteHTTPException)
    async def service_error(_request: Request, error: StarletteHTTPException) -> JSONResponse:
        safe_errors = {
            404: ("NOT_FOUND", "The requested route was not found."),
            405: ("METHOD_NOT_ALLOWED", "The HTTP method is not allowed for this route."),
        }
        code, message = safe_errors.get(error.status_code, ("BAD_REQUEST", "The request is invalid."))
        content = {"code": code, "message": message, "retryable": False}
        # Only deliberately structured service errors are returned verbatim.
        if isinstance(error.detail, dict) and set(error.detail) <= {"code", "message", "retryable"} and isinstance(error.detail.get("code"), str) and isinstance(error.detail.get("message"), str):
            content = error.detail
        return JSONResponse(
            status_code=error.status_code, content=content, headers=error.headers
        )

    @application.exception_handler(RequestValidationError)
    async def validation_error(_request: Request, _error: RequestValidationError) -> JSONResponse:
        return JSONResponse(status_code=422, content={"code": "BAD_REQUEST", "message": "The request is invalid.", "retryable": False})

    @application.get("/health", response_model=MLHealth)
    async def health() -> dict[str, object]:
        return {
            "status": "ok",
            "service": "ml",
            "contractVersion": "1.0.0",
            "capabilities": {"scoring": True, "training": True},
        }

    async def require_shared_secret(
        credentials: Annotated[
            HTTPAuthorizationCredentials | None, Depends(HTTPBearer(auto_error=False))
        ],
    ) -> None:
        if configured_secret is None or not configured_secret.strip():
            raise HTTPException(
                status_code=503,
                detail={
                    "code": "ML_NOT_CONFIGURED",
                    "message": "The ML service shared secret is not configured.",
                    "retryable": False,
                },
            )
        if credentials is None or not secrets.compare_digest(
            credentials.credentials.encode("utf-8"), configured_secret.encode("utf-8")
        ):
            raise HTTPException(
                status_code=401,
                detail={
                    "code": "UNAUTHORIZED",
                    "message": "A valid service bearer token is required.",
                    "retryable": False,
                },
                headers={"WWW-Authenticate": "Bearer"},
            )

    internal = APIRouter(dependencies=[Depends(require_shared_secret)])

    # Synchronous handlers run in FastAPI's worker pool: CPU fits and flock
    # waits must not block the ASGI event loop or public liveness checks.
    @internal.post("/fit", response_model=FitResponse)
    def fit(payload: FitRequest) -> dict:
        return model_service.fit(payload.model_dump(exclude_unset=True))

    @internal.post("/score", response_model=ScoreResponse)
    def score(payload: ScoreRequest) -> dict:
        return model_service.score(payload.model_dump(exclude_unset=True))

    @internal.post("/observe", response_model=ObserveResponse)
    def observe(payload: ObserveRequest) -> dict:
        return model_service.observe(payload.model_dump(exclude_unset=True))

    @internal.get("/evaluation", response_model=ModelMetrics)
    def evaluation(query: Annotated[EvaluationQuery, Query()]) -> dict:
        return model_service.evaluation(query.userId, query.modelVersion)

    @internal.get("/explain", response_model=ExplainResponse)
    def explain(query: Annotated[ExplainQuery, Query()]) -> dict:
        return model_service.explain(query.userId, query.exposureId)

    application.include_router(internal)
    return application


app = create_app()
