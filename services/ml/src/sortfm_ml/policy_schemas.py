"""C2-local API schemas; the frozen shared C1 schemas remain unchanged."""
from datetime import datetime
from typing import Annotated, Literal, Self

from pydantic import Field, model_validator

from .schemas import (BinaryLabel, Candidate, Count, FeatureVector, FeatureVersion, Identifier,
                      NonEmptyString, ObserveRequest, Prediction, Probability, SafeInteger,
                      Timestamp, Uuid, WireModel)


class PolicyConfig(WireModel):
    strategy: Literal["linucb", "epsilon_greedy", "c1", "random"] = "linucb"
    alpha: Annotated[float, Field(ge=0, le=10)] = .5
    ridge: Annotated[float, Field(ge=.001, le=1000)] = 1.
    epsilon: Probability = .1
    maxExplorationFraction: Probability = .25
    diversityWindow: Annotated[int, Field(ge=0, le=100)] = 5
    maxPerArtist: Annotated[int, Field(ge=1, le=100)] = 2
    obviousKeepThreshold: Probability = .1


class PolicyCandidate(Candidate):
    artistIds: Annotated[list[Identifier], Field(max_length=20)] = Field(default_factory=list)


class PolicySelectRequest(WireModel):
    userId: Identifier
    featureVersion: FeatureVersion
    exposureId: Uuid
    candidates: Annotated[list[PolicyCandidate], Field(min_length=1, max_length=10000)]
    modelVersion: str | None = None
    feedbackRevision: Count = Field(default=None)  # type: ignore[assignment]
    seed: SafeInteger = 42
    config: PolicyConfig = Field(default_factory=PolicyConfig)

    @model_validator(mode="after")
    def unique_tracks(self) -> Self:
        if len({row.trackId for row in self.candidates}) != len(self.candidates):
            raise ValueError("Candidate track identities must be unique")
        if self.feedbackRevision is not None and self.modelVersion is None:
            raise ValueError("A feedback revision requires a pinned model version")
        return self


class PolicyFeedbackRequest(ObserveRequest):
    usefulness: Probability | None = None

    @model_validator(mode="after")
    def no_skip_or_undo_rating(self) -> Self:
        if self.usefulness is not None and (self.label is None or self.operation == "revoke"):
            raise ValueError("Only a completed strong review has a usefulness rating")
        return self


class PolicyFitReceipt(WireModel):
    modelVersion: NonEmptyString
    synchronizedFeedbackRevision: Count


class PolicyAssociationEvent(WireModel):
    eventId: Uuid
    sequence: Annotated[Count, Field(ge=1)]
    source: Literal["cleanup"]
    decisionId: Uuid
    exposureId: Uuid
    trackId: Identifier
    policyVersion: NonEmptyString
    modelVersion: NonEmptyString
    operation: Literal["upsert", "revoke"]
    feedbackRevision: Count
    label: BinaryLabel | None
    features: FeatureVector
    occurredAt: Timestamp
    usefulness: Probability = Field(default=None)  # type: ignore[assignment]

    @model_validator(mode="after")
    def coherent_feedback(self) -> Self:
        if self.operation == "revoke" and self.label is not None:
            raise ValueError("Revocation removes the original decision")
        if self.usefulness is not None and (self.operation == "revoke" or self.label is None):
            raise ValueError("Only a completed strong review has a usefulness rating")
        return self


class PolicyAssociateRequest(WireModel):
    userId: Identifier
    event: PolicyAssociationEvent
    fitReceipt: PolicyFitReceipt

    @model_validator(mode="after")
    def receipt_covers_event(self) -> Self:
        if self.fitReceipt.synchronizedFeedbackRevision < self.event.feedbackRevision:
            raise ValueError("The C1 fit receipt must cover the committed event revision")
        return self


class PolicyAssociateResponse(WireModel):
    userId: Identifier
    eventId: Uuid
    sequence: Annotated[Count, Field(ge=1)]
    recordedAt: Timestamp
    duplicate: bool
    fitReceipt: PolicyFitReceipt
    eligibleForLearning: bool


class PolicyAssociationRecord(WireModel):
    """Private durable acceptance evidence; retries do not rewrite this receipt."""
    event: PolicyAssociationEvent
    fingerprint: Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
    recordedAt: Timestamp
    fitReceipt: PolicyFitReceipt
    fitFingerprint: Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]


