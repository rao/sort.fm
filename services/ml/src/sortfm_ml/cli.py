"""Reproducible offline experiments on fixed holdouts, with explicit provenance."""

import argparse
import hashlib
from importlib.resources import files
import json
import math
from pathlib import Path
import platform
import random
from uuid import NAMESPACE_URL, uuid5

import numpy as np
import sklearn

from .evaluate import (
    METRIC_FIELDS, PRECISION_K, dataset_kind, evaluate_model,
    probability_metrics, ranking_metrics,
)


FEATURE_VERSION = "sortfm.features.v1"
FIXTURE_TIME = "2026-11-07T12:00:00Z"
FEATURE_GROUPS = ("metadata", "history", "audio", "personalized")
SERVICE_ROOT = Path(__file__).resolve().parents[2]


def _digest(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def split_for_track(user_id: str, track_id: str, seed: int) -> str:
    """Stable approximately 20% holdout, independent of features and labels."""
    identity = json.dumps([seed, user_id, track_id], separators=(",", ":")).encode()
    return "holdout" if int.from_bytes(hashlib.sha256(identity).digest()[:8], "big") % 5 == 0 else "train"


def _feature_vector(values: dict) -> dict:
    return {
        "featureVersion": FEATURE_VERSION, "values": values,
        "provenance": "synthetic", "permittedForTraining": True,
        "rightsBasis": "Original fictional features; no provider or listener data",
    }


def generate_synthetic(seed: int = 42, size: int = 600) -> dict:
    """Noisy Bernoulli labels, missing features, and a predeclared target.

    The latent target combines metadata, listening proxies, and audio values;
    it deliberately favors some feature groups and cannot establish utility
    on genuine listener decisions. No holdout results affect the generator.
    """
    if size < 1:
        raise ValueError("Synthetic size must be positive")
    rng = np.random.default_rng(seed)
    user_id = "demo:synthetic-listener"
    examples = []
    for index in range(size):
        age = float(rng.uniform(0, 2400))
        energy, danceability, acousticness = map(float, rng.uniform(0, 1, 3))
        recent = int(rng.poisson(1.6))
        top_short, top_medium, top_long, top_artist = map(int, rng.binomial(1, [0.18, 0.25, 0.32, 0.3]))
        key_angle = float(rng.integers(0, 12)) * math.pi / 6
        latent = (
            0.9 * (age / 1200 - 1) - 0.65 * top_short - 0.30 * top_artist
            - 0.22 * recent + 1.7 * (0.5 - energy) + 1.1 * (0.5 - danceability)
            + 0.65 * (acousticness - 0.5) + float(rng.normal(0, 0.65)) + 0.35
        )
        probability = 0.08 + 0.84 / (1 + math.exp(-latent))
        label = int(rng.random() < probability)
        values = {
            "saved_age_days": age, "release_age_years": float(rng.uniform(0, 50)),
            "duration_ms": int(rng.integers(100_000, 360_000)),
            "artist_library_count": int(rng.poisson(4)),
            "top_track_short": top_short, "top_track_medium": top_medium,
            "top_track_long": top_long, "top_artist": top_artist,
            "recent_play_count": recent, "energy": energy, "danceability": danceability,
            "happiness": float(rng.random()), "acousticness": acousticness,
            "instrumentalness": float(rng.random()), "liveness": float(rng.random()),
            "speechiness": float(rng.beta(1.2, 6)), "tempo_bpm": float(rng.uniform(60, 190)),
            "loudness_db": float(rng.uniform(-24, -3)),
            "key_sin": math.sin(key_angle), "key_cos": math.cos(key_angle),
            "mode_major": int(rng.integers(0, 2)), "soundnet_popularity": float(rng.random()),
        }
        for name in values:
            if rng.random() < (0.08 if name in ("saved_age_days", "recent_play_count") else 0.18):
                values[name] = None
        track_id = f"demo:synthetic-{index:05d}"
        examples.append({
            "trackId": track_id,
            "features": _feature_vector(values),
            "decisionId": str(uuid5(NAMESPACE_URL, f"sortfm-synthetic:{seed}:{track_id}")),
            "label": label, "split": split_for_track(user_id, track_id, seed),
            "labeledAt": FIXTURE_TIME,
        })
    return {
        "userId": user_id, "featureVersion": FEATURE_VERSION,
        "feedbackRevision": size, "evaluationSeed": seed, "examples": examples,
    }


def _control_results(train: list[dict], holdout: list[dict], seed: int) -> list[dict]:
    usable_train = [row for row in train if row["features"]["permittedForTraining"]]
    labels = [row["label"] for row in holdout]
    ids = [row["trackId"] for row in holdout]
    prior = sum(row["label"] for row in usable_train) / len(usable_train) if usable_train else None
    rng = random.Random(seed)
    random_scores = [rng.random() for _ in holdout]
    age_scores = [row["features"]["values"].get("saved_age_days") for row in holdout]
    observed_ages = [row["features"]["values"].get("saved_age_days") for row in usable_train]
    observed_ages = [age for age in observed_ages if age is not None]
    training_median_age = float(np.median(observed_ages)) if observed_ages else 0.0
    age_scores = [training_median_age if age is None else age for age in age_scores]
    eligible = len(holdout) >= 20 and set(labels) == {0, 1}
    results = []
    for name, scores, probabilistic in (
        ("constant_training_prior", [prior] * len(holdout), True),
        ("seeded_random_ranking", random_scores, False),
        ("saved_age_ranking", age_scores, False),
    ):
        available = eligible and (not probabilistic or prior is not None)
        result = {
            "name": name, "scoreType": "probability" if probabilistic else "ranking_score",
            "status": "available" if available else "insufficient_data",
            "trainedExamples": len(usable_train) if probabilistic else 0,
            "preprocessingExamples": len(usable_train) if name == "saved_age_ranking" else 0,
            "heldOutExamples": len(holdout), **dict.fromkeys(METRIC_FIELDS),
        }
        if available:
            result.update(probability_metrics(labels, scores, ids) if probabilistic else ranking_metrics(labels, scores, ids))
            result["baseRate"] = sum(labels) / len(labels)
        results.append(result)
    return results


def _reliability_bins(model, holdout: list[dict], model_version: str, metrics: dict) -> list[dict] | None:
    """Fixed bins are diagnostics, not a claim that probabilities are calibrated."""
    if metrics["status"] != "available":
        return None
    candidates = [{"trackId": row["trackId"], "features": row["features"]} for row in holdout]
    by_id = {row["trackId"]: row["prediction"]["removalProbability"] for row in model.predict(candidates, model_version)}
    bins = []
    for index in range(5):
        members = [row for row in holdout if min(int(by_id[row["trackId"]] * 5), 4) == index]
        bins.append({
            "lowerInclusive": index / 5,
            "upper": (index + 1) / 5,
            "upperInclusive": index == 4,
            "count": len(members),
            "meanProbability": float(np.mean([by_id[row["trackId"]] for row in members])) if members else None,
            "observedFraction": sum(row["label"] for row in members) / len(members) if members else None,
        })
    return bins


def run_experiment(payload: dict, label_provenance: str = "Caller-supplied labels; human origin not independently verified") -> dict:
    """Ablations and learning curves share the input's exact fixed holdout.

    Hyperparameters and feature groups are fixed in source. These runs are
    descriptive: they do not select a winning model, tune its threshold, or
    refit on the evaluation labels.
    """
    from .model import PreferenceModel
    from .schemas import FitRequest

    payload = FitRequest.model_validate(payload).model_dump(by_alias=True, exclude_unset=True)
    seed = payload["evaluationSeed"]
    examples = payload["examples"]
    if any(not row["features"]["permittedForTraining"] for row in examples):
        raise ValueError("Every labeled example must be permitted for training")
    if len({row["features"]["provenance"] == "synthetic" for row in examples}) > 1:
        raise ValueError("Synthetic and real feedback must be separate experiments")
    train = sorted((row for row in examples if row["split"] == "train"), key=lambda row: row["trackId"])
    holdout = sorted((row for row in examples if row["split"] == "holdout"), key=lambda row: row["trackId"])
    holdout_ids = [row["trackId"] for row in holdout]
    holdout_digest = _digest(holdout_ids)
    training_ids = [row["trackId"] for row in train if row["features"]["permittedForTraining"]]
    report = {
        "schemaVersion": "sortfm.experiment.v1",
        "dataset": dataset_kind(examples), "labelProvenance": label_provenance,
        "notice": "Exploratory offline measurements. No real listener validation is included in this repository. No calibration or real-world usefulness is established.",
        "inputDigest": _digest(payload),
        "runtime": {"python": platform.python_version(), "numpy": np.__version__, "scikitLearn": sklearn.__version__},
        "evaluation": {
            "seed": seed, "splitMethod": "Caller-supplied fixed train/holdout assignment",
            "holdoutTrackIds": holdout_ids, "holdoutDigest": holdout_digest,
            "decisionThreshold": 0.5, "precisionK": PRECISION_K,
            "prAucConvention": "Non-interpolated average precision (sklearn.average_precision_score)",
            "modelSelection": "None; fixed hyperparameters and threshold, no holdout tuning",
            "reliabilityConvention": "Five equal-width probability bins, final bin includes 1; descriptive only, no fitted calibration",
        },
        "ablations": [], "controls": _control_results(train, holdout, seed), "learningCurve": [],
    }
    for group in FEATURE_GROUPS:
        model = PreferenceModel(train, seed=seed, feature_group=group)
        model_version = f"experiment-{group}-seed{seed}"
        metrics = evaluate_model(model, examples, model_version)
        report["ablations"].append({
            "name": group, "modelKind": model.model_kind, "featureGroup": group,
            "trainingTrackIds": training_ids, "holdoutDigest": holdout_digest,
            "metrics": metrics,
            "reliabilityBins": _reliability_bins(model, holdout, model_version, metrics),
        })

    # Nested randomized training subsets; ordering never uses holdout data.
    shuffled_train = list(train)
    random.Random(seed).shuffle(shuffled_train)
    sizes = sorted({size for size in (0, 6, 12, 24, 48, 96, 192, len(train)) if size <= len(train)})
    for size in sizes:
        subset = shuffled_train[:size]
        model = PreferenceModel(subset, seed=seed, feature_group="personalized")
        model_version = f"curve-n{size}-seed{seed}"
        metrics = evaluate_model(model, subset + holdout, model_version)
        report["learningCurve"].append({
            "trainingSize": size, "modelKind": model.model_kind,
            "trainingTrackIds": [row["trackId"] for row in subset if row["features"]["permittedForTraining"]],
            "holdoutDigest": holdout_digest,
            "metrics": metrics,
            "reliabilityBins": _reliability_bins(model, holdout, model_version, metrics),
        })
    return report


def authored_adaptation() -> dict:
    """Curated toy profiles demonstrate changed scores, not human validity."""
    from .model import PreferenceModel

    packaged_fixture = files("sortfm_ml").joinpath("fixtures", "authored_profiles.json")
    fixture_text = packaged_fixture.read_text() if packaged_fixture.is_file() else (SERVICE_ROOT / "fixtures" / "authored_profiles.json").read_text()
    fixture = json.loads(fixture_text)
    examples = []
    for values in fixture["profiles"]:
        row = dict(zip(fixture["columns"], values, strict=True))
        track_id, label = row.pop("trackId"), row.pop("label")
        examples.append({
            "trackId": track_id, "label": label, "features": _feature_vector(row),
            "decisionId": str(uuid5(NAMESPACE_URL, track_id)),
            "split": "train", "labeledAt": FIXTURE_TIME,
        })
    candidate = {"trackId": fixture["probe"]["trackId"], "features": _feature_vector(fixture["probe"]["values"])}
    before = PreferenceModel(examples[:fixture["initialCount"]], seed=42)
    after = PreferenceModel(examples, seed=42)
    return {
        "labelProvenance": fixture["labelProvenance"], "notice": fixture["notice"],
        "fixtureDigest": _digest(fixture), "probeTrackId": candidate["trackId"],
        "before": before.predict([candidate], "authored-before")[0]["prediction"],
        "after": after.predict([candidate], "authored-after")[0]["prediction"],
        "metrics": evaluate_model(after, examples, "authored-after"),
    }


def _markdown_report(report: dict) -> str:
    experiment = report.get("synthetic", report)
    metrics = experiment["ablations"][0]["metrics"]
    lines = [
        "# Fixed-holdout experiment", "", experiment["notice"], "",
        f"Label source: {experiment['labelProvenance']}", "",
        f"Seed: {experiment['evaluation']['seed']}. Holdout: {len(experiment['evaluation']['holdoutTrackIds'])} tracks.",
        f"Held-out REMOVE labels: {metrics['heldOutPositive']}; KEEP labels: {metrics['heldOutNegative']}. Removal base rate: {metrics['baseRate'] if metrics['baseRate'] is not None else 'unavailable'}.",
        f"Holdout identity SHA-256: `{experiment['evaluation']['holdoutDigest']}`.", "",
        "PR-AUC uses non-interpolated average precision. Precision@k uses k=10 (or the whole holdout if smaller). Classification threshold is 0.5. No holdout tuning or calibration.", "",
        "| Model | Trained | Balanced accuracy | ROC AUC | PR AUC (AP) | Log loss | Brier | Precision@10 |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
    ]

    def row(name, metrics):
        values = [metrics.get(key) for key in ("balancedAccuracy", "rocAuc", "prAuc", "logLoss", "brierScore", "precisionAtK")]
        cells = ["—" if value is None else f"{value:.4f}" for value in values]
        return f"| {name} | {metrics['trainedExamples']} | " + " | ".join(cells) + " |"

    lines += [row(result["name"], result["metrics"]) for result in experiment["ablations"]]
    lines += [row(result["name"], result) for result in experiment["controls"]]
    lines += ["", "## Learning curve", "", "Same holdout at every point; training subsets are nested and seeded.", "",
              "| Training labels | Model | ROC AUC | Log loss | Brier |", "|---:|---|---:|---:|---:|"]
    for result in experiment["learningCurve"]:
        metrics = result["metrics"]
        cells = ["—" if metrics[name] is None else f"{metrics[name]:.4f}" for name in ("rocAuc", "logLoss", "brierScore")]
        lines.append(f"| {result['trainingSize']} | {result['modelKind']} | " + " | ".join(cells) + " |")
    if "authoredAdaptation" in report:
        authored = report["authoredAdaptation"]
        lines += ["", "## Authored fixture adaptation", "", authored["notice"], "",
                  f"The fixed probe's removal score changed from {authored['before']['removalProbability']:.6f} to {authored['after']['removalProbability']:.6f} after {authored['before']['trainedExamples']} → {authored['after']['trainedExamples']} training labels. This is a deterministic mechanism check with no holdout; all validation metrics remain null."]
    lines += ["", "## Limits", "", "Synthetic labels come from a declared noisy generator that contains metadata/history/audio signal. These figures measure recovery of that artificial rule. They do not establish generalization to listeners, model calibration, or reliable archive suggestions. The authored fixture was created by an AI agent and is not human-labeled data. Actual user feedback, temporal/exposure bias analysis, and prospective validation remain missing.", ""]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    demo = subparsers.add_parser("demo", help="Run synthetic experiments and the explicitly authored adaptation fixture")
    demo.add_argument("--seed", type=int, default=42)
    demo.add_argument("--size", type=int, default=600)
    demo.add_argument("--output", type=Path, required=True, help="JSON report; a sibling Markdown report is also written")
    evaluate = subparsers.add_parser("evaluate", help="Evaluate a FitRequest JSON using its existing fixed split")
    evaluate.add_argument("input", type=Path)
    evaluate.add_argument("--output", type=Path, required=True)
    train = subparsers.add_parser("train", help="Persist a model from a strict FitRequest JSON")
    train.add_argument("input", type=Path)
    train.add_argument("--artifacts", type=Path, required=True)
    train.add_argument("--output", type=Path, required=True, help="FitResponse JSON")
    args = parser.parse_args(argv)
    from .service import ModelService, ServiceError
    from .schemas import FitRequest

    try:
        if args.command == "demo":
            payload = generate_synthetic(seed=args.seed, size=args.size)
            experiment = run_experiment(payload, label_provenance="Synthetic noisy Bernoulli labels from the declared generator")
            experiment["evaluation"]["splitMethod"] = "SHA-256 of [seed,userId,trackId] modulo 5; bucket 0 held out"
            report = {"synthetic": experiment, "authoredAdaptation": authored_adaptation()}
        elif args.command == "evaluate":
            report = run_experiment(json.loads(args.input.read_text()))
        else:
            payload = FitRequest.model_validate(json.loads(args.input.read_text())).model_dump(by_alias=True, exclude_unset=True)
            report = ModelService(args.artifacts).fit(payload)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
        if args.command != "train":
            args.output.with_suffix(".md").write_text(_markdown_report(report))
    except (ValueError, OSError, ServiceError) as error:
        parser.error(str(error))
    print(f"Wrote {args.output}" + (f" and {args.output.with_suffix('.md')}" if args.command != "train" else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
