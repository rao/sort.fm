"""Simulation invariants: no counterfactual leakage, equal budgets and replay."""

from copy import deepcopy
import json
from pathlib import Path
import subprocess
import sys

import numpy as np
import pytest


def simulator():
    from sortfm_ml import simulate
    return simulate


def test_environment_is_seeded_with_disjoint_holdout_and_missing_observations():
    sim = simulator()
    world = sim.generate_environment(seed=7, size=100, holdout_size=50)
    assert world == sim.generate_environment(seed=7, size=100, holdout_size=50)
    assert world != sim.generate_environment(seed=8, size=100, holdout_size=50)
    ids = {row["trackId"] for row in world["candidates"]}
    assert ids == set(world["outcomes"])
    assert not ids.intersection(row["trackId"] for row in world["holdout"])
    assert all(row["split"] == "holdout" for row in world["holdout"])
    assert any(None in row["features"]["values"].values() for row in world["candidates"])
    assert any(not row["artistIds"] for row in world["candidates"])
    assert any(row["skip"] for row in world["outcomes"].values())
    assert any(.4 < row["latentRemovalProbability"] < .6 for row in world["outcomes"].values())
    assert all(0 <= row["usefulness"] <= 1 for row in world["outcomes"].values())


@pytest.mark.parametrize("kwargs", [{"size": 0}, {"holdout_size": -1}, {"size": True}])
def test_invalid_environment_size_is_rejected(kwargs):
    with pytest.raises(ValueError):
        simulator().generate_environment(**kwargs)


@pytest.mark.parametrize("policy", ["c1", "random", "epsilon_greedy", "linucb"])
def test_every_exposure_costs_budget_without_repeats_and_skip_never_trains(policy):
    sim = simulator()
    world = sim.generate_environment(seed=7, size=32, holdout_size=25)
    # A deterministic no-feedback environment catches fabricated skip rewards.
    for outcome in world["outcomes"].values():
        outcome["skip"] = True
    result = sim.run_policy(world, policy, budget=12)
    assert result["policyMetrics"]["exposures"] == 12
    assert result["policyMetrics"]["skips"] == 12
    assert result["policyMetrics"]["completedReviews"] == 0
    assert result["policyMetrics"]["cumulativeReward"] == 0
    assert result["policyMetrics"]["usefulReviewRate"] == 0
    assert result["predictiveMetrics"]["trainedExamples"] == 0
    assert result["predictiveMetrics"]["brierScore"] is None
    assert len({row["trackId"] for row in result["decisions"]}) == 12
    assert all(row["reward"] is None and row["label"] is None for row in result["decisions"])


def test_exposure_reward_uses_frozen_c1_probability_and_has_no_deletion_bonus():
    sim = simulator()
    world = sim.generate_environment(seed=12, size=55, holdout_size=30)
    # Ensure feedback eligibility, including both label classes, independent of utility.
    for i, outcome in enumerate(world["outcomes"].values()):
        outcome.update(skip=False, label=i % 2, usefulness=.4)
    result = sim.run_policy(world, "random", budget=35)
    assert result["predictiveMetrics"]["trainedExamples"] == 35
    assert result["predictiveMetrics"]["status"] == "available"
    assert result["decisions"][0]["frozenRemovalProbability"] is None
    assert result["decisions"][0]["reward"] == pytest.approx(.3)
    assert any(row["frozenRemovalProbability"] is not None for row in result["decisions"])
    for row in result["decisions"]:
        probability = row["frozenRemovalProbability"]
        correction = 0 if probability is None else (row["label"] - probability) ** 2
        assert row["reward"] == pytest.approx(.3 + .25 * correction)
        assert row["correctionSignal"] == pytest.approx(correction)
    assert result["policyMetrics"]["cumulativeReward"] == pytest.approx(sum(row["reward"] for row in result["decisions"]))


def test_hidden_holdout_labels_and_features_cannot_change_adaptive_selections():
    sim = simulator()
    world = sim.generate_environment(seed=31, size=55, holdout_size=30)
    original = deepcopy(world)
    first = sim.run_policy(world, "linucb", budget=25)
    assert world == original
    for row in world["holdout"]:
        row["label"] = 1 - row["label"]
        row["features"]["values"] = {"energy": 1., "saved_age_days": 99999.}
    changed = sim.run_policy(world, "linucb", budget=25)
    assert first["decisions"] == changed["decisions"]
    assert first["policyMetrics"] == changed["policyMetrics"]
    assert first["trainingTrackIds"] == changed["trainingTrackIds"]


