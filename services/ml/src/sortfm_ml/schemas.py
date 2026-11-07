"""Strict mirrors of packages/contracts/src/{features,schemas,routes}.ts.

Wire names intentionally stay camelCase. Optional fields retain omission when
passed to the service with ``model_dump(exclude_unset=True)``. The generated
JSON Schema supplies bounds; the validators mirror Zod's cross-field rules.
"""

from typing import Annotated, Any, Literal, Self

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, StringConstraints, model_validator

FEATURE_VERSION = "sortfm.features.v1"
CONTRACT_VERSION = "1.0.0"
MAX_SAFE_INTEGER = 9007199254740991


class WireModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


def _json_integer(value: Any) -> Any:
    # JSON numbers do not distinguish 2 from 2.0; neither strings nor bools
    # are numbers in the canonical contract.
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def _numeric_literal(value: Any) -> Any:
    if type(value) not in (int, float):
        raise ValueError("Expected a numeric label")
    return value


Identifier = Annotated[str, StringConstraints(min_length=1, max_length=128, pattern=r"^[a-zA-Z0-9:_-]+$")]
Uuid = Annotated[str, StringConstraints(pattern=r"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$")]
# Copied from the generated TimestampSchema. Keep calendar validity, required
# seconds, capital T/Z, and offset acceptance identical across languages.
Timestamp = Annotated[str, StringConstraints(pattern=r"^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$")]
NonEmptyString = Annotated[str, StringConstraints(min_length=1)]
SafeInteger = Annotated[int, Field(ge=-MAX_SAFE_INTEGER, le=MAX_SAFE_INTEGER), BeforeValidator(_json_integer)]
Count = Annotated[int, Field(ge=0, le=MAX_SAFE_INTEGER), BeforeValidator(_json_integer)]
Probability = Annotated[float, Field(ge=0, le=1)]
NonNegative = Annotated[float, Field(ge=0)]
BinaryLabel = Annotated[Literal[0, 1], BeforeValidator(_numeric_literal)]
FeatureVersion = Literal["sortfm.features.v1"]


class FeatureValues(WireModel):
    saved_age_days: NonNegative | None = None
    release_age_years: NonNegative | None = None
    duration_ms: Count | None = None
    artist_library_count: Count | None = None
    top_track_short: Probability | None = None
    top_track_medium: Probability | None = None
    top_track_long: Probability | None = None
    top_artist: Probability | None = None
    recent_play_count: Count | None = None
    energy: Probability | None = None
    danceability: Probability | None = None
    happiness: Probability | None = None
    acousticness: Probability | None = None
    instrumentalness: Probability | None = None
    liveness: Probability | None = None
    speechiness: Probability | None = None
    tempo_bpm: Annotated[float, Field(gt=0, le=400)] | None = None
    loudness_db: Annotated[float, Field(ge=-100, le=10)] | None = None
    key_sin: Annotated[float, Field(ge=-1, le=1)] | None = None
    key_cos: Annotated[float, Field(ge=-1, le=1)] | None = None
    mode_major: BinaryLabel | None = None
    soundnet_popularity: Probability | None = None
    kept_centroid_distance: NonNegative | None = None
    removed_centroid_distance: NonNegative | None = None


class FeatureVector(WireModel):
    featureVersion: FeatureVersion
    values: FeatureValues
    provenance: Literal["synthetic", "licensed", "spotify", "soundnet"]
    permittedForTraining: bool
    # Optional, but an explicitly supplied null is invalid in the TS schema.
    rightsBasis: NonEmptyString = Field(default=None)  # type: ignore[assignment]


class Candidate(WireModel):
    trackId: Identifier
    features: FeatureVector


class ScoringCandidate(Candidate):
    exposureId: Uuid = Field(default=None)  # type: ignore[assignment]


class TrainingExample(Candidate):
    decisionId: Uuid
    label: BinaryLabel
    split: Literal["train", "holdout"]
    labeledAt: Timestamp


class FitRequest(WireModel):
    userId: Identifier
    featureVersion: FeatureVersion
    feedbackRevision: Count
    examples: list[TrainingExample]
    evaluationSeed: SafeInteger


class ScoreRequest(WireModel):
    userId: Identifier
    featureVersion: FeatureVersion
    candidates: Annotated[list[ScoringCandidate], Field(max_length=10000)]
    modelVersion: str | None


