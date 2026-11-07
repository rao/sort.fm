"""The generated TypeScript contracts and refinements are the wire authority."""

import importlib
import json
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator, FormatChecker
from pydantic import ValidationError

from test_app import AUTH, fit_payload, request, score_payload
from sortfm_ml.app import create_app

CONTRACTS = json.loads(
    (Path(__file__).resolve().parents[3] / "packages/contracts/generated/contracts.schema.json").read_text()
)


def dto(name: str) -> type:
    return getattr(importlib.import_module("sortfm_ml.schemas"), name)


def canonical(name: str) -> Draft202012Validator:
    return Draft202012Validator(CONTRACTS["schemas"][name + "Schema"], format_checker=FormatChecker())


def observation() -> dict[str, Any]:
    example = fit_payload()["examples"][0]
    return {
        "userId": "demo:alice",
        "eventId": "11111111-1111-4111-8111-111111111111",
        "decisionId": example["decisionId"],
        "exposureId": "22222222-2222-4222-8222-222222222222",
        "trackId": example["trackId"],
        "feedbackRevision": 2,
        "operation": "upsert",
        "label": 1,
        "features": example["features"],
        "occurredAt": "2026-11-07T12:00:00-05:00",
    }


@pytest.mark.parametrize(("name", "payload"), [
    ("FitRequest", fit_payload()), ("ScoreRequest", score_payload()),
    ("ObserveRequest", observation()),
    ("EvaluationQuery", {"userId": "demo:alice"}),
    ("ExplainQuery", {"userId": "demo:alice", "exposureId": "00000000-0000-0000-0000-000000000000"}),
])
def test_valid_requests_round_trip_without_renaming_or_inventing_fields(name: str, payload: dict) -> None:
    canonical(name).validate(payload)
    parsed = dto(name).model_validate(payload)
    result = parsed.model_dump(exclude_unset=True)
    assert result == payload
    canonical(name).validate(result)


@pytest.mark.parametrize(("name", "collection", "factory"), [
    ("ScoreRequest", "candidates", score_payload),
    ("FitRequest", "examples", fit_payload),
])
@pytest.mark.parametrize("provenance", ["synthetic", "licensed", "spotify", "soundnet", "musicae"])
def test_readers_preserve_partial_features_for_supported_provenance(name: str, collection: str, factory: Any, provenance: str) -> None:
    payload = factory()
    features = payload[collection][0]["features"]
    features.update({
        "provenance": provenance,
        "values": {"energy": 0, "tempo_bpm": 123.5, "loudness_db": -8, "mode_major": 0},
    })

    canonical(name).validate(payload)
    parsed = dto(name).model_validate(payload)
    result = getattr(parsed, collection)[0].features
    assert result.provenance == provenance
    assert result.featureVersion == "sortfm.features.v1"
    assert result.values.energy == 0
    assert result.values.mode_major == 0
    assert result.values.happiness is None
    assert result.values.soundnet_popularity is None
    assert result.model_dump(exclude_unset=True) == features
    canonical(name).validate(parsed.model_dump(exclude_unset=True))


@pytest.mark.parametrize(("name", "collection", "factory"), [
    ("ScoreRequest", "candidates", score_payload),
    ("FitRequest", "examples", fit_payload),
])
@pytest.mark.parametrize(("field", "value"), [
    ("valence", 0.5), ("energy", 57), ("tempo_bpm", 0),
    ("loudness_db", -101), ("unknown_audio_feature", 0.5),
])
def test_musicae_readers_reject_aliases_unknown_features_and_invalid_units(name: str, collection: str, factory: Any, field: str, value: Any) -> None:
    payload = factory()
    payload[collection][0]["features"].update({"provenance": "musicae", "values": {field: value}})
    assert not canonical(name).is_valid(payload)
    with pytest.raises(ValidationError) as error:
        dto(name).model_validate(payload)
    assert (collection, 0, "features", "values", field) in [entry["loc"] for entry in error.value.errors()]


@pytest.mark.parametrize(("name", "collection", "factory"), [
    ("ScoreRequest", "candidates", score_payload),
    ("FitRequest", "examples", fit_payload),
])
def test_readers_still_reject_unknown_provenance(name: str, collection: str, factory: Any) -> None:
    payload = factory()
    payload[collection][0]["features"]["provenance"] = "unknown-provider"
    assert not canonical(name).is_valid(payload)
    with pytest.raises(ValidationError):
        dto(name).model_validate(payload)


