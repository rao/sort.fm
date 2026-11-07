# sort.fm ML service

Python 3.11+ and `uv` are required. From this directory:

```sh
uv sync --locked
uv run pytest
uv run uvicorn sortfm_ml.app:app --host 127.0.0.1 --port 8000
```

`GET /health` is public and reports contract version `1.0.0` with scoring and
training capabilities disabled.

Set `ML_SERVICE_SHARED_SECRET` in the process environment before starting the
service. Internal requests use `Authorization: Bearer <shared secret>`.
`POST /fit`, `POST /score`, `POST /observe`, `GET /evaluation`, and `GET /explain`
return a top-level JSON error envelope `{code, message, retryable: false}`:

- `503 ML_NOT_CONFIGURED` when the secret is absent or blank.
- `401 UNAUTHORIZED` when the token is absent, malformed, or incorrect.
- `501 NOT_IMPLEMENTED` when authenticated, because these capabilities are stubs.

The application factory `create_app(shared_secret: str | None = None)` captures
the environment when called. An explicit value overrides the environment;
an explicit blank string disables internal routes. Restart the process after
changing its environment secret.

This foundation has no scoring, training, fabricated metrics, persisted models,
or external provider calls. Future ML request and response models must consume
the JSON schemas generated from the shared Zod contracts in
`packages/contracts`; this service does not define competing payload schemas.
