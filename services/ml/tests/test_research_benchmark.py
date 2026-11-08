"""Offline benchmark leakage and experimental-comparison contracts."""

from copy import deepcopy
import json

import numpy as np
import pytest

from sortfm_ml import research_benchmark as benchmark
from sortfm_ml.model import PreferenceModel
from sklearn.metrics import average_precision_score, brier_score_loss, log_loss, ndcg_score, roc_auc_score


def examples(n=36, split="train", offset=0):
    return [
        {"trackId": f"demo:{i + offset:04d}", "decisionId": str(i + offset),
         "label": i % 2, "split": split,
         "labeledAt": f"2026-11-{1 + i // 24:02d}T{i % 24:02d}:00:00Z",
         "features": {"permittedForTraining": True,
                      "values": {"saved_age_days": 50 + 30 * i,
                                 "recent_play_count": i % 4,
                                 "duration_ms": 100000 + 1000 * i,
                                 "energy": .1 + .8 * (i % 2)}}}
        for i in range(n)
    ]


@pytest.fixture(autouse=True)
def fast_bootstrap(monkeypatch):
    monkeypatch.setattr(benchmark, "BOOTSTRAP_REPLICATES", 20)


def test_holdout_perturbation_cannot_affect_cv_or_training(monkeypatch):
    rows = examples() + examples(8, "holdout", 100)
    first = benchmark.run_benchmarks(rows, repeats=2)
    changed = deepcopy(rows)
    for row in changed:
        if row["split"] == "holdout":
            row["label"] = 1 - row["label"]
            row["features"]["values"] = {"energy": 1000, "saved_age_days": 0}
    second = benchmark.run_benchmarks(changed, repeats=2)
    assert first["protocols"]["train_repeated_stratified_cv"] == second["protocols"]["train_repeated_stratified_cv"]
    for a, b in zip(first["learning_curves"]["points"], second["learning_curves"]["points"]):
        for name in a["models"]:
            assert a["models"][name]["predictions"] == b["models"][name]["predictions"]
    json.dumps(first, allow_nan=False)