@pytest.mark.parametrize(("field", "value", "accepted"), [
    ("energy", 0, True), ("energy", 1, True), ("energy", None, True),
    ("energy", -0.01, False), ("energy", 1.01, False), ("energy", True, False),
    ("energy", "0.5", False), ("duration_ms", 0, True), ("duration_ms", 2.0, True),
    ("duration_ms", 1.5, False), ("duration_ms", True, False),
    ("duration_ms", 9007199254740991, True), ("duration_ms", 9007199254740992, False),
    ("saved_age_days", -1, False), ("release_age_years", 0, True),
    ("tempo_bpm", 0, False), ("tempo_bpm", 400, True), ("tempo_bpm", 401, False),
    ("loudness_db", -100, True), ("loudness_db", 10, True), ("loudness_db", -101, False),
    ("key_sin", -1, True), ("key_cos", 1, True), ("key_cos", 1.01, False),
    ("mode_major", 0, True), ("mode_major", 1.0, True), ("mode_major", True, False),
    ("mode_major", 2, False), ("soundnet_popularity", 1, True),
    ("kept_centroid_distance", -1, False), ("removed_centroid_distance", 0, True),
    ("unknown_audio_feature", 0.5, False),
])
def test_feature_values_match_canonical_types_bounds_and_missingness(field: str, value: Any, accepted: bool) -> None:
    payload = {field: value}
    assert canonical("FeatureValues").is_valid(payload) is accepted
    if accepted:
        assert dto("FeatureValues").model_validate(payload).model_dump(exclude_unset=True) == payload
    else:
        with pytest.raises(ValidationError):
            dto("FeatureValues").model_validate(payload)


@pytest.mark.parametrize("field", ["saved_age_days", "energy", "tempo_bpm", "kept_centroid_distance"])
@pytest.mark.parametrize("value", [float("nan"), float("inf"), -float("inf")])
def test_all_numbers_reject_nonfinite_values(field: str, value: float) -> None:
    with pytest.raises(ValidationError):
        dto("FeatureValues").model_validate({field: value})


@pytest.mark.parametrize(("field", "value"), [
    ("userId", ""), ("userId", "a" * 129), ("userId", "../user"),
    ("featureVersion", "sortfm.features.v2"), ("feedbackRevision", -1),
    ("feedbackRevision", True), ("feedbackRevision", "1"),
    ("evaluationSeed", 9007199254740992), ("evaluationSeed", -9007199254740992),
    ("evaluationSeed", 1.5), ("evaluationSeed", False), ("extra", "private"),
])
def test_fit_rejects_out_of_contract_top_level_fields(field: str, value: Any) -> None:
    payload = fit_payload()
    payload[field] = value
    assert not canonical("FitRequest").is_valid(payload)
    with pytest.raises(ValidationError):
        dto("FitRequest").model_validate(payload)


@pytest.mark.parametrize("timestamp", ["2026-02-29T12:00:00Z", "2026-11-07", "2026-11-07T12:00:00", "2026-11-07T12:00:00+25:00", "2026-11-07 12:00:00Z", "2026-11-07T12:00:00z"])
def test_timestamp_uses_canonical_iso_calendar_and_offset_rules(timestamp: str) -> None:
    payload = observation()
    payload["occurredAt"] = timestamp
    assert not canonical("ObserveRequest").is_valid(payload)
    with pytest.raises(ValidationError):
        dto("ObserveRequest").model_validate(payload)


@pytest.mark.parametrize("uuid", ["not-a-uuid", "11111111-1111-0111-8111-111111111111", "11111111-1111-4111-1111-111111111111", "11111111111141118111111111111111"])
def test_uuid_requires_canonical_version_variant_and_hyphens(uuid: str) -> None:
    payload = observation()
    payload["eventId"] = uuid
    assert not canonical("ObserveRequest").is_valid(payload)
    with pytest.raises(ValidationError):
        dto("ObserveRequest").model_validate(payload)


def test_nested_feature_fields_are_strict_and_optional_rights_are_not_nullable() -> None:
    for change in [{"rightsBasis": None}, {"rightsBasis": ""}, {"permittedForTraining": 1}, {"featureVersion": "other"}, {"extra": 1}]:
        payload = score_payload()
        payload["candidates"][0]["features"].update(change)
        assert not canonical("ScoreRequest").is_valid(payload)
        with pytest.raises(ValidationError):
            dto("ScoreRequest").model_validate(payload)


