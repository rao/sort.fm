"""Offline, single-user benchmark. Private output contains track identifiers.

No model or recipe is chosen using the monitoring holdout. All recipes and
learning-curve sizes are fixed here. Repeated CV uses only permitted ``train``
rows. Caller-provided audio enrichment must be label-independent and completed
before calling this module. This is an association benchmark, not a causal or
prospective estimate of listening utility.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime
from time import perf_counter

import numpy as np
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.linear_model import SGDClassifier
from sklearn.model_selection import StratifiedKFold

from .features import AUDIO_KEYS, FeaturePipeline
from .model import MODEL_RECIPE, PreferenceModel

BOOTSTRAP_REPLICATES = 400
RANK_K = (5, 10, 20)
MODEL_NAMES = {
    "E0": "constant training-class prior",
    "E1": "C1 saved-age logistic",
    "E2": "C1 metadata/history logistic",
    "E3": "C1 metadata/history + audio logistic",
    "E4": "small regularized gradient-boosted trees",
    "E5": "personalized missing-aware k-nearest neighbors",
    "C1": "existing full C1 personalized-centroid logistic",
}
LEARNING_SIZES = (12, 20, 30, 40, 60, 80, 120, 160, 240, 400)


def _counts(rows):
    labels = [row["label"] for row in rows]
    return {"total": len(labels), "keep": labels.count(0), "remove": labels.count(1)}


def _prepare(examples):
    eligible, excluded = [], Counter()
    users = {row.get("userId") for row in examples if row.get("userId") is not None}
    if len(users) > 1:
        raise ValueError("The benchmark accepts one user at a time")
    for row in examples:
        if isinstance(row.get("label"), bool) or row.get("label") not in (0, 1):
            excluded["missing_or_invalid_label"] += 1
        elif row.get("split") not in ("train", "holdout"):
            excluded["unknown_split"] += 1
        elif row.get("features", {}).get("permittedForTraining") is not True:
            excluded["not_permitted"] += 1
        else:
            eligible.append(row)
    ids = [row["trackId"] for row in eligible]
    if len(set(ids)) != len(ids):
        raise ValueError("Resolve duplicate active track IDs before benchmarking; no track may cross folds or splits")
    train = sorted((row for row in eligible if row["split"] == "train"), key=lambda row: row["trackId"])
    holdout = sorted((row for row in eligible if row["split"] == "holdout"), key=lambda row: row["trackId"])
    return train, holdout, dict(excluded)


def _prior(train):
    return float(np.mean([row["label"] for row in train])) if train else .5


class MissingAwareKNN:
    """Train-scaled joint-observation distances, fixed k=5, prior strength=2.

    Matching training IDs are excluded from both neighbors and smoothing prior.
    A pair with no jointly observed descriptors has no distance and is skipped.
    Labels, supplied centroid fields and missingness masks are never predictors.
    Ties at the kth distance share the remaining neighbor weight equally.
    """

    def fit(self, train):
        self.pipeline = FeaturePipeline("audio")
        self.pipeline.fit_transform(train)
        self.values = np.clip((self.pipeline.values(train) - self.pipeline.medians_) / self.pipeline.scales_, -8, 8)
        self.labels = np.asarray([row["label"] for row in train], dtype=float)
        self.ids = np.asarray([row["trackId"] for row in train])
        return self

    def predict(self, rows):
        values = np.clip((self.pipeline.values(rows) - self.pipeline.medians_) / self.pipeline.scales_, -8, 8)
        result = []
        for row, value in zip(rows, values):
            eligible = self.ids != row["trackId"]
            prior = float(np.mean(self.labels[eligible])) if eligible.any() else .5
            difference = self.values - value
            shared = np.isfinite(difference).sum(axis=1)
            distance = np.sqrt(np.divide(np.nansum(difference ** 2, axis=1), shared,
                                         out=np.full(len(shared), np.inf), where=shared > 0))
            valid = eligible & np.isfinite(distance)
            if not valid.any():
                result.append(prior)
                continue
            k = min(5, int(valid.sum()))
            cutoff = np.sort(distance[valid])[k - 1]
            closer, tied = valid & (distance < cutoff), valid & (distance == cutoff)
            mass = closer.astype(float) + tied * ((k - closer.sum()) / tied.sum())
            weights = np.divide(mass, 1 + distance, out=np.zeros(len(distance)), where=np.isfinite(distance))
            result.append(float((np.dot(weights, self.labels) + 2 * prior) / (weights.sum() + 2)))
        return np.asarray(result)


def _fit_predict(name, train, evaluation, seed):
    if any(row.get("split") != "train" for row in train):
        raise ValueError("A benchmark estimator may only fit split=train rows")
    prior = np.full(len(evaluation), _prior(train))
    if name == "E0":
        return prior, "constant_train_prior"
    if name in ("E1", "E2", "E3", "C1"):
        group = {"E1": "age", "E2": "history", "E3": "audio", "C1": "personalized"}[name]
        model = PreferenceModel(train, seed=seed, feature_group=group)
        if model.classifier is None:
            return prior, "constant_train_prior_fallback"
        context = model.transform_context(evaluation) * model.predictor_mask_
        return model.classifier.predict_proba(context)[:, 1], "logistic"
    if name == "E4":
        labels = np.asarray([row["label"] for row in train])
        if len(train) < 12 or min(int((labels == c).sum()) for c in (0, 1)) < 3:
            return prior, "constant_train_prior_fallback"
        pipeline = FeaturePipeline("audio")
        x = pipeline.fit_transform(train)[:, :len(pipeline.value_names)]
        test = pipeline.transform(evaluation)[:, :len(pipeline.value_names)]
        # Match the existing C1 audio-support rule; do not train on provider masks.
        for column, key in enumerate(pipeline.value_names):
            observed = np.isfinite(pipeline.training_values_[:, column])
            support = [int(np.sum(observed & (labels == c))) for c in (0, 1)]
            if key in AUDIO_KEYS and (sum(support) < 12 or min(support) < 3):
                x[:, column], test[:, column] = 0, 0
        classifier = GradientBoostingClassifier(n_estimators=40, learning_rate=.03,
                                               max_depth=2, min_samples_leaf=5,
                                               subsample=1., random_state=seed)
        classifier.fit(x, labels)
        return classifier.predict_proba(test)[:, 1], "gradient_boosting"
    if name == "E5":
        return MissingAwareKNN().fit(train).predict(evaluation), "missing_aware_knn"
    raise ValueError(f"Unknown benchmark model: {name}")


def _metrics(labels, probabilities):
    """Binary metrics; ranking ties use expected relevance within each tie block.

    AP is non-interpolated average precision, not trapezoidal PR area. For k>n,
    ranking metrics use min(k,n). ROC/AP/NDCG require their defining classes;
    unavailable values are None. All tied ranks are permutation invariant.
    """
    y = np.asarray(labels, dtype=float)
    p = np.asarray(probabilities, dtype=float)
    names = ["roc_auc", "average_precision", "log_loss", "brier"]
    names += [f"{metric}_at_{k}" for k in RANK_K for metric in ("precision", "ndcg")]
    if not len(y):
        return dict.fromkeys(names)
    if not np.isfinite(p).all() or (p < 0).any() or (p > 1).any():
        raise ValueError("Estimator returned invalid probabilities")
    clipped = np.clip(p, 1e-15, 1 - 1e-15)
    result = {"log_loss": float(-np.mean(y * np.log(clipped) + (1 - y) * np.log1p(-clipped))),
              "brier": float(np.mean((y - p) ** 2))}
    order = np.argsort(-p, kind="stable")
    sorted_p, sorted_y = p[order], y[order]
    starts = np.r_[0, np.flatnonzero(np.diff(sorted_p)) + 1]
    sizes = np.diff(np.r_[starts, len(y)])
    positives = np.add.reduceat(sorted_y, starts)
    negatives = sizes - positives
    total_positive = float(y.sum())
    total_negative = len(y) - total_positive
    cumulative_positive = np.cumsum(positives)
    cumulative_count = np.cumsum(sizes)
    result["average_precision"] = float(np.sum((positives / total_positive) * (cumulative_positive / cumulative_count))) if total_positive else None
    result["roc_auc"] = float(np.sum(positives * (total_negative - np.cumsum(negatives) + .5 * negatives)) / (total_positive * total_negative)) if total_positive and total_negative else None
    expected_relevance = np.repeat(positives / sizes, sizes)
    for k in RANK_K:
        actual_k = min(k, len(y))
        discount = 1 / np.log2(np.arange(actual_k) + 2)
        result[f"precision_at_{k}"] = float(np.mean(expected_relevance[:actual_k]))
        ideal = discount[:min(int(total_positive), actual_k)].sum()
        result[f"ndcg_at_{k}"] = float(np.dot(expected_relevance[:actual_k], discount) / ideal) if ideal else None
    return result


def _mean_metrics(metrics):
    return {key: float(np.mean([m[key] for m in metrics if m[key] is not None]))
            if any(m[key] is not None for m in metrics) else None for key in metrics[0]} if metrics else {}


def _prediction_records(rows, probabilities, repeat, fold):
    return [{"track_id": row["trackId"], "label": int(row["label"]),
             "probability": float(probability), "repeat": repeat, "fold": fold}
            for row, probability in zip(rows, probabilities)]


def _fold_record(train, evaluation, repeat, fold):
    return {"repeat": repeat, "fold": fold,
            "n_train": len(train), "n_evaluation": len(evaluation),
            "training_counts": _counts(train), "evaluation_counts": _counts(evaluation),
            "train_track_ids": [row["trackId"] for row in train],
            "evaluation_track_ids": [row["trackId"] for row in evaluation]}


def _bootstrap_and_summarize(models, seed, reference="E2"):
    """Resample unique tracks; reuse each track multiplicity in every CV repeat.

    Intervals condition on the fitted folds (models are not refitted) and are
    descriptive, not a correction for overlapping CV training sets. Each model
    and paired contrast receives the same bootstrap draws.
    """
    records = next(iter(models.values()))["predictions"]
    ids = sorted({p["track_id"] for p in records})
    id_index = {track_id: index for index, track_id in enumerate(ids)}
    record_ids = np.asarray([id_index[p["track_id"]] for p in records])
    labels = np.asarray([p["label"] for p in records])
    groups = defaultdict(list)
    for index, p in enumerate(records):
        groups[(p["repeat"], p["fold"])].append(index)
    groups = [np.asarray(indices) for indices in groups.values()]
    probabilities = {name: np.asarray([p["probability"] for p in model["predictions"]]) for name, model in models.items()}
    draws = {name: defaultdict(list) for name in models}
    differences = {name: [] for name in models if name != reference}
    rng = np.random.default_rng(seed)
    for _ in range(BOOTSTRAP_REPLICATES):
        multiplicity = np.bincount(rng.integers(len(ids), size=len(ids)), minlength=len(ids))
        sample_groups = [np.repeat(indices, multiplicity[record_ids[indices]]) for indices in groups]
        sample_groups = [indices for indices in sample_groups if len(indices)]
        metrics = {name: _mean_metrics([_metrics(labels[g], probability[g]) for g in sample_groups])
                   for name, probability in probabilities.items()}
        for name, values in metrics.items():
            for metric, value in values.items():
                if value is not None:
                    draws[name][metric].append(value)
            if name != reference:
                differences[name].append(values["log_loss"] - metrics[reference]["log_loss"])
    for name, model in models.items():
        p = probabilities[name]
        fold_metrics = [_metrics(labels[g], p[g]) for g in groups]
        model["metrics"] = _mean_metrics(fold_metrics)
        model["fold_metrics"] = fold_metrics
        model["metric_valid_fold_counts"] = {key: sum(m[key] is not None for m in fold_metrics) for key in model["metrics"]}
        model["intervals"] = {key: {"low": float(np.percentile(values, 2.5)),
                                     "high": float(np.percentile(values, 97.5)),
                                     "valid_bootstrap_draws": len(values)}
                              for key, values in draws[name].items()}
        by_track = defaultdict(list)
        for record in model["predictions"]:
            by_track[record["track_id"]].append(record)
        model["track_mean_oof_predictions"] = [
            {"track_id": track_id, "label": rows[0]["label"],
             "probability": float(np.mean([row["probability"] for row in rows])), "prediction_count": len(rows)}
            for track_id, rows in sorted(by_track.items())]
        model["pooled_track_mean_metrics_diagnostic"] = _metrics(
            [row["label"] for row in model["track_mean_oof_predictions"]],
            [row["probability"] for row in model["track_mean_oof_predictions"]])
    return {name: {"delta": models[name]["metrics"]["log_loss"] - models[reference]["metrics"]["log_loss"],
                   "low": float(np.percentile(values, 2.5)), "high": float(np.percentile(values, 97.5)),
                   "valid_bootstrap_draws": len(values),
                   "direction": f"negative favors this model; difference is model minus {reference}"}
            for name, values in differences.items()}


def summarize_predictions(predictions, seed=42):
    """Summarize saved predictions on a caller-filtered common evaluation set.

    No fitting occurs. Records use track_id, label, probability, repeat, fold.
    Filtering after prediction must be label-independent. This preserves the
    original training population and is appropriate for audio-coverage slices.
    """
    if not predictions:
        return {"status": "unavailable", "metrics": {}, "intervals": {}, "predictions": []}
    model = {"predictions": list(predictions)}
    _bootstrap_and_summarize({"model": model}, int(seed) % (2**32), reference="model")
    model["status"] = "available"
    model["unique_evaluation_tracks"] = len({p["track_id"] for p in predictions})
    model["prediction_count"] = len(predictions)
    return model


def paired_log_loss(left_predictions, right_predictions, seed=42):
    """Paired right-minus-left loss on identical predictions, clustered by track.

    Refuses unequal evaluation keys/labels instead of silently changing either
    population. Predictions need not be passed in the same order.
    """
    def keyed(rows):
        result = {(row["repeat"], row["fold"], row["track_id"]): row for row in rows}
        if len(result) != len(rows):
            raise ValueError("duplicate prediction keys")
        return result
    left, right = keyed(left_predictions), keyed(right_predictions)
    if left.keys() != right.keys():
        raise ValueError("Paired comparisons require identical evaluation populations")
    if not left:
        return {"status": "unavailable", "delta": None, "low": None, "high": None}
    keys = sorted(left)
    if any(left[key]["label"] != right[key]["label"] for key in keys):
        raise ValueError("Paired comparisons require identical labels")
    ids = sorted({key[2] for key in keys})
    lookup = {track_id: index for index, track_id in enumerate(ids)}
    track_indices = np.asarray([lookup[key[2]] for key in keys])
    groups = defaultdict(list)
    for i, key in enumerate(keys):
        groups[key[:2]].append(i)
    groups = [np.asarray(g) for g in groups.values()]
    y = np.asarray([left[key]["label"] for key in keys])
    losses = []
    for source in (left, right):
        p = np.asarray([source[key]["probability"] for key in keys])
        if not np.isfinite(p).all() or (p < 0).any() or (p > 1).any():
            raise ValueError("Invalid probability in paired comparison")
        p = np.clip(p, 1e-15, 1 - 1e-15)
        losses.append(-y * np.log(p) - (1 - y) * np.log1p(-p))
    difference = losses[1] - losses[0]
    rng = np.random.default_rng(int(seed) % (2**32))
    draws = []
    for _ in range(BOOTSTRAP_REPLICATES):
        multiplicity = np.bincount(rng.integers(len(ids), size=len(ids)), minlength=len(ids))
        weights = multiplicity[track_indices]
        draws.append(float(np.mean([np.average(difference[g], weights=weights[g]) for g in groups if weights[g].sum()])))
    return {"status": "available", "delta": float(np.mean([difference[g].mean() for g in groups])),
            "low": float(np.percentile(draws, 2.5)), "high": float(np.percentile(draws, 97.5)),
            "valid_bootstrap_draws": len(draws), "unique_evaluation_tracks": len(ids),
            "prediction_count": len(keys), "direction": "right minus left; negative favors right",
            "method": "fold-macro mean loss difference, 95% percentile bootstrap of unique tracks shared across repeats; conditional on fitted models"}


def _evaluate(folds, seed):
    if not folds:
        return {"status": "unavailable", "folds": [], "models": {},
                "reason": "No eligible evaluation folds"}
    models = {name: {"name": label, "predictions": [], "fit_counts": {}} for name, label in MODEL_NAMES.items()}
    fit_counts = {name: Counter() for name in models}
    fold_records = []
    for repeat, fold, train, evaluation in folds:
        fold_records.append(_fold_record(train, evaluation, repeat, fold))
        for name in models:
            probability, fit_kind = _fit_predict(name, train, evaluation, (seed + repeat * 101 + fold) % (2**32))
            models[name]["predictions"].extend(_prediction_records(evaluation, probability, repeat, fold))
            fit_counts[name][fit_kind] += 1
    for name in models:
        models[name]["fit_counts"] = dict(fit_counts[name])
    paired = _bootstrap_and_summarize(models, seed)
    return {"status": "available", "folds": fold_records, "models": models,
            "unique_evaluation_tracks": len({p["track_id"] for p in models["E0"]["predictions"]}),
            "prediction_count_per_model": len(models["E0"]["predictions"]),
            "metric_aggregation": "equal-weight mean of evaluation-fold metrics; each fold ranks only its own evaluation tracks",
            "interval_method": "95% percentile bootstrap of unique tracks, shared multiplicities across repeats and models; conditional on fitted folds, no model refits",
            "paired_log_loss_vs_E2": paired}


def _chronological_key(row):
    for field in ("labeledAt", "occurredAt", "createdAt"):
        try:
            value = row.get(field)
            if value:
                parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
                return (parsed.timestamp() if parsed.tzinfo else float("inf"), row["trackId"])
        except (ValueError, TypeError):
            pass
    return float("inf"), row["trackId"]


def _label_order(train, seed_per_class=None):
    ordered = sorted(train, key=_chronological_key)
    per_class = seed_per_class if seed_per_class is not None else min(6, min(sum(row["label"] == label for row in train) for label in (0, 1)))
    seed_rows = [row for label in (0, 1) for row in [r for r in ordered if r["label"] == label][:per_class]]
    seed_rows.sort(key=_chronological_key)
    ids = {row["trackId"] for row in seed_rows}
    return seed_rows, [row for row in ordered if row["trackId"] not in ids]


def _new_sgd(seed):
    return SGDClassifier(loss="log_loss", penalty="l2", alpha=.01,
                         learning_rate="constant", eta0=.01,
                         fit_intercept=True, shuffle=False, average=False,
                         random_state=seed)


def _sgd_update(classifier, x, labels, start=0):
    # One partial_fit call per label makes update sequences exactly identical
    # between streaming and replay; no sample is revisited by streaming.
    for index in range(start, len(labels)):
        classifier.partial_fit(x[index:index + 1], labels[index:index + 1], classes=np.array([0, 1]))


def _learning_curves(folds, seed):
    selected = [fold for fold in folds if fold[0] == 0]
    if not selected:
        return {"status": "unavailable", "points": [], "summary": [], "endpoint_contrasts": {},
                "reason": "Train-only CV unavailable"}
    points, fold_records = [], []
    seed_per_class = min(6, min(sum(row["label"] == label for row in train)
                               for _, _, train, _ in selected for label in (0, 1)))
    common_max = min(len(train) for _, _, train, _ in selected)
    common_sizes = sorted({2 * seed_per_class, common_max} |
                          {n for n in LEARNING_SIZES if 2 * seed_per_class <= n <= common_max})
    for repeat, fold, train, evaluation in selected:
        initial, remainder = _label_order(train, seed_per_class)
        if len(initial) < 2:
            continue
        ordered = initial + remainder
        fold_seed = (seed + fold) % (2**32)
        preprocess_start = perf_counter()
        pipeline = FeaturePipeline("history")
        pipeline.fit_transform(initial)
        width = len(pipeline.value_names)
        # Transforming future labels does not update preprocessing. It depends
        # only on their pre-label values; each update consumes only its prefix.
        x = pipeline.transform(ordered)[:, :width]
        test_x = pipeline.transform(evaluation)[:, :width]
        preprocess_seconds = perf_counter() - preprocess_start
        labels = np.asarray([row["label"] for row in ordered])
        sizes = sorted(set(common_sizes) | {len(ordered)})
        incremental = _new_sgd(fold_seed)
        processed, incremental_time, replay_cumulative_time, replay_seen = 0, 0., 0., 0
        record = _fold_record(train, evaluation, repeat, fold)
        record.update(seed_track_ids=[row["trackId"] for row in initial],
                      ordered_training_track_ids=[row["trackId"] for row in ordered],
                      frozen_preprocessing_medians=pipeline.medians_.tolist(),
                      frozen_preprocessing_scales=pipeline.scales_.tolist(),
                      preprocessing_seconds=preprocess_seconds, size_grid=sizes)
        fold_records.append(record)
        for size in sizes:
            point = {"repeat": repeat, "fold": fold, "n_train": size, "n_eval": len(evaluation),
                     "on_common_size_grid": size in common_sizes,
                     "train_track_ids": [row["trackId"] for row in ordered[:size]],
                     "evaluation_track_ids": [row["trackId"] for row in evaluation],
                     "models": {}}
            for batch_name, feature_group in (("E2_batch", "history"), ("C1_batch", "personalized")):
                start = perf_counter()
                batch_model = PreferenceModel(ordered[:size], seed=fold_seed, feature_group=feature_group)
                elapsed = perf_counter() - start
                if batch_model.classifier is None:
                    batch, fit_kind = np.full(len(evaluation), _prior(ordered[:size])), "constant_train_prior_fallback"
                else:
                    batch_context = batch_model.transform_context(evaluation) * batch_model.predictor_mask_
                    batch, fit_kind = batch_model.classifier.predict_proba(batch_context)[:, 1], "logistic"
                point["models"][batch_name] = {"metrics": _metrics([r["label"] for r in evaluation], batch),
                                               "predictions": _prediction_records(evaluation, batch, repeat, fold),
                                               "fit_kind": fit_kind, "fit_seconds": elapsed,
                                               "training_rows_seen_this_step": size}
            start = perf_counter()
            _sgd_update(incremental, x[:size], labels[:size], processed)
            step_time = perf_counter() - start
            incremental_time += step_time
            p = incremental.predict_proba(test_x)[:, 1]
            point["models"]["SGD_incremental"] = {"metrics": _metrics([r["label"] for r in evaluation], p),
                                                   "predictions": _prediction_records(evaluation, p, repeat, fold),
                                                   "fit_seconds": step_time, "cumulative_fit_seconds": incremental_time,
                                                   "training_rows_seen_this_step": size - processed,
                                                   "cumulative_training_rows_seen": size}
            start = perf_counter()
            replay = _new_sgd(fold_seed)
            _sgd_update(replay, x[:size], labels[:size])
            step_time = perf_counter() - start
            replay_cumulative_time += step_time
            replay_seen += size
            p = replay.predict_proba(test_x)[:, 1]
            point["models"]["SGD_replay"] = {"metrics": _metrics([r["label"] for r in evaluation], p),
                                              "predictions": _prediction_records(evaluation, p, repeat, fold),
                                              "fit_seconds": step_time, "cumulative_fit_seconds": replay_cumulative_time,
                                              "training_rows_seen_this_step": size,
                                              "cumulative_training_rows_seen": replay_seen}
            processed = size
            points.append(point)
    summary, predictions_by_size = [], {}
    curve_models = ("E2_batch", "C1_batch", "SGD_incremental", "SGD_replay")
    for size in common_sizes:
        at_size = [p for p in points if p["n_train"] == size]
        predictions_by_size[size] = {
            name: [record for point in at_size for record in point["models"][name]["predictions"]]
            for name in curve_models}
        summaries = {name: summarize_predictions(predictions_by_size[size][name], seed=seed)
                     for name in curve_models}
        summary.append({"n_train": size, "evaluation_fold_count": len(at_size),
                        "models": {name: {"metrics": _mean_metrics([p["models"][name]["metrics"] for p in at_size]),
                                           "intervals": {metric: summaries[name]["intervals"].get(metric, {
                                               "low": None, "high": None, "valid_bootstrap_draws": 0})
                                               for metric in summaries[name]["metrics"]},
                                           "unique_evaluation_tracks": summaries[name]["unique_evaluation_tracks"],
                                           "prediction_count": summaries[name]["prediction_count"],
                                           "mean_fit_seconds": float(np.mean([p["models"][name]["fit_seconds"] for p in at_size]))}
                                   for name in curve_models}})
    endpoint_contrasts = {
        name: {**paired_log_loss(predictions_by_size[common_sizes[0]][name],
                                predictions_by_size[common_sizes[-1]][name], seed=seed),
               "first_n_train": common_sizes[0], "last_n_train": common_sizes[-1],
               "metric": "log_loss", "direction": "last minus first; negative favors the larger training prefix"}
        for name in curve_models} if points else {}
    return {"status": "available" if points else "unavailable", "folds": fold_records,
            "points": points, "summary": summary,
            "endpoint_contrasts": endpoint_contrasts,
            "interval_method": "95% percentile bootstrap of unique evaluation tracks; identical track draws across sizes and models. Models and folds are fixed, no refitting: conditional descriptive uncertainty, not independent-session or training-set uncertainty",
            "common_size_grid": common_sizes,
            "summary_population": "Every summary size includes every fixed CV evaluation fold; unequal per-fold endpoints remain in points only",
            "protocol": "first repeat of the same train-only stratified CV; evaluation tracks fixed and never added to a training prefix",
            "seed_policy": "earliest up to six labels per class form a balanced seed; remaining labels added chronologically; unavailable timestamps sort last by track ID",
            "preprocessing": "SGD metadata/history preprocessing is fitted once on the balanced seed and frozen; E2 and full personalized C1 batch refit their respective preprocessing on each prefix",
            "sgd_recipe": {"loss": "log_loss", "alpha": .01, "eta0": .01, "learning_rate": "constant", "epochs_per_label": 1, "shuffle": False},
            "interpretation": "incremental SGD and same-SGD full replay follow identical ordered updates and should have identical predictions; comparison isolates avoided computation. E2 and full personalized C1 differ in optimizer, regularization and preprocessing and are separate batch references",
            "production_update_behavior": "Existing production observe performs a full batch refit; it does not use partial_fit. SGD here is an experimental incremental candidate, not the deployed update rule",
            "time_caveat": "single-process wall time, no repetitions or warmup controls; all fit times exclude prediction. Batch models include their per-prefix preprocessing; SGD excludes its shared one-time frozen preprocessing, reported separately. Noisy engineering observations, not a performance benchmark",
            "temporal_caveat": "CV is label-sample efficiency on a fixed evaluation population, not prospective temporal validation. Balanced seeding selects known outcomes within training folds, an oracle stratified seed rather than an acquisition-cost estimate"}


def run_benchmarks(examples, seed=42, repeats=5):
    """Return JSON-serializable private metrics, fold/OOF data and learning curves.

    ``split=holdout`` is scored exactly once by each fixed recipe, only after
    recipes and CV folds are fixed. It is monitoring data, never tuning data or
    an untouched final holdout. A genuinely untouched final holdout is not
    supplied to this function. Resolve active-label identity before calling.
    """
    if not isinstance(repeats, int) or isinstance(repeats, bool) or repeats < 1:
        raise ValueError("repeats must be a positive integer")
    seed = int(seed) % (2**32)
    train, holdout, excluded = _prepare(examples)
    counts = _counts(train)
    n_splits = min(5, counts["keep"], counts["remove"])
    folds = []
    if n_splits >= 2:
        y = np.asarray([row["label"] for row in train])
        for repeat in range(repeats):
            splitter = StratifiedKFold(n_splits=n_splits, shuffle=True, random_state=(seed + repeat) % (2**32))
            for fold, (fit_indices, eval_indices) in enumerate(splitter.split(np.zeros(len(train)), y)):
                folds.append((repeat, fold, [train[i] for i in fit_indices], [train[i] for i in eval_indices]))
    cv = _evaluate(folds, seed)
    if not folds:
        cv["reason"] = "At least two permitted train labels from each class are required for stratified CV"
    monitoring = _evaluate([(0, 0, train, holdout)] if train and holdout else [], seed)
    monitoring["purpose"] = "fixed-recipe monitoring only; not used for hyperparameters, selection or final generalization claims"
    return {"schema_version": "sortfm.research-benchmark.v1", "private_output": True,
            "config": {"seed": seed, "repeats": repeats, "n_splits": n_splits if n_splits >= 2 else 0,
                       "bootstrap_replicates": BOOTSTRAP_REPLICATES, "confidence_level": .95,
                       "positive_label": "REMOVE=1", "c1_recipe": MODEL_RECIPE,
                       "metric_notes": "AP is non-interpolated average precision; P@k and NDCG@k use expected within-tie relevance and min(k,n); primary scores average folds, pooled OOF diagnostics can misrepresent fold-prior ranking",
                       "e4_recipe": {"n_estimators": 40, "max_depth": 2, "learning_rate": .03, "min_samples_leaf": 5},
                       "e5_recipe": {"k": 5, "prior_strength": 2, "features": "metadata/history/audio", "distance": "RMS on jointly observed train-scaled values", "weights": "1/(1+distance)"},
                       "selection": "none; all recipes fixed before evaluation",
                       "fallback": "E1-E4 and C1 use constant train prior when the existing C1 supervised floor is unavailable; no heuristic score is relabeled as probability"},
            "counts": {"input": len(examples), "train": counts, "holdout": _counts(holdout), "excluded": excluded},
            "protocols": {"train_repeated_stratified_cv": cv, "monitoring_holdout": monitoring},
            "learning_curves": _learning_curves(folds, seed)}
