"""Numerical and behavioral checks for the separate review-usefulness policy."""

from copy import deepcopy
import math

import numpy as np
import pytest

from sortfm_ml.bandit import LinearUCB, build_context, context_names, select_candidate
from sortfm_ml.model import PreferenceModel
from test_model import candidate, labels


def test_linucb_matches_hand_solved_ridge_regression_and_logdet_gain():
    learner = LinearUCB(2, alpha=.5, ridge=2.)
    learner.fit(np.array([[1., 0.], [1., 1.]]), np.array([1., 0.]))
    # A=[[4,1],[1,3]], b=[1,0]; A^-1=[[3,-1],[-1,4]]/11.
    scores = learner.scores(np.array([[1., 0.], [0., 1.], [1., 1.]]))
    np.testing.assert_allclose(scores["mean"], [3 / 11, -1 / 11, 2 / 11])
    np.testing.assert_allclose(scores["uncertainty"], np.sqrt([3 / 11, 4 / 11, 5 / 11]))
    np.testing.assert_allclose(scores["bonus"], .5 * np.sqrt([3 / 11, 4 / 11, 5 / 11]))
    np.testing.assert_allclose(scores["score"], scores["mean"] + scores["bonus"])
    np.testing.assert_allclose(scores["informationGain"], .5 * np.log1p([3 / 11, 4 / 11, 5 / 11]))


def test_refit_rebuilds_statistics_for_undo_and_does_not_accumulate():
    learner = LinearUCB(2)
    learner.fit(np.array([[1., 0.], [0., 1.]]), np.array([1., 0.]))
    learner.fit(np.array([[0., 1.]]), np.array([0.]))
    scores = learner.scores(np.eye(2))
    np.testing.assert_array_equal(scores["mean"], [0., 0.])
    np.testing.assert_allclose(scores["uncertainty"], [1., math.sqrt(.5)])
    assert learner.n_observations == 1
    learner.fit(np.empty((0, 2)), np.empty(0))
    np.testing.assert_array_equal(learner.scores(np.eye(2))["uncertainty"], [1., 1.])
    assert learner.n_observations == 0


def test_repeated_context_reduces_only_observed_direction_uncertainty():
    learner = LinearUCB(2)
    learner.fit(np.tile([1., 0.], (99, 1)), np.ones(99))
    scores = learner.scores(np.eye(2))
    np.testing.assert_allclose(scores["mean"], [.99, 0.])
    np.testing.assert_allclose(scores["uncertainty"], [.1, 1.])


@pytest.mark.parametrize("kwargs", [{"dimension": 0}, {"dimension": True}, {"dimension": 1.5}, {"dimension": 2, "ridge": 0}, {"dimension": 2, "ridge": float("nan")}, {"dimension": 2, "alpha": -1}, {"dimension": 2, "alpha": float("inf")}])
def test_invalid_regularization_or_dimension_is_rejected(kwargs):
    with pytest.raises(ValueError):
        LinearUCB(**kwargs)


@pytest.mark.parametrize("contexts,rewards", [([[1., 2., 3.]], [1.]), ([[1., float("nan")]], [1.]), ([[1., 2.]], [float("inf")]), ([[1., 2.]], [1., 2.]), ([1., 2.], [1.])])
def test_invalid_fit_is_rejected_without_destroying_existing_fit(contexts, rewards):
    learner = LinearUCB(2).fit(np.eye(2), np.array([1., 0.]))
    before = learner.scores(np.eye(2))
    with pytest.raises(ValueError):
        learner.fit(np.asarray(contexts), np.asarray(rewards))
    for key, value in before.items():
        np.testing.assert_array_equal(learner.scores(np.eye(2))[key], value)


def test_scores_are_finite_for_collinear_data_and_do_not_mutate_input():
    context = np.tile([.5, .5], (200, 1))
    original = context.copy()
    learner = LinearUCB(2, ridge=.01).fit(context, np.ones(200))
    result = learner.scores(context)
    assert all(np.isfinite(value).all() for value in result.values())
    np.testing.assert_array_equal(context, original)
    assert all(value.shape == (0,) for value in learner.scores(np.empty((0, 2))).values())


