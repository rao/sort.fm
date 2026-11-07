"""Independent checks of held-out metrics and experiment isolation."""

from copy import deepcopy
import json
import subprocess
import sys
from uuid import NAMESPACE_URL, uuid5

import pytest

from sortfm_ml.evaluate import evaluate_model


METRICS = (
    "baseRate", "balancedAccuracy", "rocAuc", "prAuc", "logLoss",
    "brierScore", "precisionAtK",
)


def example(index, label, split="train", provenance="synthetic"):
    return {
        "trackId": f"demo:evaluation-{index}",
        "decisionId": str(uuid5(NAMESPACE_URL, f"evaluation-{index}")),
        "label": label,
        "split": split,
        "labeledAt": "2026-11-07T12:00:00Z",
        "features": {
            "featureVersion": "sortfm.features.v1",
            "values": {"saved_age_days": index * 10},
            "provenance": provenance,
            "permittedForTraining": True,
        },
    }


class FixedProbabilityModel:
    """Controlled predictor for checking metric arithmetic, never a fitted model."""

    model_kind = "logistic"
    trained_examples = 12

    def __init__(self, scores):
        self.scores = scores

    def predict(self, candidates, model_version):
        assert all(set(candidate) == {"trackId", "features"} for candidate in candidates)
        # Deliberately reverse output; evaluation must join on identity.
        return [
            {"trackId": candidate["trackId"], "prediction": {
                "removalProbability": self.scores[candidate["trackId"]],
            }}
            for candidate in reversed(candidates)
        ]


def metric_fixture(holdout_count=20):
    train = [example(index, index % 2) for index in range(12)]
    holdout = [example(index + 12, index % 2 == 0, "holdout") for index in range(holdout_count)]
    for row in holdout:
        row["label"] = int(row["label"])
    scores = {row["trackId"]: (0.8, 0.6, 0.4, 0.2)[index % 4] for index, row in enumerate(holdout)}
    return train + holdout, FixedProbabilityModel(scores)


def test_metrics_use_holdout_probabilities_joined_by_track_identity():
    examples, model = metric_fixture()
    metrics = evaluate_model(model, examples, "model-test")
    assert metrics["status"] == "available"
    assert metrics["labeledExamples"] == 32
    assert metrics["trainedExamples"] == 12
    assert metrics["heldOutExamples"] == 20
    assert metrics["heldOutPositive"] == metrics["heldOutNegative"] == 10
    assert metrics["baseRate"] == 0.5
    assert metrics["balancedAccuracy"] == 0.5
    assert metrics["rocAuc"] == 0.75
    assert metrics["prAuc"] == pytest.approx(5 / 6)  # Average precision, not trapezoid area.
    assert metrics["logLoss"] == pytest.approx(0.5697171415941824)
    assert metrics["brierScore"] == pytest.approx(0.2)
    assert metrics["precisionAtK"] == 0.5
    assert metrics["evaluatedAt"] is not None


@pytest.mark.parametrize("case", ["small_holdout", "one_class_holdout", "heuristic"])
def test_unavailable_evaluation_reports_actual_counts_and_all_metrics_null(case):
    examples, model = metric_fixture(19 if case == "small_holdout" else 20)
    if case == "one_class_holdout":
        for row in examples[12:]:
            row["label"] = 1
    if case == "heuristic":
        model.model_kind = "heuristic"
    metrics = evaluate_model(model, examples, "model-test")
    assert metrics["status"] == "insufficient_data"
    assert metrics["labeledExamples"] == len(examples)
    assert metrics["trainedExamples"] == 12
    assert metrics["heldOutExamples"] == len(examples) - 12
    assert metrics["heldOutPositive"] + metrics["heldOutNegative"] == len(examples) - 12
    assert all(metrics[name] is None for name in METRICS)
    assert metrics["reason"]


