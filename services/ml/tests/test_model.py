"""Behavioral regression tests for the per-user scoring boundary."""

from copy import deepcopy
import json
import math

import joblib
import numpy as np
import pytest

from sortfm_ml.model import PreferenceModel


def candidate(track_id, **values):
    return {
        "trackId": f"demo:{track_id}",
        "features": {
            "featureVersion": "sortfm.features.v1",
            "provenance": "synthetic",
            "permittedForTraining": True,
            "values": values,
        },
    }


def example(track_id, label, split="train", **values):
    return {
        **candidate(track_id, **values),
        "decisionId": f"00000000-0000-4000-8000-{int(track_id):012d}",
        "label": label,
        "split": split,
        "labeledAt": "2026-11-07T12:00:00Z",
    }


def labels(count=24, reverse=False):
    return [
        example(i, int((i % 2 == 1) != reverse), energy=0.1 if i % 2 == 0 else 0.9)
        for i in range(count)
    ]


@pytest.fixture
def model_type():
    return PreferenceModel


@pytest.mark.parametrize("training", [[], labels(10), [example(i, 1, energy=.9) for i in range(30)], [example(i, int(i < 2), energy=.5) for i in range(30)]])
def test_cold_start_and_sparse_classes_do_not_claim_probabilities(model_type, training):
    model = model_type(training)
    prediction = model.predict([candidate("new")], "cold-v1")[0]["prediction"]
    assert prediction["modelKind"] == "heuristic"
    assert prediction["removalProbability"] is None
    assert prediction["heuristicScore"] == .5
    assert prediction["uncertainty"] is None
    assert prediction["uncertaintyMethod"] == "none"
    assert prediction["calibrated"] is False
    assert prediction["trainedExamples"] == len(training)


def test_recent_affinity_is_only_a_small_prior_and_old_songs_are_neutral(model_type):
    model = model_type([])
    candidates = [candidate("old", saved_age_days=4000), candidate("older", saved_age_days=7000), candidate("recent", saved_age_days=0, recent_play_count=20), candidate("lifetime", top_track_long=1)]
    scores = [item["prediction"]["heuristicScore"] for item in model.predict(candidates, "v0")]
    assert scores[0] == scores[1] == scores[3] == .5
    assert .3 <= scores[2] < .5


def test_supervised_model_learns_and_adapts_to_explicit_decisions(model_type):
    candidates = [candidate("quiet", energy=.1), candidate("loud", energy=.9)]
    model = model_type(labels())
    predicted = model.predict(candidates, "v1")
    assert model.model_kind == "logistic"
    assert predicted[0]["prediction"]["removalProbability"] < .3
    assert predicted[1]["prediction"]["removalProbability"] > .7
    changed = model_type(labels() + [example(i, 0, energy=.9) for i in range(24, 64)])
    assert changed.predict(candidates, "v2")[1]["prediction"]["removalProbability"] < predicted[1]["prediction"]["removalProbability"] - .15


def test_holdout_values_labels_and_unpermitted_examples_cannot_affect_fit(model_type):
    training = labels()
    holdouts = [example(100+i, i % 2, split="holdout", energy=.1 * i, saved_age_days=50000) for i in range(10)]
    denied = [example(200+i, 1, energy=1, recent_play_count=999999) for i in range(20)]
    for item in denied:
        item["features"]["permittedForTraining"] = False
    unlabeled = example(300, None, energy=.9)
    candidates = [candidate("score", energy=.75, saved_age_days=7)]
    original = model_type(training)
    contaminated = model_type(training + holdouts + denied + [unlabeled])
    assert contaminated.trained_examples == len(training)
    assert original.predict(candidates, "same") == contaminated.predict(candidates, "same")
    np.testing.assert_array_equal(original.transform_context(candidates), contaminated.transform_context(candidates))


def test_supplied_centroid_distances_are_never_trusted(model_type):
    clean = labels()
    poisoned = deepcopy(clean)
    for item in poisoned:
        item["features"]["values"].update(kept_centroid_distance=item["label"] * 99999, removed_centroid_distance=(1-item["label"]) * 99999)
    candidates = [candidate("target", energy=.4)]
    fake_candidates = deepcopy(candidates)
    fake_candidates[0]["features"]["values"].update(kept_centroid_distance=99999, removed_centroid_distance=0)
    one, two = model_type(clean), model_type(poisoned)
    assert one.predict(candidates, "v1") == two.predict(fake_candidates, "v1")


def test_missing_zero_extremes_and_empty_input_are_finite(model_type):
    model = model_type(labels())
    candidates = [candidate("missing"), candidate("zero", energy=0, instrumentalness=0, artist_library_count=0), candidate("extreme", energy=1e300, saved_age_days=1e300, duration_ms=1e300), candidate("invalid", energy=float("nan"), tempo_bpm=float("inf"))]
    context = model.transform_context(candidates)
    assert np.isfinite(context).all()
    assert not np.array_equal(context[0], context[1])
    predictions = model.predict(candidates, "v1")
    json.dumps(predictions, allow_nan=False)
    assert all(0 <= item["prediction"]["removalProbability"] <= 1 for item in predictions)
    assert model.predict([], "v1") == []
    assert model.transform_context([]).shape == (0, context.shape[1])


def test_all_missing_training_does_not_require_provider_features(model_type):
    model = model_type([example(i, i % 2) for i in range(24)])
    p = model.predict([candidate("new")], "v1")[0]["prediction"]
    assert p["modelKind"] == "logistic"
    assert p["removalProbability"] == pytest.approx(.5)