@pytest.mark.parametrize("training", [[], labels()])
def test_context_is_named_bounded_immutable_and_aligned_by_track(training):
    model = PreferenceModel(training)
    candidates = [candidate("missing"), candidate("extreme", energy=100, duration_ms=1e99)]
    predictions = model.predict(candidates, "immutable")
    before = deepcopy(predictions)
    context = build_context(model, candidates, list(reversed(predictions)))
    names = context_names(model)
    assert names[:2] == ("bias", "c1_removal_probability_or_heuristic")
    assert names[2:] == model.pipeline.feature_names
    assert context.shape == (2, len(names))
    assert np.isfinite(context).all()
    assert np.all(np.linalg.norm(context, axis=1) <= 1. + 1e-15)
    score = predictions[0]["prediction"]["removalProbability"]
    score = predictions[0]["prediction"]["heuristicScore"] if score is None else score
    assert context[0, 1] / context[0, 0] == pytest.approx(score)
    np.testing.assert_array_equal(context, build_context(model, candidates, predictions))
    assert predictions == before
    assert build_context(model, [], []).shape == (0, len(names))


def test_context_rejects_misaligned_duplicate_or_nonfinite_predictions():
    model = PreferenceModel([])
    candidates = [candidate("a"), candidate("b")]
    predictions = model.predict(candidates, "v")
    with pytest.raises(ValueError):
        build_context(model, candidates, predictions[:1])
    with pytest.raises(ValueError):
        build_context(model, candidates, predictions[:1] * 2)
    predictions[0]["prediction"]["heuristicScore"] = float("nan")
    with pytest.raises(ValueError):
        build_context(model, candidates, predictions)


def selection_fixture():
    candidates = [candidate("a"), candidate("b"), candidate("c")]
    predictions = PreferenceModel([]).predict(candidates, "v")
    for row, probability in zip(predictions, [.7, .5, .2]):
        row["prediction"].update(removalProbability=probability, heuristicScore=None)
    contexts = np.array([[1., 0.], [0., 1.], [-1., 0.]])
    learner = LinearUCB(2, alpha=2.).fit(np.tile([1., 0.], (9, 1)), np.ones(9))
    return candidates, predictions, contexts, learner


def choose(*, config=None, history=None, step=0, seed=42):
    return select_candidate(*selection_fixture(), seed=seed, step=step, config={"strategy": "linucb", "maxExplorationFraction": 1., **(config or {})}, history=history or [])


def test_ucb_explores_underrepresented_direction_and_alpha_zero_exploits():
    result = choose()
    assert result["trackId"] == "demo:b"
    assert result["greedyTrackId"] == "demo:a"
    assert result["strategy"] == "explore"
    assert result["predictedReward"] == 0
    assert result["baselineScore"] == .5
    assert result["selectionScore"] == 2.
    assert result["uncertainty"] == 1.
    assert result["informationGain"] == pytest.approx(.5 * math.log(2))
    assert result["propensityEstimate"] is None
    exploited = choose(config={"alpha": 0})
    assert exploited["trackId"] == "demo:a"
    assert exploited["strategy"] == "exploit"


def test_exploration_budget_is_an_exact_prefix_cap_including_history():
    history = []
    for step in range(40):
        result = choose(config={"maxExplorationFraction": .25}, step=step, history=history)
        history.append(result)
        assert sum(row["strategy"] == "explore" for row in history) <= math.floor(.25 * (step + 1))
    assert sum(row["strategy"] == "explore" for row in history) == 10


def test_obvious_keep_protection_only_restricts_exploration_when_alternatives_exist():
    candidates, predictions, contexts, learner = selection_fixture()
    predictions[1]["prediction"]["removalProbability"] = .01
    protected = select_candidate(candidates, predictions, contexts, learner, seed=42, step=0, config={"maxExplorationFraction": 1, "obviousKeepThreshold": .1}, history=[])
    assert protected["trackId"] == "demo:a"
    assert "obvious_keep_exploration_protection" in protected["reasons"]
    for row in predictions:
        row["prediction"]["removalProbability"] = .01
    relaxed = select_candidate(candidates, predictions, contexts, learner, seed=42, step=0, config={"maxExplorationFraction": 1, "obviousKeepThreshold": .1}, history=[])
    assert relaxed["trackId"] == "demo:b"
    assert "all_candidates_obvious_keeps" in relaxed["reasons"]


