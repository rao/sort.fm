"""Shared-linear LinUCB for useful music-library review outcomes.

The learned response is a review reward, never a removal probability. C1 owns
that probability and its frozen feature pipeline. Rebuild this learner after
Undo or a C1 refit: contexts from different C1 coordinate systems cannot be
combined. No scorer or selector mutates the preference model or input rows.
"""

from __future__ import annotations

from collections import Counter
import hashlib
import math
from numbers import Integral, Real

import numpy as np

CONTEXT_VERSION = "sortfm.bandit.context.v1"


def _number(value, name: str, *, minimum: float, maximum: float = math.inf) -> float:
    if isinstance(value, bool) or not isinstance(value, Real) or not math.isfinite(value) or not minimum <= value <= maximum:
        raise ValueError(f"{name} must be finite and in [{minimum}, {maximum}]")
    return float(value)


def _integer(value, name: str, minimum: int | None = None) -> int:
    if isinstance(value, bool) or not isinstance(value, Integral) or (minimum is not None and value < minimum):
        raise ValueError(f"{name} must be an integer" + (f" >= {minimum}" if minimum is not None else ""))
    return int(value)


class LinearUCB:
    """Ridge least-squares reward model with a shared parameter across songs.

    A = ridge*I + X.T@X; b = X.T@y; theta = solve(A,b).
    UCB(x) = x.T@theta + alpha*sqrt(x.T@solve(A,x)).
    Alpha is a configurable exploration coefficient, not a calibrated coverage
    probability. The informationGain score is one-half log determinant growth
    for unit observation noise, not measured user information gain.
    """

    def __init__(self, dimension: int, alpha: float = .5, ridge: float = 1.):
        self.dimension = _integer(dimension, "dimension", 1)
        self.alpha = _number(alpha, "alpha", minimum=0.)
        self.ridge = _number(ridge, "ridge", minimum=np.finfo(float).tiny)
        self.fit(np.empty((0, self.dimension)), np.empty(0))

    def _contexts(self, contexts: np.ndarray) -> np.ndarray:
        values = np.asarray(contexts, dtype=np.float64)
        if values.ndim != 2 or values.shape[1] != self.dimension or not np.isfinite(values).all():
            raise ValueError(f"contexts must be finite with shape (n, {self.dimension})")
        return values

    def fit(self, contexts: np.ndarray, rewards: np.ndarray) -> LinearUCB:
        """Replace, rather than increment, statistics; failed fits are atomic."""
        values = self._contexts(contexts)
        target = np.asarray(rewards, dtype=np.float64)
        if target.ndim != 1 or len(target) != len(values) or not np.isfinite(target).all():
            raise ValueError("rewards must be a finite vector aligned with contexts")
        try:
            with np.errstate(over="raise", invalid="raise"):
                matrix = self.ridge * np.eye(self.dimension) + values.T @ values
                response = values.T @ target
                factor = np.linalg.cholesky(matrix)
                theta = np.linalg.solve(factor.T, np.linalg.solve(factor, response))
            if not np.isfinite(theta).all():
                raise ValueError("nonfinite fitted coefficients")
        except (FloatingPointError, np.linalg.LinAlgError) as error:
            raise ValueError("contexts are numerically unsuitable for ridge fitting") from error
        self._factor, self._theta = factor, theta
        self.n_observations = len(values)
        return self

    def scores(self, contexts: np.ndarray) -> dict[str, np.ndarray]:
        values = self._contexts(contexts)
        try:
            with np.errstate(over="raise", invalid="raise"):
                whitened = np.linalg.solve(self._factor, values.T)
                variance = np.einsum("ij,ij->j", whitened, whitened)
                uncertainty = np.sqrt(variance)
                mean = values @ self._theta
                bonus = self.alpha * uncertainty
                score = mean + bonus
                information = .5 * np.log1p(variance)
            if not all(np.isfinite(array).all() for array in (mean, uncertainty, bonus, score, information)):
                raise ValueError("nonfinite selection scores")
        except FloatingPointError as error:
            raise ValueError("contexts are numerically unsuitable for scoring") from error
        return {"mean": mean, "uncertainty": uncertainty, "bonus": bonus, "score": score, "informationGain": information}


