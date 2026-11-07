"""Fixed-holdout evaluation; this module never fits or tunes a model.

The wire contract calls average precision ``prAuc``. We use the non-interpolated
average-precision convention, not trapezoidal integration of the PR curve.
"""

from datetime import datetime, timezone
import math
from typing import Any, Protocol

import numpy as np
from sklearn.metrics import (
    average_precision_score,
    balanced_accuracy_score,
    brier_score_loss,
    log_loss,
    roc_auc_score,
)


PRECISION_K = 10
METRIC_FIELDS = (
    "baseRate", "balancedAccuracy", "rocAuc", "prAuc", "logLoss",
    "brierScore", "precisionAtK",
)


class FittedModel(Protocol):
    model_kind: str
    trained_examples: int

    def predict(self, candidates: list[dict], model_version: str) -> list[dict]: ...


def dataset_kind(examples: list[dict]) -> str:
    """Conservative mapping into the frozen, coarse dataset enum.

    Synthetic content makes the whole evaluation synthetic. The remaining
    labels are caller-supplied feedback; provenance describes their features,
    not an independently verified human annotation source.
    """
    sources = {row["features"]["provenance"] for row in examples}
    if not sources or "synthetic" in sources:
        return "synthetic"
    if sources == {"licensed"}:
        return "licensed"
    return "user_feedback"


def ranking_metrics(labels: list[int], scores: list[float], track_ids: list[str]) -> dict:
    """Ranking-only controls must not advertise probabilities or calibration."""
    order = sorted(range(len(labels)), key=lambda index: (-scores[index], track_ids[index]))
    k = min(PRECISION_K, len(labels))
    return {
        "rocAuc": float(roc_auc_score(labels, scores)),
        "prAuc": float(average_precision_score(labels, scores)),
        "precisionAtK": float(sum(labels[index] for index in order[:k]) / k),
    }


def probability_metrics(labels: list[int], probabilities: list[float], track_ids: list[str]) -> dict:
    """Compute metrics only after the caller checks holdout eligibility."""
    return {
        "baseRate": float(np.mean(labels)),
        "balancedAccuracy": float(balanced_accuracy_score(labels, np.asarray(probabilities) >= 0.5)),
        **ranking_metrics(labels, probabilities, track_ids),
        "logLoss": float(log_loss(labels, probabilities, labels=[0, 1])),
        "brierScore": float(brier_score_loss(labels, probabilities)),
    }


def evaluate_model(model: FittedModel, examples: list[dict], model_version: str) -> dict[str, Any]:
    """Evaluate a train-only fit against exactly the caller's fixed holdout.

    Tracks are unique in the active feedback ledger. Reject duplicates here
    rather than accidentally measuring the same track in train and holdout.
    Counts include actual supplied labels; trainedExamples is the model's
    count of labels it actually used, which can exclude restricted features.
    """
    track_ids = [row["trackId"] for row in examples]
    if len(set(track_ids)) != len(track_ids):
        raise ValueError("Duplicate track IDs invalidate a fixed holdout")
    if any(type(row["label"]) is not int or row["label"] not in (0, 1) for row in examples):
        raise ValueError("Evaluation requires explicit binary labels")
    if any(row["split"] not in ("train", "holdout") for row in examples):
        raise ValueError("Evaluation requires a fixed train/holdout split")
    train_count = sum(row["split"] == "train" and row["features"]["permittedForTraining"] for row in examples)
    if model.trained_examples > train_count:
        raise ValueError("Model training count exceeds eligible training examples")
    holdout = sorted((row for row in examples if row["split"] == "holdout"), key=lambda row: row["trackId"])
    positives = sum(row["label"] for row in holdout)
    result = {
        "status": "insufficient_data",
        "reason": None,
        "modelVersion": model_version,
        "dataset": dataset_kind(examples),
        "evaluationMethod": "fixed_holdout" if holdout else "none",
        "labeledExamples": len(examples),
        "trainedExamples": int(model.trained_examples),
        "heldOutExamples": len(holdout),
        "heldOutPositive": positives,
        "heldOutNegative": len(holdout) - positives,
        **dict.fromkeys(METRIC_FIELDS),
        "evaluatedAt": None,
    }
    if len(holdout) < 20:
        result["reason"] = "At least 20 fixed held-out labels are required."
        return result
    if positives == 0 or positives == len(holdout):
        result["reason"] = "The fixed holdout must contain both KEEP and REMOVE labels."
        return result
    if model.model_kind != "logistic":
        result["reason"] = "A supervised probability model has not been fitted."
        return result

    candidates = [{"trackId": row["trackId"], "features": row["features"]} for row in holdout]
    predictions = model.predict(candidates, model_version)
    by_id = {row["trackId"]: row["prediction"].get("removalProbability") for row in predictions}
    scores = [by_id.get(row["trackId"]) for row in holdout]
    if (
        len(predictions) != len(holdout)
        or set(by_id) != {row["trackId"] for row in holdout}
        or any(score is None or not math.isfinite(score) or not 0 <= score <= 1 for score in scores)
    ):
        result["status"] = "unavailable"
        result["reason"] = "A valid removal probability was not returned for every held-out track."
        return result

    result.update(probability_metrics(
        [row["label"] for row in holdout], scores, [row["trackId"] for row in holdout],
    ))
    result["status"] = "available"
    result["evaluatedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    return result