def test_artist_diversity_applies_recent_window_and_relaxes_only_if_impossible():
    candidates, predictions, contexts, learner = selection_fixture()
    candidates[0]["artistIds"] = ["artist-x"]
    candidates[1]["artistIds"] = ["artist-y"]
    candidates[2]["artistIds"] = ["artist-z"]
    config = {"alpha": 0, "diversityWindow": 2, "maxPerArtist": 1, "maxExplorationFraction": 1.}
    history = [{"trackId": "prior", "artistIds": ["artist-x"], "strategy": "exploit"}]
    selected = select_candidate(candidates, predictions, contexts, learner, seed=2, step=1, config=config, history=history)
    assert selected["trackId"] == "demo:b"
    assert selected["strategy"] == "exploit"
    assert "artist_diversity_applied" in selected["reasons"]
    for row in candidates:
        row["artistIds"] = ["artist-x"]
    relaxed = select_candidate(candidates, predictions, contexts, learner, seed=2, step=1, config=config, history=history)
    assert relaxed["trackId"] == "demo:a"
    assert "artist_diversity_relaxed_no_eligible_candidate" in relaxed["reasons"]
    old = history + [{"strategy": "exploit"}, {"strategy": "exploit"}]
    selected = select_candidate(candidates, predictions, contexts, learner, seed=2, step=3, config=config, history=old)
    assert selected["trackId"] == "demo:a"


def test_seeded_choices_are_stable_under_candidate_order_and_global_rng():
    candidates, predictions, contexts, learner = selection_fixture()
    config = {"strategy": "random", "maxExplorationFraction": 1., "obviousKeepThreshold": 0.}
    original = deepcopy((candidates, predictions))
    seen = set()
    for seed in [-1, 0, 1, 2, 3, 2**40]:
        first = select_candidate(candidates, predictions, contexts, learner, seed=seed, step=8, config=config, history=[])
        np.random.seed(145)
        second = select_candidate(list(reversed(candidates)), list(reversed(predictions)), contexts[::-1], learner, seed=seed, step=8, config=config, history=[])
        assert first["trackId"] == second["trackId"]
        assert first["selectionScore"] == second["selectionScore"]
        assert first["propensityEstimate"] == pytest.approx(1 / 3)
        seen.add(first["trackId"])
    assert len(seen) > 1
    assert (candidates, predictions) == original


def test_epsilon_greedy_reports_marginal_action_probability_not_branch_probability():
    seen = set()
    for seed in range(30):
        result = choose(seed=seed, config={"strategy": "epsilon_greedy", "epsilon": .4, "obviousKeepThreshold": 0.})
        expected = .6 + .4 / 3 if result["trackId"] == "demo:a" else .4 / 3
        assert result["propensityEstimate"] == pytest.approx(expected)
        seen.add(result["trackId"])
    assert seen == {"demo:a", "demo:b", "demo:c"}
    capped = choose(config={"strategy": "epsilon_greedy", "epsilon": 1., "maxExplorationFraction": 0.})
    assert capped["trackId"] == "demo:a"
    assert capped["propensityEstimate"] == 1.


@pytest.mark.parametrize("strategy,observations", [("c1", True), ("linucb", False)])
def test_c1_disabled_and_zero_feedback_use_exact_supplied_c1_order(strategy, observations):
    candidates, predictions, contexts, learner = selection_fixture()
    if not observations:
        learner.fit(np.empty((0, 2)), np.empty(0))
    for row in candidates:
        row["artistIds"] = ["same"]
    result = select_candidate(candidates, predictions, contexts, learner, seed=42, step=0, config={"strategy": strategy, "maxPerArtist": 1}, history=[{"artistIds": ["same"]}], fallback_order=["demo:c", "demo:b", "demo:a"])
    assert result["trackId"] == "demo:c"
    assert result["selectionMethod"] == "c1"
    assert result["strategy"] == "exploit"
    assert result["propensityEstimate"] is None


@pytest.mark.parametrize("config", [{"strategy": "unknown"}, {"alpha": -1}, {"epsilon": 1.01}, {"maxExplorationFraction": -.1}, {"obviousKeepThreshold": float("nan")}, {"diversityWindow": -1}, {"maxPerArtist": 0}])
def test_selector_rejects_invalid_configuration(config):
    with pytest.raises(ValueError):
        choose(config=config)


def test_empty_candidates_are_explicitly_rejected():
    with pytest.raises(ValueError):
        select_candidate([], [], np.empty((0, 2)), LinearUCB(2), seed=0, step=0, config={}, history=[])
