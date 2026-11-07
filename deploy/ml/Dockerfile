# Context: repository root. Runtime matches the project's Python 3.11 line.
FROM python:3.11.14-slim-bookworm@sha256:65a93d69fa75478d554f4ad27c85c1e69fa184956261b4301ebaf6dbb0a3543d AS build
COPY --from=ghcr.io/astral-sh/uv:0.10.4@sha256:4cac394b6b72846f8a85a7a0e577c6d61d4e17fe2ccee65d9451a8b3c9efb4ac /uv /usr/local/bin/uv
WORKDIR /app
ENV UV_PYTHON_DOWNLOADS=never UV_LINK_MODE=copy
COPY services/ml/pyproject.toml services/ml/uv.lock ./
COPY services/ml/src ./src
COPY services/ml/fixtures/authored_profiles.json ./fixtures/authored_profiles.json
RUN uv sync --locked --no-dev --no-editable --no-cache --python /usr/local/bin/python

FROM python:3.11.14-slim-bookworm@sha256:65a93d69fa75478d554f4ad27c85c1e69fa184956261b4301ebaf6dbb0a3543d AS runtime
WORKDIR /app
ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 ML_ARTIFACT_DIR=/data/ml
COPY --from=build /app/.venv /app/.venv
# Mount a Railway volume at /data/ml. Railway volumes are root-owned.
# Keep this service private, in the API's project/environment, with one replica.
EXPOSE 8000
CMD ["sh", "-c", "exec uvicorn sortfm_ml.app:app --host 0.0.0.0 --port \"${PORT:-8000}\" --workers 1"]