class PolicySelection(WireModel):
    index: Count
    trackId: Identifier
    strategy: Literal["explore", "exploit"]
    selectionMethod: Literal["linucb", "epsilon_greedy", "c1", "random"]
    predictedReward: float
    baselineScore: Probability
    selectionScore: float
    uncertainty: Annotated[float, Field(ge=0)]
    explorationBonus: Annotated[float, Field(ge=0)]
    informationGain: Annotated[float, Field(ge=0)]
    propensityEstimate: Probability | None
    greedyTrackId: Identifier
    eligibleCount: Count
    explorationAllowed: bool
    reasons: list[str]
    context: list[float]


class PolicyDecision(WireModel):
    userId: Identifier
    exposureId: Uuid
    trackId: Identifier
    candidate: PolicyCandidate
    prediction: Prediction
    modelVersion: str
    feedbackRevision: Count | None = None
    featureVersion: FeatureVersion
    policyVersion: str
    policyStateVersion: str
    contextVersion: str
    rewardVersion: str
    seed: SafeInteger
    step: Count
    config: PolicyConfig
    selection: PolicySelection
    candidateSetHash: str
    candidateTrackIds: list[Identifier]
    candidateCount: Count
    availableCount: Count
    contextNames: list[str]
    trainedRewards: Count
    rankedTrackIds: list[Identifier] | None
    createdAt: str


class PolicyDiagnosticsQuery(WireModel):
    userId: Identifier


class PolicyExposureQuery(WireModel):
    userId: Identifier
    exposureId: Uuid


class PolicyReleaseRequest(WireModel):
    userId: Identifier
    requestId: Uuid
    exposureId: Uuid
    reason: Literal["skip", "abandoned", "prefetch_discarded"]


class PolicyReleaseReceipt(WireModel):
    userId: Identifier
    requestId: Uuid
    exposureId: Uuid
    trackId: Identifier
    outcome: Literal["released", "already_closed"]
    recordedAt: Timestamp
    expiresAt: Timestamp
    effectiveClosedAt: Timestamp


class PolicyReservation(WireModel):
    exposureId: Uuid
    reservedAt: Timestamp
    expiresAt: Timestamp
    status: Literal["active", "released", "expired"]
    closedAt: Timestamp | None
    closureReason: Literal["explicit_release", "undo", "skip", "expiry"] | None

    @model_validator(mode="after")
    def coherent_lifecycle(self) -> Self:
        reserved, expires = datetime.fromisoformat(self.reservedAt), datetime.fromisoformat(self.expiresAt)
        if not 30 <= (expires - reserved).total_seconds() <= 900:
            raise ValueError("Reservation duration must be bounded")
        if self.status == "active":
            if self.closedAt is not None or self.closureReason is not None:
                raise ValueError("Active reservations cannot be closed")
        elif self.status == "expired":
            if self.closedAt != self.expiresAt or self.closureReason != "expiry":
                raise ValueError("Expiry closes at the original deadline")
        elif (self.closedAt is None or self.closureReason not in ("explicit_release", "undo", "skip")
              or datetime.fromisoformat(self.closedAt) > expires):
            raise ValueError("Released reservations require a valid terminal closure")
        return self


class PolicyReservationInspection(PolicyReservation):
    evaluatedAt: Timestamp


class PolicyEligibilityExclusion(WireModel):
    trackId: Identifier
    blockingExposureIds: list[Uuid]
    completedReview: bool


class PolicyEligibility(WireModel):
    evaluatedAt: Timestamp
    filteringApplied: bool
    exclusions: list[PolicyEligibilityExclusion]


class PolicyDiagnostics(WireModel):
    userId: Identifier
    policyVersion: str
    rewardVersion: str
    modelVersion: str
    latestDecision: PolicyDecision | None
    counts: dict[str, Count]
    labelDistribution: dict[str, Count]
    rewardSummary: dict[str, float | None]
    caveats: list[str]


class PolicyExposure(WireModel):
    decision: PolicyDecision
    feedback: list[dict]
    reservation: PolicyReservationInspection
    eligibility: PolicyEligibility | None
