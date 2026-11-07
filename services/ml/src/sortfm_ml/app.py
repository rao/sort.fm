"""FastAPI application factory."""

import os
import secrets
from typing import Annotated

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from starlette.exceptions import HTTPException as StarletteHTTPException


def create_app(shared_secret: str | None = None) -> FastAPI:
    """Capture configuration once so each application has independent credentials."""
    configured_secret = (
        os.getenv("ML_SERVICE_SHARED_SECRET") if shared_secret is None else shared_secret
    )
    application = FastAPI(title="sort.fm ML", version="1.0.0")

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

    @application.get("/health")
    async def health() -> dict[str, object]:
        return {
            "status": "ok",
            "service": "ml",
            "contractVersion": "1.0.0",
            "capabilities": {"scoring": False, "training": False},
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

    async def not_implemented() -> JSONResponse:
        return JSONResponse(
            status_code=501,
            content={
                "code": "NOT_IMPLEMENTED",
                "message": "This ML capability is not implemented yet.",
                "retryable": False,
            },
        )

    for method, path in [
        ("POST", "/fit"),
        ("POST", "/score"),
        ("POST", "/observe"),
        ("GET", "/evaluation"),
        ("GET", "/explain"),
    ]:
        internal.add_api_route(path, not_implemented, methods=[method], status_code=501)

    application.include_router(internal)
    return application


app = create_app()