def test_every_estimator_scores_identical_unseen_fold_population():
    result = benchmark.run_benchmarks(examples(), repeats=2)
    cv = result["protocols"]["train_repeated_stratified_cv"]
    expected = None
    for model in cv["models"].values():
        population = [(p["repeat"], p["fold"], p["track_id"]) for p in model["predictions"]]
        assert len(population) == 72
        assert population == (expected if expected is not None else population)
        expected = population
    for fold in cv["folds"]:
        assert set(fold["train_track_ids"]).isdisjoint(fold["evaluation_track_ids"])
        assert fold["n_train"] + fold["n_evaluation"] == 36
    for point in result["learning_curves"]["points"]:
        assert set(point["models"]) == {"E2_batch", "C1_batch", "SGD_incremental", "SGD_replay"}
        assert set(point["train_track_ids"]).isdisjoint(point["evaluation_track_ids"])
        assert point["n_train"] == len(point["train_track_ids"])
        a = point["models"]["SGD_incremental"]
        b = point["models"]["SGD_replay"]
        assert a["predictions"] == b["predictions"]
        assert a["cumulative_training_rows_seen"] == point["n_train"]
        assert b["cumulative_training_rows_seen"] >= point["n_train"]
    summaries = result["learning_curves"]["summary"]
    assert {summary["evaluation_fold_count"] for summary in summaries} == {len(cv["folds"]) // 2}
    common_sizes = result["learning_curves"]["common_size_grid"]
    common_populations = []
    for size in common_sizes:
        common_populations.append(sorted(track_id for point in result["learning_curves"]["points"]
                                         if point["n_train"] == size for track_id in point["evaluation_track_ids"]))
    assert all(population == common_populations[0] for population in common_populations)
    for summary in summaries:
        for model in summary["models"].values():
            assert model["unique_evaluation_tracks"] == model["prediction_count"] == 36
            assert np.isfinite(model["intervals"]["log_loss"]["low"])
            assert np.isfinite(model["intervals"]["log_loss"]["high"])
    for name, contrast in result["learning_curves"]["endpoint_contrasts"].items():
        assert contrast["unique_evaluation_tracks"] == contrast["prediction_count"] == 36
        assert contrast["first_n_train"] == common_sizes[0]
        assert contrast["last_n_train"] == common_sizes[-1]
        expected = summaries[-1]["models"][name]["metrics"]["log_loss"] - summaries[0]["models"][name]["metrics"]["log_loss"]
        assert contrast["delta"] == pytest.approx(expected)


def test_feature_pipeline_never_fits_holdout_or_fold_evaluation(monkeypatch):
    original = benchmark.FeaturePipeline.fit_transform
    fitted = []

    def capture(self, rows):
        assert all(row["split"] == "train" for row in rows)
        assert not any(row["trackId"].startswith("demo:01") for row in rows)
        fitted.append({row["trackId"] for row in rows})
        return original(self, rows)

    monkeypatch.setattr(benchmark.FeaturePipeline, "fit_transform", capture)
    result = benchmark.run_benchmarks(examples() + examples(8, "holdout", 100), repeats=1)
    for fold in result["protocols"]["train_repeated_stratified_cv"]["folds"]:
        assert set(fold["train_track_ids"]) in fitted
    assert fitted


def test_existing_c1_logistic_is_used_exactly_and_sparse_fallback_is_prior():
    train, evaluate = examples(), examples(4, "holdout", 100)
    for name, group in [("E1", "age"), ("E2", "history"), ("E3", "audio"), ("C1", "personalized")]:
        actual, kind = benchmark._fit_predict(name, train, evaluate, 42)
        model = PreferenceModel(train, seed=42, feature_group=group)
        expected = model.classifier.predict_proba(model.transform_context(evaluate) * model.predictor_mask_)[:, 1]
        np.testing.assert_array_equal(actual, expected)
        assert kind == "logistic"
        sparse, kind = benchmark._fit_predict(name, train[:3], evaluate, 42)
        np.testing.assert_array_equal(sparse, np.full(4, 1 / 3))
        assert kind == "constant_train_prior_fallback"


def test_expected_tie_ranking_is_invariant_to_input_order():
    labels = np.array([0, 0, 0, 1, 1, 1])
    metrics = benchmark._metrics(labels, np.full(6, .5))
    assert metrics["precision_at_5"] == .5
    assert metrics["roc_auc"] == .5
    assert metrics["average_precision"] == .5
    assert metrics == benchmark._metrics(labels[::-1], np.full(6, .5))
    assert metrics["precision_at_10"] == .5


def test_knn_missing_audio_and_matching_ids_do_not_invent_evidence():
    train = examples(2)
    train[0]["features"]["values"] = {"energy": .1}
    train[1]["features"]["values"] = {"energy": .9}
    knn = benchmark.MissingAwareKNN().fit(train)
    # Excluding the matching row leaves just the other class plus smoothing.
    own = knn.predict([train[0]])[0]
    assert own > .5
    missing = deepcopy(train[0])
    missing["trackId"] = "demo:unseen"
    missing["features"]["values"] = {}
    assert knn.predict([missing])[0] == .5
    changed = deepcopy(train)
    changed[0]["label"] = 1
    changed[0]["features"]["values"]["kept_centroid_distance"] = 99999
    # Inference labels and incoming derived distances must never be predictors.
    assert knn.predict(changed)[0] == own


def test_duplicate_tracks_and_mixed_users_are_rejected_before_folding():
    rows = examples()
    duplicate = deepcopy(rows[0])
    duplicate["split"] = "holdout"
    with pytest.raises(ValueError, match="duplicate"):
        benchmark.run_benchmarks(rows + [duplicate])
    rows[0]["userId"], rows[1]["userId"] = "alice", "bob"
    with pytest.raises(ValueError, match="one user"):
        benchmark.run_benchmarks(rows)


def test_insufficient_labels_are_explicit_and_never_fake_cv():
    rows = examples(6)
    for row in rows:
        row["label"] = 0
    result = benchmark.run_benchmarks(rows)
    assert result["protocols"]["train_repeated_stratified_cv"]["status"] == "unavailable"
    assert result["learning_curves"]["status"] == "unavailable"
    assert result["counts"]["train"] == {"total": 6, "keep": 6, "remove": 0}


def test_inference_rows_cannot_affect_each_other_or_use_their_labels():
    train = examples()
    evaluate = examples(4, "holdout", 100)
    for name in benchmark.MODEL_NAMES:
        one, _ = benchmark._fit_predict(name, train, evaluate[:1], 42)
        other = deepcopy(evaluate)
        other[0]["label"] = 1 - other[0]["label"]
        other[1]["features"]["values"] = {"energy": 1e30}
        many, _ = benchmark._fit_predict(name, train, other, 42)
        assert one[0] == pytest.approx(many[0], abs=1e-15)


def test_future_training_values_cannot_change_earlier_learning_curve():
    train, evaluate = examples(), examples(4, "holdout", 100)
    first = benchmark._learning_curves([(0, 0, train, evaluate)], 42)
    changed = deepcopy(train)
    seed_ids = set(first["folds"][0]["seed_track_ids"])
    for row in changed:
        if row["trackId"] not in seed_ids:
            row["features"]["values"] = {"saved_age_days": 1e30, "recent_play_count": 1e20}
    second = benchmark._learning_curves([(0, 0, changed, evaluate)], 42)
    assert first["folds"][0]["frozen_preprocessing_medians"] == second["folds"][0]["frozen_preprocessing_medians"]
    for name in ("E2_batch", "C1_batch", "SGD_incremental", "SGD_replay"):
        assert first["points"][0]["models"][name]["predictions"] == second["points"][0]["models"][name]["predictions"]


def test_saved_predictions_can_be_summarized_and_paired_without_refitting(monkeypatch):
    rows = [{"track_id": f"demo:{i}", "label": i % 2, "probability": .5,
             "repeat": repeat, "fold": 0} for repeat in range(2) for i in range(6)]
    summary = benchmark.summarize_predictions(rows)
    assert summary["unique_evaluation_tracks"] == 6
    assert summary["prediction_count"] == 12
    assert summary["metrics"]["roc_auc"] == .5
    paired = benchmark.paired_log_loss(rows, rows[::-1])
    assert paired["delta"] == paired["low"] == paired["high"] == 0
    with pytest.raises(ValueError, match="identical evaluation"):
        benchmark.paired_log_loss(rows, rows[:-1])
    single_repeat = benchmark.paired_log_loss(rows[:6], rows[:6])
    assert single_repeat["unique_evaluation_tracks"] == paired["unique_evaluation_tracks"]


def test_metrics_match_independent_sklearn_reference_with_ties():
    y = np.array([0, 1, 0, 1, 0, 1, 1, 0])
    p = np.array([.1, .2, .2, .4, .7, .7, .9, .9])
    actual = benchmark._metrics(y, p)
    assert actual["roc_auc"] == pytest.approx(roc_auc_score(y, p))
    assert actual["average_precision"] == pytest.approx(average_precision_score(y, p))
    assert actual["log_loss"] == pytest.approx(log_loss(y, p))
    assert actual["brier"] == pytest.approx(brier_score_loss(y, p))
    for k in benchmark.RANK_K:
        assert actual[f"ndcg_at_{k}"] == pytest.approx(ndcg_score(y[None, :], p[None, :], k=k, ignore_ties=False))


def test_repeating_identical_predictions_does_not_narrow_track_cluster_interval():
    left = [{"track_id": f"demo:{i}", "label": i % 2, "probability": .5,
             "repeat": 0, "fold": 0} for i in range(8)]
    right = deepcopy(left)
    for i, row in enumerate(right):
        row["probability"] = .1 + .1 * i
    single = benchmark.paired_log_loss(left, right)
    doubled_left = left + [{**row, "repeat": 1} for row in left]
    doubled_right = right + [{**row, "repeat": 1} for row in right]
    repeated = benchmark.paired_log_loss(doubled_left, doubled_right)
    for key in ("delta", "low", "high"):
        assert single[key] == repeated[key]


def test_learning_intervals_preserve_unavailable_metrics_and_pair_same_tracks():
    train, evaluation = examples(20), examples(4, "holdout", 100)
    for row in evaluation:
        row["label"] = 0
    result = benchmark._learning_curves([(0, 0, train, evaluation)], seed=42)
    for summary in result["summary"]:
        for model in summary["models"].values():
            assert model["metrics"]["roc_auc"] is None
            assert model["intervals"]["roc_auc"] == {"low": None, "high": None, "valid_bootstrap_draws": 0}
            assert np.isfinite(model["intervals"]["log_loss"]["low"])
    for contrast in result["endpoint_contrasts"].values():
        assert contrast["unique_evaluation_tracks"] == contrast["prediction_count"] == 4
        assert contrast["first_n_train"] == 12
        assert contrast["last_n_train"] == 20
        assert all(np.isfinite(contrast[key]) for key in ("delta", "low", "high"))
    assert benchmark._learning_curves([], seed=42)["endpoint_contrasts"] == {}
    json.dumps(result, allow_nan=False)