def test_score_requires_nullable_model_version_and_obeys_candidate_limit() -> None:
    payload = score_payload()
    del payload["modelVersion"]
    with pytest.raises(ValidationError):
        dto("ScoreRequest").model_validate(payload)
    payload = score_payload()
    payload["candidates"] = [payload["candidates"][0]] * 10001
    with pytest.raises(ValidationError):
        dto("ScoreRequest").model_validate(payload)


def test_observe_revoke_refinement_rejects_active_label() -> None:
    payload = observation()
    payload["operation"] = "revoke"
    # The generated JSON schema cannot express Zod's superRefine.
    assert canonical("ObserveRequest").is_valid(payload)
    with pytest.raises(ValidationError):
        dto("ObserveRequest").model_validate(payload)
    payload["label"] = None
    dto("ObserveRequest").model_validate(payload)


def test_prediction_refinement_does_not_present_heuristics_as_probabilities() -> None:
    fixture = json.loads((Path(__file__).resolve().parents[3] / "packages/contracts/generated/demo-bootstrap.json").read_text())
    prediction = fixture["queue"]["items"][0]["prediction"]
    dto("Prediction").model_validate(prediction)
    for change in [{"removalProbability": 0.5}, {"calibrated": True}]:
        invalid = {**prediction, **change}
        with pytest.raises(ValidationError):
            dto("Prediction").model_validate(invalid)


def test_metrics_refinements_reject_impossible_counts_and_fabricated_values() -> None:
    fixture = json.loads((Path(__file__).resolve().parents[3] / "packages/contracts/generated/demo-bootstrap.json").read_text())
    metrics = fixture["metrics"]
    dto("ModelMetrics").model_validate(metrics)
    for change in [{"baseRate": 0.5}, {"heldOutPositive": 1}, {"trainedExamples": metrics["labeledExamples"] + 1}, {"status": "available"}]:
        with pytest.raises(ValidationError):
            dto("ModelMetrics").model_validate({**metrics, **change})


def test_real_http_outputs_match_generated_internal_route_schemas(tmp_path: Path) -> None:
    application = create_app(shared_secret="test-service-secret", storage_dir=tmp_path)
    scored_payload = score_payload()
    exposure_id = "33333333-3333-4333-8333-333333333333"
    scored_payload["candidates"][0]["exposureId"] = exposure_id
    calls = [
        ("health", "GET", "/health", {}),
        ("fit", "POST", "/fit", {"json": fit_payload()}),
        ("score", "POST", "/score", {"json": scored_payload}),
        ("explain", "GET", "/explain", {"params": {"userId": "demo:alice", "exposureId": exposure_id}}),
        ("evaluation", "GET", "/evaluation", {"params": {"userId": "demo:alice"}}),
        ("observe", "POST", "/observe", {"json": observation()}),
    ]
    for name, method, path, kwargs in calls:
        response = request(application, method, path, AUTH, **kwargs)
        assert response.status_code == 200, response.text
        Draft202012Validator(CONTRACTS["internalRoutes"][name]["response"], format_checker=FormatChecker()).validate(response.json())


def test_scoring_exposure_is_optional_uuid_and_not_a_training_field() -> None:
    payload = score_payload()
    exposure_id = "11111111-1111-4111-8111-111111111111"
    payload["candidates"][0]["exposureId"] = exposure_id
    canonical("ScoreRequest").validate(payload)
    assert dto("ScoreRequest").model_validate(payload).model_dump(exclude_unset=True) == payload
    for invalid in [None, "bad-id"]:
        payload["candidates"][0]["exposureId"] = invalid
        with pytest.raises(ValidationError):
            dto("ScoreRequest").model_validate(payload)
    example = {**fit_payload()["examples"][0], "exposureId": exposure_id}
    assert not canonical("TrainingExample").is_valid(example)
    with pytest.raises(ValidationError):
        dto("TrainingExample").model_validate(example)



def test_every_canonical_feature_accepts_explicit_missing_values() -> None:
    payload = {field: None for field in CONTRACTS["schemas"]["FeatureValuesSchema"]["properties"]}
    assert dto("FeatureValues").model_validate(payload).model_dump(exclude_unset=True) == payload


@pytest.mark.parametrize("timestamp", ["2024-02-29T00:00:00Z", "2026-11-07T23:59:59.123456-05:00", "2026-11-07T12:00:00+03:30"])
def test_valid_timestamps_preserve_wire_representation(timestamp: str) -> None:
    payload = observation()
    payload["occurredAt"] = timestamp
    canonical("ObserveRequest").validate(payload)
    assert dto("ObserveRequest").model_validate(payload).occurredAt == timestamp