class ObserveRequest(WireModel):
    userId: Identifier
    eventId: Uuid
    decisionId: Uuid
    exposureId: Uuid
    trackId: Identifier
    feedbackRevision: Count
    operation: Literal["upsert", "revoke"]
    label: BinaryLabel | None
    features: FeatureVector
    occurredAt: Timestamp

    @model_validator(mode="after")
    def revocation_has_no_label(self) -> Self:
        if self.operation == "revoke" and self.label is not None:
            raise ValueError("Revocation removes the prior label")
        return self


class EvaluationQuery(WireModel):
    userId: Identifier
    modelVersion: str = Field(default=None)  # type: ignore[assignment]


class ExplainQuery(WireModel):
    userId: Identifier
    exposureId: Uuid


class Explanation(WireModel):
    feature: str
    value: float | None
    contribution: float | None
    description: str


class Prediction(WireModel):
    modelKind: Literal["untrained", "heuristic", "logistic", "sgd_logistic", "tree"]
    modelVersion: NonEmptyString
    featureVersion: FeatureVersion
    trainedExamples: Count
    removalProbability: Probability | None
    heuristicScore: Probability | None
    uncertainty: Probability | None
    uncertaintyMethod: Literal["none", "entropy", "bootstrap"] | None
    calibrated: bool
    explanations: list[Explanation]

    @model_validator(mode="after")
    def heuristics_are_not_probabilities(self) -> Self:
        if self.modelKind in ("untrained", "heuristic") and (
            self.removalProbability is not None or self.calibrated
        ):
            raise ValueError("Baseline heuristics are not trained probabilities")
        return self


class ModelMetrics(WireModel):
    status: Literal["insufficient_data", "available", "unavailable"]
    reason: str | None
    modelVersion: NonEmptyString
    dataset: Literal["synthetic", "user_feedback", "licensed"]
    evaluationMethod: Literal["none", "fixed_holdout", "cross_validation", "heldout_simulation"]
    labeledExamples: Count
    trainedExamples: Count
    heldOutExamples: Count
    heldOutPositive: Count
    heldOutNegative: Count
    baseRate: Probability | None
    balancedAccuracy: Probability | None
    rocAuc: Probability | None
    prAuc: Probability | None
    logLoss: NonNegative | None
    brierScore: Probability | None
    precisionAtK: Probability | None
    evaluatedAt: Timestamp | None

    @model_validator(mode="after")
    def metrics_match_evaluation_evidence(self) -> Self:
        metrics = [self.baseRate, self.balancedAccuracy, self.rocAuc, self.prAuc,
                   self.logLoss, self.brierScore, self.precisionAtK]
        if self.status != "available" and any(value is not None for value in metrics):
            raise ValueError("Unavailable evaluation metrics must be null")
        if self.heldOutPositive + self.heldOutNegative != self.heldOutExamples:
            raise ValueError("Holdout class counts must sum to total")
        if (self.trainedExamples > self.labeledExamples
            or self.heldOutExamples > self.labeledExamples
            or (self.evaluationMethod == "fixed_holdout"
                and self.trainedExamples + self.heldOutExamples > self.labeledExamples)):
            raise ValueError("Training and holdout counts cannot exceed collected labels")
        if self.status == "available":
            if (self.heldOutExamples < 20 or self.heldOutPositive == 0
                or self.heldOutNegative == 0 or self.evaluationMethod == "none"
                or self.evaluatedAt is None):
                raise ValueError("Evaluation requires >=20 held-out examples, both classes, method and timestamp")
            if (any(value is None for value in metrics[:-1])
                or abs(self.baseRate - self.heldOutPositive / self.heldOutExamples) > 1e-6):
                raise ValueError("Available evaluation requires computed metrics and an accurate base rate")
        return self


class FitResponse(WireModel):
    userId: Identifier
    modelVersion: str
    featureVersion: FeatureVersion
    feedbackRevision: Count
    trainedExamples: Count
    metrics: ModelMetrics


class TrackPrediction(WireModel):
    trackId: Identifier
    prediction: Prediction


class ScoreResponse(WireModel):
    userId: Identifier
    modelVersion: str
    featureVersion: FeatureVersion
    predictions: list[TrackPrediction]


class ObserveResponse(WireModel):
    accepted: bool
    feedbackRevision: Count
    modelVersion: str | None


class ExplainResponse(WireModel):
    exposureId: Uuid
    prediction: Prediction


class MLCapabilities(WireModel):
    scoring: bool
    training: bool


class MLHealth(WireModel):
    status: Literal["ok"]
    service: Literal["ml"]
    contractVersion: Literal["1.0.0"]
    capabilities: MLCapabilities