@pytest.mark.parametrize("provenance,dataset", [
    ("synthetic", "synthetic"), ("licensed", "licensed"), ("spotify", "user_feedback"),
])
def test_dataset_preserves_input_provenance(provenance, dataset):
    examples, model = metric_fixture()
    for row in examples:
        row["features"]["provenance"] = provenance
    assert evaluate_model(model, examples, "v1")["dataset"] == dataset


def test_nonfinite_or_missing_probability_cannot_produce_available_metrics():
    examples, model = metric_fixture()
    model.scores[examples[-1]["trackId"]] = float("nan")
    metrics = evaluate_model(model, examples, "v1")
    assert metrics["status"] == "unavailable"
    assert all(metrics[name] is None for name in METRICS)


def test_duplicate_track_cannot_be_in_both_train_and_holdout():
    examples, model = metric_fixture()
    examples[-1]["trackId"] = examples[0]["trackId"]
    with pytest.raises(ValueError, match="[Dd]uplicate"):
        evaluate_model(model, examples, "v1")


def test_synthetic_generation_is_reproducible_and_split_identity_is_label_independent():
    from sortfm_ml.cli import generate_synthetic, split_for_track

    payload = generate_synthetic(seed=73, size=240)
    assert payload == generate_synthetic(seed=73, size=240)
    assert payload != generate_synthetic(seed=74, size=240)
    assert {row["split"] for row in payload["examples"]} == {"train", "holdout"}
    assert all(row["features"]["provenance"] == "synthetic" for row in payload["examples"])
    for row in payload["examples"]:
        assert row["split"] == split_for_track(payload["userId"], row["trackId"], 73)


def test_experiment_ablations_and_learning_curve_share_holdout_without_mutating_input():
    from sortfm_ml.cli import generate_synthetic, run_experiment

    payload = generate_synthetic(seed=73, size=240)
    original = deepcopy(payload)
    report = run_experiment(payload, label_provenance="Synthetic stochastic labels")
    assert payload == original
    holdout_ids = {row["trackId"] for row in payload["examples"] if row["split"] == "holdout"}
    assert set(report["evaluation"]["holdoutTrackIds"]) == holdout_ids
    assert len(report["ablations"]) == 4
    for result in report["ablations"] + report["learningCurve"]:
        assert result["holdoutDigest"] == report["evaluation"]["holdoutDigest"]
        assert result["metrics"]["heldOutExamples"] == len(holdout_ids)
        assert not holdout_ids.intersection(result["trainingTrackIds"])
    assert {row["name"] for row in report["controls"]} == {"constant_training_prior", "seeded_random_ranking", "saved_age_ranking"}
    assert report["controls"][1]["logLoss"] is None
    assert report["controls"][2]["brierScore"] is None
    for result in report["ablations"]:
        bins = result["reliabilityBins"]
        assert len(bins) == 5
        assert sum(item["count"] for item in bins) == len(holdout_ids)
        observed_positives = sum(item["count"] * (item["observedFraction"] or 0) for item in bins)
        assert observed_positives == pytest.approx(result["metrics"]["heldOutPositive"])


def test_authored_fixture_is_explicitly_synthetic_and_additional_labels_change_predictions():
    from sortfm_ml.cli import authored_adaptation

    report = authored_adaptation()
    assert report["labelProvenance"] == "AI-authored illustrative labels; not human/listener feedback"
    assert report["metrics"]["dataset"] == "synthetic"
    assert report["metrics"]["status"] == "insufficient_data"
    assert report["after"]["trainedExamples"] > report["before"]["trainedExamples"]
    assert abs(report["after"]["removalProbability"] - report["before"]["removalProbability"]) > 0.01


