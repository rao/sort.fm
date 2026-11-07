"""C2 policy adapter over C1's immutable models and authoritative label ledger.

Selection reservations are durable before returning. Feedback intents are saved
before C1 observes them; only matching committed C1 events can contribute. This
small outbox avoids claiming a distributed transaction across two artifact files.
An interrupted request is completed by retrying the same event/exposure ID.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import json
from pathlib import Path

import numpy as np

from .bandit import CONTEXT_VERSION, LinearUCB, build_context, context_names, select_candidate
from .policy_schemas import PolicyDecision, PolicySelectRequest
from .schemas import FeatureVector, ObserveRequest
from .service import FEATURE_VERSION, ModelService, ServiceError, atomic_bytes, canonical, digest

POLICY_VERSION = "c2-linucb-v1"
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
    def __init__(self, models: ModelService):
        self.models = models

    def _read(self, folder: Path, user_id: str) -> dict:
        path = folder / "policy.json"
        if not path.exists():
            if any(row.get("policyVersion") for row in self.models._read_exposures(folder).values()):
                raise ServiceError(503, "POLICY_STATE_UNAVAILABLE", "Policy ledger is missing; restore a verified backup.")
            return {"userId": user_id, "version": POLICY_VERSION, "decisions": {}, "events": {}}
        try:
            envelope = json.loads(path.read_text())
            state = envelope["state"]
            if digest(state) != envelope["sha256"] or state["userId"] != user_id or state["version"] != POLICY_VERSION:
                raise ValueError("Policy integrity/version mismatch")
            if not isinstance(state["events"], dict) or not isinstance(state["decisions"], dict):
                raise ValueError("Invalid ledgers")
            for exposure, entry in state["decisions"].items():
                decision = PolicyDecision.model_validate(entry["response"])
                if decision.exposureId != exposure or decision.userId != user_id or not isinstance(entry["fingerprint"], str):
                    raise ValueError("Invalid selection identity")
            for event_id, entry in state["events"].items():
                event = ObserveRequest.model_validate(entry["request"])
                if (event.eventId != event_id or event.userId != user_id or event.exposureId not in state["decisions"]
                    or digest(entry["request"]) != entry["fingerprint"]):
                    raise ValueError("Invalid feedback identity")
                if event.label is not None:
                    review_reward(event.label, state["decisions"][event.exposureId]["response"]["prediction"], entry["usefulness"])
            return state
        except (ValueError, TypeError, KeyError) as error:
            raise ServiceError(503, "POLICY_STATE_UNAVAILABLE", "Policy ledger is invalid; restore a verified backup.") from error

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
                 "policyVersion": POLICY_VERSION}
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
            state = self._read(folder, payload["userId"])
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
            last_feedback = {}
            for row in sorted(feedback, key=lambda row: row["feedbackRevision"]):
                if row["committed"]:
                    last_feedback[row["exposureId"]] = row
            revoked = {exposure for exposure, row in last_feedback.items() if row["operation"] == "revoke"
                       and row["trackId"] not in current["state"]["examples"]}
            seen = {row["trackId"] for row in history if row["exposureId"] not in revoked}
            candidates = [row for row in payload["candidates"] if config["strategy"] == "c1" or row["trackId"] not in seen]
            if not candidates:
                raise ServiceError(409, "NO_ELIGIBLE_CANDIDATES", "All supplied songs have an existing policy reservation.")
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
                            "model": bundle["version"], "feedback": active_identity, "history": simplified, "config": config})[:24],
                        "contextVersion": CONTEXT_VERSION, "contextNames": list(context_names(model)), "rewardVersion": REWARD_VERSION,
                        "seed": payload["seed"], "step": len(history), "config": config, "selection": chosen,
                        "candidateSetHash": digest(payload["candidates"]), "candidateTrackIds": [row["trackId"] for row in payload["candidates"]],
                        "candidateCount": len(payload["candidates"]), "availableCount": len(candidates),
                        "trainedRewards": learner.n_observations, "rankedTrackIds": fallback if config["strategy"] == "c1" else None,
                        "createdAt": datetime.now(timezone.utc).isoformat()}
            response = PolicyDecision.model_validate(response).model_dump(exclude_unset=True)
            state["decisions"][payload["exposureId"]] = {"fingerprint": fingerprint, "response": response}
            self._write(folder, state)
            self._ensure_prediction(folder, response)
            return deepcopy(response)

    def observe(self, payload: dict, usefulness: float | None = None, *, require_policy: bool = False) -> dict:
        """Preserve the C1 ObserveResponse; rating is a separate C2-local input."""
        policy_event = False
        with self.models._locked(payload["userId"]) as folder:
            self.models._load(folder, payload["userId"])
            registered = self.models._read_exposures(folder).get(payload["exposureId"], {})
            # Existing C1 observations do not depend on C2 ledger availability.
            state = self._read(folder, payload["userId"]) if require_policy or registered.get("policyVersion") else None
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
                    state = self._read(folder, payload["userId"])
                    entry = state["events"].get(payload["eventId"])
                    committed = bundle["state"]["events"].get(payload["eventId"], {})
                    if entry and entry["fingerprint"] == digest(payload) and committed.get("fingerprint") != entry["fingerprint"]:
                        del state["events"][payload["eventId"]]
                        self._write(folder, state)
            raise

    def diagnostics(self, user_id: str) -> dict:
        with self.models._locked(user_id) as folder:
            bundle = self.models._load(folder, user_id)
            state = self._read(folder, user_id)
            feedback = self._feedback(state, bundle)
            active = [row for row in feedback if row["eligibleForLearning"]]
            decisions = [entry["response"] for entry in state["decisions"].values()]
            rewards = [row["reward"]["reward"] for row in active]
            return {"userId": user_id, "policyVersion": POLICY_VERSION, "rewardVersion": REWARD_VERSION,
                    "modelVersion": bundle["version"], "latestDecision": max(decisions, key=lambda row: row["step"]) if decisions else None,
                    "counts": {"exposures": len(decisions), "feedbackEvents": len(feedback),
                               "committedEvents": sum(row["committed"] for row in feedback),
                               "pendingEvents": sum(not row["committed"] for row in feedback),
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
            state = self._read(folder, user_id)
            if exposure_id not in state["decisions"]:
                raise ServiceError(404, "POLICY_EXPOSURE_NOT_FOUND", "No policy selection exists for this user and exposure.")
            return {"decision": deepcopy(state["decisions"][exposure_id]["response"]),
                    "feedback": [row for row in self._feedback(state, bundle) if row["exposureId"] == exposure_id]}
