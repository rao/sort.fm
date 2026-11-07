"""C2 policy adapter over C1's immutable models and authoritative label ledger.

Selection reservations are durable before returning. Feedback intents are saved
before C1 observes them; only matching committed C1 events can contribute. This
small outbox avoids claiming a distributed transaction across two artifact files.
An interrupted request is completed by retrying the same event/exposure ID.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
from typing import Callable

import numpy as np

from .bandit import CONTEXT_VERSION, LinearUCB, build_context, context_names, select_candidate
from .policy_schemas import (PolicyDecision, PolicyEligibility, PolicyReleaseReceipt,
                             PolicyReleaseRequest, PolicyReservation, PolicySelectRequest)
from .schemas import FeatureVector, ObserveRequest
from .service import FEATURE_VERSION, ModelService, ServiceError, atomic_bytes, canonical, digest

POLICY_VERSION = "c2-linucb-v2"
LEGACY_POLICY_VERSION = "c2-linucb-v1"
STORAGE_VERSION = 2
LEGACY_TTL_SECONDS = 300
REWARD_VERSION = "review-utility-v1"
CAVEATS = [
    "Review utility is separate from removal prediction accuracy; neither is RL accuracy.",
    "Default usefulness is a completed-review proxy, not an explicit user satisfaction rating.",
    "Correction surprise is squared frozen prediction error, not measured information gain.",
    "Information gain is linear-design log-determinant growth with unit noise, not proven preference learning.",
    "Linear uncertainty is an uncalibrated design radius, not a confidence interval or C1 predictive entropy.",
    "Adaptive contexts, constraints and non-linear rewards do not carry a formal LinUCB regret guarantee.",
    "Selected feedback is biased; no off-policy uplift or real-listener utility is established.",
    "An exposure is a reserved selection, not proof that the song was viewed.",
    "Lease expiry/release is not mutation cancellation or backend review eligibility.",
    "Fit snapshots alone cannot establish committed C2 feedback or rewards.",
]


def review_reward(label: int, prediction: dict, usefulness: float | None = None) -> dict:
    """Bounded reward; a surprising KEEP can be as valuable as a removal."""
    if type(label) is not int or label not in (0, 1):
        raise ValueError("A reward requires a completed binary review")
    if usefulness is not None and (isinstance(usefulness, bool) or not isinstance(usefulness, (int, float))
                                   or not np.isfinite(usefulness) or not 0 <= usefulness <= 1):
        raise ValueError("Usefulness must lie in [0,1]")
    value = 1. if usefulness is None else float(usefulness)
    probability = prediction["removalProbability"]
    correction = 0. if probability is None else (label - probability) ** 2
    return {"reward": .75 * value + .25 * correction, "usefulness": value,
            "usefulnessSource": "completed_review_proxy" if usefulness is None else "explicit",
            "correctionProxy": correction, "rewardVersion": REWARD_VERSION}


class PolicyService:
    def __init__(self, models: ModelService, *, clock: Callable[[], datetime] | None = None,
                 reservation_ttl_seconds: int = 300):
        if type(reservation_ttl_seconds) is not int or not 30 <= reservation_ttl_seconds <= 900:
            raise ValueError("Policy reservation TTL must be an integer from 30 through 900 seconds")
        self.models = models
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.reservation_ttl_seconds = reservation_ttl_seconds

    def _now(self) -> datetime:
        value = self.clock()
        if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("Policy clock must return an aware datetime")
        return value.astimezone(timezone.utc)

    @staticmethod
    def _reservation(exposure_id: str, reserved_at: str, ttl: int) -> dict:
        row = {"exposureId": exposure_id, "reservedAt": reserved_at,
               "expiresAt": (datetime.fromisoformat(reserved_at) + timedelta(seconds=ttl)).isoformat(),
               "status": "active", "closedAt": None, "closureReason": None}
        return PolicyReservation.model_validate(row).model_dump()

    def _read(self, folder: Path, user_id: str) -> dict:
        path = folder / "policy.json"
        if not path.exists():
            if any(row.get("policyVersion") for row in self.models._read_exposures(folder).values()):
                raise ServiceError(503, "POLICY_STATE_UNAVAILABLE", "Policy ledger is missing; restore a verified backup.")
            return {"userId": user_id, "version": POLICY_VERSION, "schemaVersion": STORAGE_VERSION,
                    "decisions": {}, "events": {}, "reservations": {}, "releaseRequests": {}}
        try:
            envelope = json.loads(path.read_text())
            state = envelope["state"]
            legacy = "schemaVersion" not in state and state.get("version") == LEGACY_POLICY_VERSION
            expected_keys = {"userId", "version", "decisions", "events"}
            if not legacy:
                expected_keys |= {"schemaVersion", "reservations", "releaseRequests"}
            if (digest(state) != envelope["sha256"] or state["userId"] != user_id
                or set(state) != expected_keys or (not legacy and (
                    type(state["schemaVersion"]) is not int or state["schemaVersion"] != STORAGE_VERSION
                    or state["version"] != POLICY_VERSION))):
                raise ValueError("Policy integrity/version mismatch")
            if not isinstance(state["events"], dict) or not isinstance(state["decisions"], dict):
                raise ValueError("Invalid ledgers")
            for exposure, entry in state["decisions"].items():
                decision = PolicyDecision.model_validate(entry["response"])
                if (decision.exposureId != exposure or decision.userId != user_id
                    or decision.policyVersion not in (LEGACY_POLICY_VERSION, POLICY_VERSION)
                    or not isinstance(entry["fingerprint"], str)):
                    raise ValueError("Invalid selection identity")
                if legacy and (set(entry) != {"fingerprint", "response"} or decision.policyVersion != LEGACY_POLICY_VERSION):
                    raise ValueError("Invalid legacy decision")
                if not legacy:
                    expected_entry_keys = {"fingerprint", "response"}
                    if decision.policyVersion == POLICY_VERSION:
                        expected_entry_keys.add("eligibility")
                        snapshot = PolicyEligibility.model_validate(entry["eligibility"])
                        excluded_tracks = [row.trackId for row in snapshot.exclusions]
                        filtering = decision.config.strategy != "c1"
                        if (snapshot.evaluatedAt != decision.createdAt or snapshot.filteringApplied != filtering
                            or len(set(excluded_tracks)) != len(excluded_tracks)
                            or not set(excluded_tracks).issubset(decision.candidateTrackIds)
                            or (filtering and decision.trackId in excluded_tracks)
                            or decision.availableCount != decision.candidateCount - (len(excluded_tracks) if filtering else 0)):
                            raise ValueError("Invalid eligibility snapshot")
                        for exclusion in snapshot.exclusions:
                            blockers = exclusion.blockingExposureIds
                            if len(blockers) != len(set(blockers)) or (not blockers and not exclusion.completedReview):
                                raise ValueError("Invalid eligibility exclusion")
                            for blocker in blockers:
                                prior = state["decisions"][blocker]["response"]
                                if prior["trackId"] != exclusion.trackId or prior["step"] >= decision.step:
                                    raise ValueError("Invalid blocking exposure reference")
                    if set(entry) != expected_entry_keys:
                        raise ValueError("Invalid decision metadata")
            for event_id, entry in state["events"].items():
                event = ObserveRequest.model_validate(entry["request"])
                if (event.eventId != event_id or event.userId != user_id or event.exposureId not in state["decisions"]
                    or digest(entry["request"]) != entry["fingerprint"]):
                    raise ValueError("Invalid feedback identity")
                if event.label is not None:
                    review_reward(event.label, state["decisions"][event.exposureId]["response"]["prediction"], entry["usefulness"])
            if not legacy:
                if (not isinstance(state["reservations"], dict) or not isinstance(state["releaseRequests"], dict)
                    or set(state["reservations"]) != set(state["decisions"])):
                    raise ValueError("Reservations must cover every decision exactly")
                for exposure, entry in state["reservations"].items():
                    lease = PolicyReservation.model_validate(entry)
                    if lease.exposureId != exposure or lease.reservedAt != state["decisions"][exposure]["response"]["createdAt"]:
                        raise ValueError("Invalid reservation identity")
                primary_receipts = {}
                for request_id, entry in state["releaseRequests"].items():
                    request = PolicyReleaseRequest.model_validate(entry["request"])
                    receipt = PolicyReleaseReceipt.model_validate(entry["response"])
                    lease = state["reservations"][request.exposureId]
                    decision = state["decisions"][request.exposureId]["response"]
                    if (set(entry) != {"request", "fingerprint", "response"}
                        or digest(entry["request"]) != entry["fingerprint"]
                        or request.userId != user_id or receipt.userId != user_id
                        or request.requestId != request_id or receipt.requestId != request_id
                        or request.exposureId != receipt.exposureId or decision["trackId"] != receipt.trackId
                        or receipt.expiresAt != lease["expiresAt"] or receipt.effectiveClosedAt != lease["closedAt"]
                        or lease["status"] == "active"
                        or (receipt.outcome == "released" and (
                            lease["closureReason"] != "explicit_release" or receipt.recordedAt != lease["closedAt"]))):
                        raise ValueError("Invalid release receipt")
                    if receipt.outcome == "released":
                        primary_receipts[request.exposureId] = primary_receipts.get(request.exposureId, 0) + 1
                for exposure, lease in state["reservations"].items():
                    if primary_receipts.get(exposure, 0) != int(lease["closureReason"] == "explicit_release"):
                        raise ValueError("Explicit closure must have exactly one durable primary receipt")
            return state
        except (ValueError, TypeError, KeyError, OverflowError, AttributeError) as error:
            raise ServiceError(503, "POLICY_STATE_UNAVAILABLE", "Policy ledger is invalid; restore a verified backup.") from error

    def _reconciled_state(self, folder: Path, user_id: str, current: dict, now: datetime) -> tuple[dict, bool]:
        """Reconcile under the C1 user lock; caller must persist observed transitions."""
        state = self._read(folder, user_id)
        changed = "schemaVersion" not in state
        if changed:
            try:
                reservations = {key: self._reservation(key, entry["response"]["createdAt"], LEGACY_TTL_SECONDS)
                                for key, entry in state["decisions"].items()}
            except (ValueError, TypeError, OverflowError) as error:
                raise ServiceError(503, "POLICY_STATE_UNAVAILABLE", "Legacy reservation timestamps are invalid.") from error
            state.update(schemaVersion=STORAGE_VERSION, version=POLICY_VERSION,
                         reservations=reservations, releaseRequests={})
        latest = {}
        for row in sorted(self._feedback(state, current), key=lambda row: row["feedbackRevision"]):
            if row["committed"]:
                latest[row["exposureId"]] = row
        for exposure, lease in state["reservations"].items():
            if lease["status"] != "active":
                continue
            row = latest.get(exposure)
            if now >= datetime.fromisoformat(lease["expiresAt"]):
                lease.update(status="expired", closedAt=lease["expiresAt"], closureReason="expiry")
                changed = True
            elif row and row["operation"] == "revoke" and row["trackId"] not in current["state"]["examples"]:
                lease.update(status="released", closedAt=now.isoformat(), closureReason="undo")
                changed = True
        return state, changed

    def _load_state(self, folder: Path, user_id: str, current: dict, now: datetime) -> dict:
        state, changed = self._reconciled_state(folder, user_id, current, now)
        if changed:
            self._write(folder, state)
        return state

    @staticmethod
    def _eligibility(state: dict, current: dict, feedback: list[dict], candidates: list[dict],
                     now: datetime, *, filtering: bool) -> dict:
        completed = {row["trackId"] for row in feedback if row["committed"] and row["operation"] == "upsert"
                     and row["label"] is not None and row["trackId"] in current["state"]["examples"]}
        live = {}
        for exposure, lease in state["reservations"].items():
            if lease["status"] == "active":
                track = state["decisions"][exposure]["response"]["trackId"]
                live.setdefault(track, []).append(exposure)
        return {"evaluatedAt": now.isoformat(), "filteringApplied": filtering,
                "exclusions": [{"trackId": row["trackId"], "blockingExposureIds": sorted(live.get(row["trackId"], [])),
                                "completedReview": row["trackId"] in completed}
                               for row in candidates if row["trackId"] in live or row["trackId"] in completed]}

    @staticmethod
    def _write(folder: Path, state: dict) -> None:
        atomic_bytes(folder / "policy.json", canonical({"state": state, "sha256": digest(state)}))

    def _ensure_prediction(self, folder: Path, decision: dict) -> None:
        """Idempotently complete the second half of a selection reservation."""
        exposures = self.models._read_exposures(folder)
        candidate = decision["candidate"]
        saved = {"trackId": candidate["trackId"], "modelVersion": decision["modelVersion"],
                 "prediction": deepcopy(decision["prediction"]),
                 "fingerprint": digest({"trackId": candidate["trackId"], "features": candidate["features"]}),
                 "policyVersion": decision["policyVersion"]}
        exposure_id = decision["exposureId"]
        if exposure_id in exposures:
            if exposures[exposure_id] != saved:
                raise ServiceError(409, "EXPOSURE_CONFLICT", "A policy exposure must preserve its original prediction.")
        else:
            exposures[exposure_id] = saved
            atomic_bytes(folder / "exposures.json", canonical(exposures))

    @staticmethod
    def _feedback(state: dict, bundle: dict) -> list[dict]:
        """Describe both pending intents and confirmed, currently active labels."""
        ledger = bundle["state"]
        results = []
        for event_id, entry in state["events"].items():
            event = entry["request"]
            committed = ledger["events"].get(event_id, {}).get("fingerprint") == entry["fingerprint"]
            active = ledger["examples"].get(event["trackId"])
            matches = bool(committed and event["operation"] == "upsert" and event["label"] is not None
                           and active and active["decisionId"] == event["decisionId"]
                           and active["label"] == event["label"]
                           and FeatureVector.model_validate(active["features"]).model_dump() ==
                           FeatureVector.model_validate(event["features"]).model_dump())
            decision = state["decisions"][event["exposureId"]]["response"]
            result = {"eventId": event_id, **deepcopy(event), "committed": committed,
                      "active": matches, "eligibleForLearning": bool(matches and active["split"] == "train"),
                      "split": active["split"] if matches else None,
                      "reward": review_reward(event["label"], decision["prediction"], entry["usefulness"])
                      if event["operation"] == "upsert" and event["label"] is not None else None}
            results.append(result)
        # Reaffirming the same decision is never a second reward observation.
        latest = {}
        for row in sorted(results, key=lambda row: row["feedbackRevision"]):
            if row["active"]:
                latest[row["decisionId"]] = row["eventId"]
        for row in results:
            if row["active"] and latest[row["decisionId"]] != row["eventId"]:
                row.update(active=False, eligibleForLearning=False)
        return results

    @staticmethod
    def _learner(bundle: dict, feedback: list[dict], config: dict) -> LinearUCB:
        model = bundle["model"]
        active = sorted((row for row in feedback if row["eligibleForLearning"]), key=lambda row: row["decisionId"])
        candidates = [{"trackId": row["trackId"], "features": row["features"]} for row in active]
        contexts = build_context(model, candidates, model.predict(candidates, bundle["version"]))
        return LinearUCB(len(context_names(model)), alpha=config["alpha"], ridge=config["ridge"]).fit(
            contexts, np.array([row["reward"]["reward"] for row in active]))

    def select(self, payload: dict) -> dict:
        parsed = PolicySelectRequest.model_validate(payload)
        payload = parsed.model_dump(exclude_unset=True)
        payload.update(config=parsed.config.model_dump(), modelVersion=parsed.modelVersion, seed=parsed.seed)
        for candidate in payload["candidates"]:
            candidate.setdefault("artistIds", [])
        # Order is irrelevant for an action set and must not change retry identity.
        payload["candidates"].sort(key=lambda row: row["trackId"])
        fingerprint = digest(payload)
        with self.models._locked(payload["userId"]) as folder:
            # Initialize C1 before creating any extra JSON artifact in its folder.
            current = self.models._load(folder, payload["userId"])
            now = self._now()
            state = self._load_state(folder, payload["userId"], current, now)
            existing = state["decisions"].get(payload["exposureId"])
            if existing:
                if existing["fingerprint"] != fingerprint:
                    raise ServiceError(409, "EXPOSURE_CONFLICT", "Selection inputs are immutable for an exposure ID.")
                self._ensure_prediction(folder, existing["response"])
                return deepcopy(existing["response"])
            if payload["exposureId"] in self.models._read_exposures(folder):
                raise ServiceError(409, "EXPOSURE_CONFLICT", "Exposure ID is already registered by another scorer.")
            bundle = current if payload["modelVersion"] is None else self.models._load(folder, payload["userId"], payload["modelVersion"])
            # Current active decisions govern Undo even when scoring an old model.
            feedback = self._feedback(state, current)
            config = payload["config"]
            learner = self._learner(bundle, feedback, config)
            history = [entry["response"] for entry in sorted(state["decisions"].values(), key=lambda entry: entry["response"]["step"])]
            eligibility = self._eligibility(state, current, feedback, payload["candidates"], now,
                                            filtering=config["strategy"] != "c1")
            excluded = {row["trackId"] for row in eligibility["exclusions"]}
            candidates = [row for row in payload["candidates"] if config["strategy"] == "c1" or row["trackId"] not in excluded]
            if not candidates:
                raise ServiceError(409, "NO_ELIGIBLE_CANDIDATES", "All supplied songs have a live reservation or completed review.")
            model = bundle["model"]
            predictions = model.predict(candidates, bundle["version"])
            contexts = build_context(model, candidates, predictions)
            fallback = []
            if config["strategy"] == "c1" or learner.n_observations == 0:
                limit = len(candidates) if config["strategy"] == "c1" else 1
                fallback = [row["trackId"] for row in model.rank(candidates, bundle["version"], limit=limit)]
            simplified = [{"trackId": row["trackId"], "artistIds": row["candidate"]["artistIds"],
                           "strategy": row["selection"]["strategy"]} for row in history]
            chosen = select_candidate(candidates, predictions, contexts, learner, seed=payload["seed"],
                                      step=len(history), config=config, history=simplified, fallback_order=fallback)
            index = chosen["index"]
            active_identity = [{"eventId": row["eventId"], "reward": row["reward"]} for row in feedback if row["eligibleForLearning"]]
            response = {"userId": payload["userId"], "exposureId": payload["exposureId"], "trackId": candidates[index]["trackId"],
                        "candidate": candidates[index], "prediction": predictions[index]["prediction"],
                        "modelVersion": bundle["version"], "featureVersion": FEATURE_VERSION,
                        "policyVersion": POLICY_VERSION, "policyStateVersion": "c2-" + digest({
                            "model": bundle["version"], "feedback": active_identity, "history": simplified,
                            "config": config, "eligibility": eligibility})[:24],
                        "contextVersion": CONTEXT_VERSION, "contextNames": list(context_names(model)), "rewardVersion": REWARD_VERSION,
                        "seed": payload["seed"], "step": len(history), "config": config, "selection": chosen,
                        "candidateSetHash": digest(payload["candidates"]), "candidateTrackIds": [row["trackId"] for row in payload["candidates"]],
                        "candidateCount": len(payload["candidates"]), "availableCount": len(candidates),
                        "trainedRewards": learner.n_observations, "rankedTrackIds": fallback if config["strategy"] == "c1" else None,
                        "createdAt": now.isoformat()}
            response = PolicyDecision.model_validate(response).model_dump(exclude_unset=True)
            state["decisions"][payload["exposureId"]] = {"fingerprint": fingerprint, "response": response, "eligibility": eligibility}
            state["reservations"][payload["exposureId"]] = self._reservation(
                payload["exposureId"], now.isoformat(), self.reservation_ttl_seconds)
            self._write(folder, state)
            self._ensure_prediction(folder, response)
            return deepcopy(response)

    def release(self, payload: dict) -> dict:
        """Close one scheduling lease and commit its immutable receipt atomically."""
        payload = PolicyReleaseRequest.model_validate(payload).model_dump()
        fingerprint = digest(payload)
        with self.models._locked(payload["userId"]) as folder:
            current = self.models._load(folder, payload["userId"])
            now = self._now()
            state, changed = self._reconciled_state(folder, payload["userId"], current, now)
            previous = state["releaseRequests"].get(payload["requestId"])
            decision = state["decisions"].get(payload["exposureId"])
            # Replay/error responses still persist any observed terminal expiry.
            # A fresh success instead commits reconciliation, closure and receipt
            # together below, with no intermediate policy write.
            if changed and (previous or decision is None):
                self._write(folder, state)
            if previous:
                if previous["fingerprint"] != fingerprint:
                    raise ServiceError(409, "IDEMPOTENCY_CONFLICT", "Release request contents are immutable.")
                return deepcopy(previous["response"])
            if decision is None:
                raise ServiceError(404, "POLICY_EXPOSURE_NOT_FOUND", "No policy selection exists for this user and exposure.")
            lease = state["reservations"][payload["exposureId"]]
            outcome = "already_closed"
            if lease["status"] == "active":
                lease.update(status="released", closedAt=now.isoformat(), closureReason="explicit_release")
                outcome = "released"
            receipt = PolicyReleaseReceipt.model_validate({
                "userId": payload["userId"], "requestId": payload["requestId"], "exposureId": payload["exposureId"],
                "trackId": decision["response"]["trackId"], "outcome": outcome,
                "recordedAt": now.isoformat(), "expiresAt": lease["expiresAt"], "effectiveClosedAt": lease["closedAt"]}).model_dump()
            state["releaseRequests"][payload["requestId"]] = {"request": payload, "fingerprint": fingerprint, "response": receipt}
            self._write(folder, state)
            return deepcopy(receipt)

    def observe(self, payload: dict, usefulness: float | None = None, *, require_policy: bool = False) -> dict:
        """Preserve the C1 ObserveResponse; rating is a separate C2-local input."""
        policy_event = False
        with self.models._locked(payload["userId"]) as folder:
            current = self.models._load(folder, payload["userId"])
            registered = self.models._read_exposures(folder).get(payload["exposureId"], {})
            # Existing C1 observations do not depend on C2 ledger availability.
            state = self._load_state(folder, payload["userId"], current, self._now()) if require_policy or registered.get("policyVersion") else None
            decision = state["decisions"].get(payload["exposureId"]) if state else None
            if decision is None and require_policy:
                raise ServiceError(404, "POLICY_EXPOSURE_NOT_FOUND", "No policy selection exists for this user and exposure.")
            if decision is not None:
                policy_event = True
                candidate = decision["response"]["candidate"]
                # Pydantic default expansion must not make an omitted null feature
                # differ between the C1 request and the C2 frozen candidate.
                if (payload["trackId"] != candidate["trackId"] or
                    FeatureVector.model_validate(payload["features"]).model_dump() !=
                    FeatureVector.model_validate(candidate["features"]).model_dump()):
                    raise ServiceError(409, "EXPOSURE_CONFLICT", "Feedback must match the selected song and frozen features.")
                fingerprint = digest(payload)
                existing = state["events"].get(payload["eventId"])
                if existing:
                    if existing["fingerprint"] != fingerprint or (require_policy and existing["usefulness"] != usefulness):
                        raise ServiceError(409, "IDEMPOTENCY_CONFLICT", "Policy feedback event contents are immutable.")
                else:
                    if payload["label"] is not None:
                        review_reward(payload["label"], decision["response"]["prediction"], usefulness)
                    state["events"][payload["eventId"]] = {"request": deepcopy(payload), "fingerprint": fingerprint, "usefulness": usefulness}
                    self._write(folder, state)
        # Never nest ModelService locks. The intent is inert until C1 commits
        # this exact event fingerprint, including after process interruption.
        try:
            return self.models.observe(payload)
        except ServiceError as error:
            if policy_event and 400 <= error.status < 500:
                # An authoritative rejection is no longer pending. Preserve
                # intents on transient/unknown outcomes, including crashes.
                with self.models._locked(payload["userId"]) as folder:
                    bundle = self.models._load(folder, payload["userId"])
                    state = self._load_state(folder, payload["userId"], bundle, self._now())
                    entry = state["events"].get(payload["eventId"])
                    committed = bundle["state"]["events"].get(payload["eventId"], {})
                    if entry and entry["fingerprint"] == digest(payload) and committed.get("fingerprint") != entry["fingerprint"]:
                        del state["events"][payload["eventId"]]
                        self._write(folder, state)
            raise

    def diagnostics(self, user_id: str) -> dict:
        with self.models._locked(user_id) as folder:
            bundle = self.models._load(folder, user_id)
            state = self._load_state(folder, user_id, bundle, self._now())
            feedback = self._feedback(state, bundle)
            active = [row for row in feedback if row["eligibleForLearning"]]
            decisions = [entry["response"] for entry in state["decisions"].values()]
            rewards = [row["reward"]["reward"] for row in active]
            return {"userId": user_id, "policyVersion": POLICY_VERSION, "rewardVersion": REWARD_VERSION,
                    "modelVersion": bundle["version"], "latestDecision": max(decisions, key=lambda row: row["step"]) if decisions else None,
                    "counts": {"exposures": len(decisions), "feedbackEvents": len(feedback),
                               "committedEvents": sum(row["committed"] for row in feedback),
                               "pendingEvents": sum(not row["committed"] for row in feedback),
                               "activeReservations": sum(row["status"] == "active" for row in state["reservations"].values()),
                               "closedReservations": sum(row["status"] != "active" for row in state["reservations"].values()),
                               "releaseRequests": len(state["releaseRequests"]),
                               "activeRewards": len(active), "holdoutExcluded": sum(row["active"] and row["split"] == "holdout" for row in feedback),
                               "skips": sum(row["committed"] and row["operation"] == "upsert" and row["label"] is None for row in feedback),
                               "explorations": sum(row["selection"]["strategy"] == "explore" for row in decisions),
                               "explicitUsefulRatings": sum(row["reward"]["usefulnessSource"] == "explicit" for row in active)},
                    "labelDistribution": {"keep": sum(row["label"] == 0 for row in active), "remove": sum(row["label"] == 1 for row in active)},
                    "rewardSummary": {"sum": sum(rewards), "mean": float(np.mean(rewards)) if rewards else None},
                    "caveats": CAVEATS}

    def exposure(self, user_id: str, exposure_id: str) -> dict:
        with self.models._locked(user_id) as folder:
            bundle = self.models._load(folder, user_id)
            now = self._now()
            state = self._load_state(folder, user_id, bundle, now)
            if exposure_id not in state["decisions"]:
                raise ServiceError(404, "POLICY_EXPOSURE_NOT_FOUND", "No policy selection exists for this user and exposure.")
            return {"decision": deepcopy(state["decisions"][exposure_id]["response"]),
                    "reservation": {**deepcopy(state["reservations"][exposure_id]), "evaluatedAt": now.isoformat()},
                    "eligibility": deepcopy(state["decisions"][exposure_id].get("eligibility")),
                    "feedback": [row for row in self._feedback(state, bundle) if row["exposureId"] == exposure_id]}