def test_cli_demo_and_evaluate_write_measured_reports(tmp_path):
    demo_output = tmp_path / "demo.json"
    subprocess.run([
        sys.executable, "-m", "sortfm_ml.cli", "demo", "--seed", "73", "--size", "120",
        "--output", str(demo_output),
    ], check=True, capture_output=True, text=True)
    demo = json.loads(demo_output.read_text())
    assert demo["synthetic"]["ablations"][0]["metrics"]["labeledExamples"] == 120
    assert demo["authoredAdaptation"]["metrics"]["status"] == "insufficient_data"

    from sortfm_ml.cli import generate_synthetic
    input_path = tmp_path / "input.json"
    input_path.write_text(json.dumps(generate_synthetic(seed=73, size=120)))
    evaluated_output = tmp_path / "evaluated.json"
    subprocess.run([
        sys.executable, "-m", "sortfm_ml.cli", "evaluate", str(input_path),
        "--output", str(evaluated_output),
    ], check=True, capture_output=True, text=True)
    evaluated = json.loads(evaluated_output.read_text())
    assert evaluated["ablations"][0]["metrics"]["labeledExamples"] == 120


@pytest.mark.parametrize("evaluation_seed", [-13, 2**53 - 1])
def test_experiment_accepts_contract_valid_seed_without_changing_given_split(evaluation_seed):
    from sortfm_ml.cli import generate_synthetic, run_experiment

    payload = generate_synthetic(seed=73, size=240)
    expected_ids = {row["trackId"] for row in payload["examples"] if row["split"] == "holdout"}
    payload["evaluationSeed"] = evaluation_seed
    report = run_experiment(payload)
    assert set(report["evaluation"]["holdoutTrackIds"]) == expected_ids
    assert all(row["metrics"]["status"] == "available" for row in report["ablations"])


@pytest.mark.parametrize("invalid", ["permission", "mixed_synthetic"])
def test_cli_experiment_rejects_unpermitted_or_mixed_synthetic_feedback(invalid):
    from sortfm_ml.cli import generate_synthetic, run_experiment

    payload = generate_synthetic(seed=73, size=120)
    if invalid == "permission":
        payload["examples"][0]["features"]["permittedForTraining"] = False
    else:
        payload["examples"][0]["features"]["provenance"] = "spotify"
    with pytest.raises(ValueError):
        run_experiment(payload)


def test_evaluator_counts_collected_labels_separately_from_training_eligible_labels():
    examples, model = metric_fixture()
    examples[0]["features"]["permittedForTraining"] = False
    model.trained_examples = 11
    metrics = evaluate_model(model, examples, "v1")
    assert metrics["labeledExamples"] == 32
    assert metrics["trainedExamples"] == 11
    assert metrics["heldOutExamples"] == 20


def test_cli_train_persists_model_and_loaded_scores_match_original_fit(tmp_path):
    from sortfm_ml.cli import generate_synthetic
    from sortfm_ml.model import PreferenceModel
    from sortfm_ml.service import ModelService

    payload = generate_synthetic(seed=73, size=120)
    input_path, output_path = tmp_path / "input.json", tmp_path / "fit.json"
    artifacts = tmp_path / "artifacts"
    input_path.write_text(json.dumps(payload))
    subprocess.run([
        sys.executable, "-m", "sortfm_ml.cli", "train", str(input_path),
        "--artifacts", str(artifacts), "--output", str(output_path),
    ], check=True, capture_output=True, text=True)
    fitted = json.loads(output_path.read_text())
    assert fitted["userId"] == payload["userId"]
    assert fitted["feedbackRevision"] == 120
    assert fitted["trainedExamples"] == sum(row["split"] == "train" for row in payload["examples"])
    assert list(artifacts.rglob("*.joblib"))
    candidates = [{"trackId": row["trackId"], "features": row["features"]} for row in payload["examples"][:3]]
    request = {
        "userId": payload["userId"], "featureVersion": "sortfm.features.v1",
        "modelVersion": fitted["modelVersion"], "candidates": candidates,
    }
    loaded = ModelService(artifacts).score(request)
    assert loaded == ModelService(artifacts).score(request)
    assert loaded["predictions"] == PreferenceModel(payload["examples"], seed=73).predict(candidates, fitted["modelVersion"])
    assert not output_path.with_suffix(".md").exists()