def test_train_centroids_exclude_target_and_missing_masks_are_always_present(model_type):
    # Two-point groups have a hand-checkable LOO distance: each point is one
    # whole group span from its other group member, never half that distance.
    rows = [example(0, 0, energy=0), example(1, 0, energy=.2), example(2, 1, energy=.8), example(3, 1, energy=1)]
    pipeline = model_type(rows).pipeline
    train = pipeline.training_values_
    keys = pipeline.value_names
    kept = keys.index("kept_centroid_distance")
    removed = keys.index("removed_centroid_distance")
    # For 0/.2/.8/1 energy, IQR is .7; RMS has one observed dimension.
    assert train[0, kept] == pytest.approx(.2 / .7)
    assert train[1, kept] == pytest.approx(.2 / .7)
    assert train[2, removed] == pytest.approx(.2 / .7)
    assert train[3, removed] == pytest.approx(.2 / .7)
    assert len(pipeline.feature_names) == 2 * len(keys)


def test_prediction_is_batch_order_independent_and_persisted_reload_identical(model_type, tmp_path):
    training = labels()
    one, two = model_type(training, seed=42), model_type(list(reversed(training)), seed=42)
    candidates = [candidate("low", energy=.2), candidate("high", energy=.8)]
    expected = one.predict(candidates, "immutable-v1")
    assert two.predict(candidates, "immutable-v1") == expected
    assert one.predict(list(reversed(candidates)), "immutable-v1") == list(reversed(expected))
    one.predict([candidate("huge", energy=1e99)], "different-version")
    np.testing.assert_array_equal(one.transform_context(candidates), two.transform_context(candidates))
    path = tmp_path / "model.joblib"
    joblib.dump(one, path)
    restored = joblib.load(path)
    assert restored.predict(candidates, "immutable-v1") == expected


def test_explanations_reconstruct_uncalibrated_log_odds(model_type):
    prediction = model_type(labels()).predict([candidate("x", energy=.65)], "v1")[0]["prediction"]
    terms = prediction["explanations"]
    logit = sum(term["contribution"] for term in terms if term["contribution"] is not None)
    assert 1 / (1 + math.exp(-logit)) == pytest.approx(prediction["removalProbability"])
    assert prediction["calibrated"] is False
    assert prediction["heuristicScore"] is None
    assert prediction["uncertaintyMethod"] == "entropy"
    assert 0 <= prediction["uncertainty"] <= 1
    assert any("not epistemic" in term["description"].lower() for term in terms)


def test_feature_groups_are_cumulative_and_have_no_scoring_fit(model_type):
    candidates = [candidate("x", energy=.5, saved_age_days=10)]
    widths = [model_type(labels(), feature_group=group).transform_context(candidates).shape[1] for group in ("metadata", "history", "audio", "personalized")]
    assert widths == sorted(set(widths))
    with pytest.raises(ValueError, match="feature group"):
        model_type(labels(), feature_group="unknown")


def test_baseline_ranking_selects_feature_diversity_deterministically(model_type):
    model = model_type([])
    candidates = [candidate("a", energy=0), candidate("b", energy=0), candidate("c", energy=1), candidate("recent", energy=.5, saved_age_days=0)]
    ranked = model.rank(candidates, "v0")
    assert len(ranked) == 4
    assert {row["trackId"] for row in ranked} == {row["trackId"] for row in candidates}
    assert ranked[:2] == model.rank(list(reversed(candidates)), "v0")[:2]
    assert ranked[1]["trackId"] == "demo:c"


def test_flipping_target_label_cannot_change_its_own_raw_centroid_distances(model_type):
    rows = [example(i, i % 2, energy=i / 20, danceability=(20-i) / 20) for i in range(12)]
    original = model_type(rows)
    changed = deepcopy(rows)
    changed[4]["label"] = 1 - changed[4]["label"]
    refit = model_type(changed)
    target = [candidate(4, energy=.2, danceability=.8)]
    np.testing.assert_allclose(original.pipeline.values(target)[:, -2:], refit.pipeline.values(target)[:, -2:], rtol=0, atol=1e-15)


def test_cold_rank_includes_recent_save_even_when_other_features_are_identical(model_type):
    candidates = [candidate(f"old-{i}", energy=.2) for i in range(30)]
    candidates.append(candidate("recent", energy=.2, saved_age_days=0))
    model = model_type([])
    selected = model.rank(candidates, "cold", limit=5)
    assert "demo:recent" in [row["trackId"] for row in selected]
    assert len(selected) == 5
    assert selected == model.rank(list(reversed(candidates)), "cold", limit=5)


def test_absent_audio_stays_missing_in_personalization(model_type):
    rows = [example(i, i % 2, saved_age_days=30 if i % 2 else 1000) for i in range(24)]
    model = model_type(rows)
    candidates = [candidate("empty"), candidate("history", saved_age_days=10)]
    raw = model.pipeline.values(candidates)
    assert np.isnan(raw[:, -2:]).all()
    context = model.transform_context(candidates)
    assert np.isfinite(context).all()
    np.testing.assert_array_equal(context[:, -2:], np.ones((2, 2)))
    json.dumps(model.predict(candidates, "no-audio"), allow_nan=False)


@pytest.mark.parametrize("seed", [-1, 2**40])
def test_all_contract_seed_integers_are_supported_reproducibly(model_type, seed):
    first, second = model_type(labels(), seed=seed), model_type(labels(), seed=seed)
    candidates = [candidate("new", energy=.7)]
    assert first.seed == seed
    assert first.predict(candidates, "v1") == second.predict(candidates, "v1")


def test_training_threshold_accepts_three_minority_labels(model_type):
    model = model_type([example(i, int(i < 3), energy=.9 if i < 3 else .1) for i in range(12)])
    assert model.model_kind == "logistic"