def context_names(model) -> tuple[str, ...]:
    return ("bias", "c1_removal_probability_or_heuristic", *model.pipeline.feature_names)


def _predictions(candidates: list[dict], predictions: list[dict]) -> list[dict]:
    ids = [row["trackId"] for row in candidates]
    keyed = {row["trackId"]: row["prediction"] for row in predictions}
    if len(set(ids)) != len(ids) or len(keyed) != len(predictions) or set(ids) != set(keyed):
        raise ValueError("candidates and predictions must have matching unique track IDs")
    return [keyed[track_id] for track_id in ids]


def _baseline(prediction: dict) -> float:
    score = prediction.get("removalProbability")
    if score is None:
        score = prediction.get("heuristicScore")
    return _number(score, "C1 probability or heuristic", minimum=0., maximum=1.)


def build_context(model, candidates: list[dict], predictions: list[dict]) -> np.ndarray:
    """Build finite L2-bounded rows without changing C1 preprocessing.

    Probability and heuristic share a named context column, but remain distinct
    in predictions and diagnostics. Row scaling divides every column by
    max(1, norm), preserving direction and bounding the LinUCB geometry.
    """
    aligned = _predictions(candidates, predictions)
    values = np.column_stack((np.ones(len(candidates)), [_baseline(row) for row in aligned], model.transform_context(candidates)))
    if not np.isfinite(values).all():
        raise ValueError("C1 context contains nonfinite values")
    return values / np.maximum(1., np.linalg.norm(values, axis=1))[:, None]