def test_unselected_counterfactual_outcomes_are_invisible_to_the_policy():
    sim = simulator()
    world = sim.generate_environment(seed=19, size=50, holdout_size=25)
    first = sim.run_policy(world, "linucb", budget=18)
    selected = {row["trackId"] for row in first["decisions"]}
    for track_id, outcome in world["outcomes"].items():
        if track_id not in selected:
            outcome.update(label=1 - outcome["label"], usefulness=1 - outcome["usefulness"], skip=not outcome["skip"])
    second = sim.run_policy(world, "linucb", budget=18)
    assert first["decisions"] == second["decisions"]
    assert first["predictiveMetrics"] == second["predictiveMetrics"]


def test_all_policies_receive_common_outcomes_and_equal_budget():
    sim = simulator()
    report = sim.run_simulation(seeds=[5, 13], size=40, budget=18, holdout_size=25)
    assert len(report["runs"]) == 8
    by_seed = {}
    for run in report["runs"]:
        assert run["policyMetrics"]["exposures"] == 18
        by_seed.setdefault(run["seed"], []).append(run)
    for seed, runs in by_seed.items():
        world = sim.generate_environment(seed=seed, size=40, holdout_size=25)
        assert len({run["environmentDigest"] for run in runs}) == 1
        assert len({run["holdoutDigest"] for run in runs}) == 1
        for run in runs:
            for row in run["decisions"]:
                outcome = world["outcomes"][row["trackId"]]
                assert row["label"] == (None if outcome["skip"] else outcome["label"])
                assert row["usefulness"] == (None if outcome["skip"] else outcome["usefulness"])
    for summary in report["summary"]:
        rewards = [run["policyMetrics"]["cumulativeReward"] for run in report["runs"] if run["policy"] == summary["policy"]]
        assert summary["cumulativeReward"]["mean"] == pytest.approx(np.mean(rewards))
        assert summary["cumulativeReward"]["sampleStd"] == pytest.approx(np.std(rewards, ddof=1))
        assert summary["cumulativeReward"]["count"] == 2


def test_seed_replay_is_exact_and_ignores_global_numpy_rng():
    sim = simulator()
    np.random.seed(300)
    first = sim.run_simulation(seeds=[9], size=28, budget=10, holdout_size=22)
    np.random.seed(892)
    second = sim.run_simulation(seeds=[9], size=28, budget=10, holdout_size=22)
    assert first == second
    assert all(row["cumulativeReward"]["sampleStd"] is None for row in first["summary"])
    json.dumps(first, allow_nan=False)


@pytest.mark.parametrize("kwargs", [{"seeds": []}, {"seeds": [1, 1]}, {"budget": 0}, {"size": 12, "budget": 13}, {"alpha": -1}, {"epsilon": 2}])
def test_invalid_simulation_design_fails_explicitly(kwargs):
    with pytest.raises(ValueError):
        simulator().run_simulation(**kwargs)


def test_cli_writes_finite_replayable_json_and_human_report(tmp_path):
    output = tmp_path / "simulation.json"
    command = [sys.executable, "-m", "sortfm_ml.simulate", "--seeds", "2", "--size", "20", "--budget", "5", "--holdout-size", "20", "--output", str(output)]
    first = subprocess.run(command, capture_output=True, text=True)
    assert first.returncode == 0, first.stderr
    saved = output.read_text()
    assert len(json.loads(saved)["runs"]) == 4
    assert output.with_suffix(".md").is_file()
    second = subprocess.run(command, capture_output=True, text=True)
    assert second.returncode == 0, second.stderr
    assert output.read_text() == saved


def test_benchmark_measures_actual_cpu_stages_and_selection_replay(tmp_path):
    output = tmp_path / "benchmark.json"
    script = Path(__file__).resolve().parents[1] / "scripts" / "benchmark_bandit.py"
    command = [sys.executable, str(script), "--size", "40", "--training", "20", "--repeats", "2", "--output", str(output)]
    result = subprocess.run(command, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    report = json.loads(output.read_text())
    assert report["candidateCount"] == 40
    assert report["trainingExamples"] == 20
    assert report["selectionReplayExact"] is True
    assert len(report["runs"]) == 2
    for run in report["runs"]:
        assert run["fitSeconds"] > 0
        assert run["predictSeconds"] > 0
        assert run["contextSeconds"] > 0
        assert run["policyRebuildSeconds"] > 0
        assert run["selectionSeconds"] > 0
        assert run["fullSelectionSeconds"] == pytest.approx(sum(run[key] for key in ("predictSeconds", "contextSeconds", "policyRebuildSeconds", "selectionSeconds")))
    assert report["service"]["candidateCount"] == 40
    assert report["service"]["trainedRewards"] == 1
    assert report["service"]["feedbackTransport"] == "fit_then_associate"
    assert report["service"]["selectionReplayExact"] is True
    assert len(report["service"]["authenticatedAsgiSelectionSeconds"]) == 2
    assert all(value > 0 for value in report["service"]["authenticatedAsgiSelectionSeconds"])