def select_candidate(
    candidates: list[dict], predictions: list[dict], contexts: np.ndarray,
    learner: LinearUCB, *, seed: int, step: int, config: dict,
    history: list[dict], fallback_order: list[str] | None = None,
) -> dict:
    """Choose one candidate with explicit constraints and auditable scores.

    Service callers exclude previously served/reviewed tracks. Artist IDs are
    optional local metadata, not an extension to the shared ScoringCandidate.
    Exploration means departing from greedy *reward* among diversity-feasible
    candidates. Its prefix quota counts all earlier such departures, including
    pending exposures. A constraint-induced greedy choice remains exploitation.

    Randomized propensities are conditional on this candidate set, history and
    constraint configuration, marginal over the policy's fresh RNG draw. They
    do not establish support for arbitrary other policies. Seed/step replay is
    deterministic. Deterministic LinUCB/C1 propensities remain null.
    """
    if not candidates:
        raise ValueError("selection requires at least one candidate")
    seed, step = _integer(seed, "seed"), _integer(step, "step", 0)
    method = config.get("strategy", "linucb")
    if method not in ("linucb", "epsilon_greedy", "c1", "random"):
        raise ValueError("unsupported selection strategy")
    alpha = _number(config.get("alpha", learner.alpha), "alpha", minimum=0.)
    epsilon = _number(config.get("epsilon", .1), "epsilon", minimum=0., maximum=1.)
    fraction = _number(config.get("maxExplorationFraction", .25), "maxExplorationFraction", minimum=0., maximum=1.)
    threshold = _number(config.get("obviousKeepThreshold", .1), "obviousKeepThreshold", minimum=0., maximum=1.)
    window = _integer(config.get("diversityWindow", 5), "diversityWindow", 0)
    per_artist = _integer(config.get("maxPerArtist", 2), "maxPerArtist", 1)
    aligned = _predictions(candidates, predictions)
    baseline = np.array([_baseline(row) for row in aligned])
    values = learner._contexts(contexts)
    if len(values) != len(candidates):
        raise ValueError("contexts must align with candidates")
    scores = learner.scores(values)
    bonus = alpha * scores["uncertainty"]
    ucb = scores["mean"] + bonus
    # A deterministic key per track decouples tie breaking from caller order
    # and from the global NumPy RNG. C1 is only a secondary tie breaker.
    tie_keys = [hashlib.sha256(f"{seed}:{step}:{row['trackId']}".encode()).digest() for row in candidates]
    ordered = sorted(range(len(candidates)), key=lambda index: candidates[index]["trackId"])

    def best(indices: list[int], objective: np.ndarray) -> int:
        return min(indices, key=lambda index: (-float(objective[index]), -float(baseline[index]), tie_keys[index]))

    reasons = []
    cold = learner.n_observations == 0 and method in ("linucb", "epsilon_greedy")
    propensity = None
    can_explore = False
    eligible = ordered
    # Cold adaptive policies still enforce the same serving constraints. Only
    # the explicit C1 control bypasses them to preserve its exact ranked queue.
    if method != "c1" and window:
        counts = Counter(artist for row in history[-window:] for artist in set(row.get("artistIds") or []))
        diverse = [index for index in eligible if all(counts[artist] < per_artist for artist in set(candidates[index].get("artistIds") or []))]
        if not any(row.get("artistIds") for row in candidates):
            reasons.append("artist_metadata_unavailable")
        elif any(not row.get("artistIds") for row in candidates):
            reasons.append("artist_metadata_partial")
        if not diverse:
            reasons.append("artist_diversity_relaxed_no_eligible_candidate")
        elif len(diverse) < len(eligible):
            eligible = diverse
            reasons.append("artist_diversity_applied")
    if method == "c1" or cold:
        by_id = {candidates[index]["trackId"]: index for index in eligible}
        fallback = [by_id[track_id] for track_id in (fallback_order or []) if track_id in by_id]
        chosen = fallback[0] if fallback else min(eligible, key=lambda index: (-baseline[index], candidates[index]["trackId"]))
        greedy = chosen
        method = "c1"
        selection_score = baseline[chosen]
        bonus = np.zeros(len(candidates))
        reasons.append("no_reward_observations" if cold else "bandit_disabled")
    else:
        greedy = best(eligible, scores["mean"])
        prior_explorations = sum(row.get("strategy") == "explore" for row in history)
        can_explore = prior_explorations < math.floor(fraction * (step + 1))
        if not can_explore:
            eligible = [greedy]
            reasons.append("exploration_budget_exhausted")
        else:
            # A heuristic is not evidence of an obvious keep. Preserve the
            # reward-greedy candidate even if its C1 probability is small.
            safe = [index for index in eligible if aligned[index].get("removalProbability") is None or aligned[index]["removalProbability"] >= threshold]
            if safe:
                protected = [index for index in eligible if index in safe or index == greedy]
                if len(protected) < len(eligible):
                    reasons.append("obvious_keep_exploration_protection")
                eligible = protected
            else:
                reasons.append("all_candidates_obvious_keeps")
        entropy = int.from_bytes(hashlib.sha256(f"{seed}:{step}:draw".encode()).digest()[:16], "big")
        rng = np.random.default_rng(entropy)
        if method == "linucb":
            chosen = best(eligible, ucb)
            selection_score = ucb[chosen]
        elif method == "epsilon_greedy":
            chosen = int(rng.choice(eligible)) if rng.random() < epsilon else greedy
            propensity = epsilon / len(eligible) + (1 - epsilon if chosen == greedy else 0.)
            selection_score = scores["mean"][chosen]
            bonus = np.zeros(len(candidates))
        else:
            chosen = int(rng.choice(eligible))
            propensity = 1. / len(eligible)
            selection_score = propensity
            bonus = np.zeros(len(candidates))
    return {
        "index": chosen, "trackId": candidates[chosen]["trackId"],
        "strategy": "explore" if chosen != greedy else "exploit", "selectionMethod": method,
        "predictedReward": float(scores["mean"][chosen]), "baselineScore": float(baseline[chosen]),
        "selectionScore": float(selection_score), "uncertainty": float(scores["uncertainty"][chosen]),
        "explorationBonus": float(bonus[chosen]), "informationGain": float(scores["informationGain"][chosen]),
        "propensityEstimate": propensity, "greedyTrackId": candidates[greedy]["trackId"],
        "eligibleCount": len(eligible), "explorationAllowed": can_explore,
        "reasons": reasons, "context": values[chosen].tolist(),
    }
