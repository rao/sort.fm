"""Seeded synthetic sequential experiments, separate from off-policy evaluation.

All policies face the same generated potential outcomes per seed. Only chosen,
completed feedback is visible to learning; a disjoint holdout is evaluation-only.
The declared toy listener is not evidence about real listeners or calibration.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import platform
from uuid import NAMESPACE_URL, uuid5

import numpy as np
import sklearn

from .bandit import LinearUCB, build_context, context_names, select_candidate
from .cli import FEATURE_VERSION, FIXTURE_TIME, _feature_vector
from .evaluate import evaluate_model
from .model import PreferenceModel


POLICIES = ("c1", "random", "epsilon_greedy", "linucb")
DEFAULT_SEEDS = (11, 29, 47)
USEFUL_THRESHOLD = .6


def _digest(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def _positive_integer(value, name: str) -> None:
    if type(value) is not int or value < 1:
        raise ValueError(f"{name} must be a positive integer")


def generate_environment(seed: int = 11, size: int = 400, holdout_size: int = 150) -> dict:
    """Create independent library and holdout streams from a declared toy user.

    Utility rewards resolution of uncertain/neglected items, regardless of the
    resulting KEEP/REMOVE label. Labels, usefulness, missingness and skips are
    drawn before any policy runs. See docs/C2-evaluation.md for the equations.
    """
    _positive_integer(size, "size")
    _positive_integer(holdout_size, "holdout_size")
    if type(seed) is not int:
        raise ValueError("seed must be an integer")
    pool_stream, test_stream = np.random.SeedSequence(seed % (2**64)).spawn(2)

    def generate(stream, count: int, group: str):
        rng = np.random.default_rng(stream)
        candidates, outcomes = [], {}
        for index in range(count):
            age = float(min(rng.exponential(700), 5000))
            recent = int(rng.poisson(1.7))
            energy, acousticness, danceability = map(float, rng.uniform(0, 1, 3))
            top = int(rng.random() < .2)
            latent = (-.15 + .6 * (age / 1200) - .4 * recent - .6 * top
                      + 1.8 * (.5 - energy) + .9 * (acousticness - .5)
                      + .7 * (.5 - danceability) + float(rng.normal(0, .45)))
            probability = .05 + .9 / (1 + math.exp(-latent))
            label = int(rng.random() < probability)
            ambiguity = 4 * probability * (1 - probability)
            neglect = min(age / 1200, 1.)
            usefulness = float(np.clip(.15 + .35 * ambiguity + .25 * neglect
                                       + .15 / (1 + recent) + rng.normal(0, .07), 0, 1))
            skip = bool(rng.random() < .05 + .18 * ambiguity)
            values = {
                "saved_age_days": age, "recent_play_count": recent,
                "top_track_short": top, "top_track_medium": int(rng.random() < .25),
                "top_track_long": int(rng.random() < .35), "top_artist": int(rng.random() < .3),
                "release_age_years": float(rng.uniform(0, 45)),
                "duration_ms": int(rng.integers(100000, 350000)),
                "artist_library_count": int(rng.poisson(4)),
                "energy": energy, "acousticness": acousticness, "danceability": danceability,
                "happiness": float(rng.random()), "instrumentalness": float(rng.random()),
                "speechiness": float(rng.beta(1.2, 6)), "liveness": float(rng.random()),
                "tempo_bpm": float(rng.uniform(60, 190)), "loudness_db": float(rng.uniform(-24, -3)),
            }
            audio = {"energy", "acousticness", "danceability", "happiness", "instrumentalness",
                     "speechiness", "liveness", "tempo_bpm", "loudness_db"}
            all_audio_missing = rng.random() < .08
            for name in values:
                if (all_audio_missing and name in audio) or rng.random() < .15:
                    values[name] = None
            track_id = f"demo:c2-{group}-{index:05d}"
            # Artist identities describe the synthetic library, never a label.
            artists = [] if rng.random() < .1 else [f"demo:artist-{rng.integers(0, 40):02d}"]
            candidates.append({"trackId": track_id, "features": _feature_vector(values), "artistIds": artists})
            outcomes[track_id] = {"label": label, "usefulness": usefulness, "skip": skip,
                                  "latentRemovalProbability": probability}
        return candidates, outcomes

    candidates, outcomes = generate(pool_stream, size, "library")
    test_candidates, test_outcomes = generate(test_stream, holdout_size, "holdout")
    holdout = [_example(row, test_outcomes[row["trackId"]]["label"], seed, "holdout") for row in test_candidates]
    return {"seed": seed, "candidates": candidates, "outcomes": outcomes, "holdout": holdout}


def _example(candidate: dict, label: int, seed: int, split: str = "train") -> dict:
    return {"trackId": candidate["trackId"], "features": candidate["features"], "label": label,
            "split": split, "decisionId": str(uuid5(NAMESPACE_URL, f"c2-simulation:{seed}:{candidate['trackId']}")),
            "labeledAt": FIXTURE_TIME}


def _metrics(model: PreferenceModel, training: list[dict], holdout: list[dict], version: str) -> dict:
    metrics = evaluate_model(model, training + holdout, version)
    # Wall-clock timestamps are operational metadata, not part of seeded replay.
    metrics.pop("evaluatedAt")
    return metrics


def run_policy(environment: dict, policy: str, *, budget: int = 80, alpha: float = .5,
               epsilon: float = .15, ridge: float = 1.) -> dict:
    """Run real C1 refits plus the pure C2 selector under a fixed exposure budget.

    The only outcome lookup inside the learning loop is the chosen item. Skips
    consume an exposure and reveal neither label nor reward to either learner.
    C1 versions change after every completed review; historical policy rewards
    remain frozen, while every active context is rebuilt under that version.
    """
    _positive_integer(budget, "budget")
    if policy not in POLICIES:
        raise ValueError(f"Unknown policy: {policy}")
    if budget > len(environment["candidates"]):
        raise ValueError("budget cannot exceed the candidate pool")
    if not math.isfinite(epsilon) or not 0 <= epsilon <= 1:
        raise ValueError("epsilon must be in [0,1]")
    seed = environment["seed"]
    remaining = list(environment["candidates"])
    training, observed_candidates, rewards, history, decisions = [], [], [], [], []
    model = PreferenceModel([], seed=seed)
    learner = LinearUCB(len(context_names(model)), alpha=alpha, ridge=ridge)
    config = {"strategy": policy, "alpha": alpha, "epsilon": epsilon,
              "maxExplorationFraction": 1. if policy == "random" else .25,
              "diversityWindow": 0 if policy in ("random", "c1") else 3,
              "maxPerArtist": 1, "obviousKeepThreshold": 0. if policy == "random" else .1}
    learning_curve = []
    version = f"simulation-{seed}-{policy}-fit0"
    learning_curve.append({"exposures": 0, "metrics": _metrics(model, training, environment["holdout"], version)})
    for step in range(budget):
        version = f"simulation-{seed}-{policy}-fit{len(training)}"
        predictions = model.predict(remaining, version)
        contexts = build_context(model, remaining, predictions)
        # Rebuild all statistics instead of mixing old and new C1 coordinates.
        observed_predictions = model.predict(observed_candidates, version)
        learner.fit(build_context(model, observed_candidates, observed_predictions), np.asarray(rewards))
        fallback = None
        if policy == "c1" or not rewards:
            fallback = [row["trackId"] for row in model.rank(remaining, version, limit=1)]
        choice = select_candidate(remaining, predictions, contexts, learner, seed=seed,
                                  step=step, config=config, history=history, fallback_order=fallback)
        candidate = remaining[choice["index"]]
        prediction = predictions[choice["index"]]["prediction"]
        outcome = environment["outcomes"][candidate["trackId"]]
        label, usefulness, correction, reward = None, None, None, None
        if not outcome["skip"]:
            label, usefulness = outcome["label"], outcome["usefulness"]
            probability = prediction["removalProbability"]
            correction = 0. if probability is None else float((label - probability) ** 2)
            reward = float(.75 * usefulness + .25 * correction)
            training.append(_example(candidate, label, seed))
            observed_candidates.append(candidate)
            rewards.append(reward)
        decision = {"step": step + 1, "trackId": candidate["trackId"],
                    "artistIds": candidate["artistIds"], "candidateCount": len(remaining),
                    "candidateSetDigest": _digest([row["trackId"] for row in remaining]),
                    "contextModelVersion": version, "policyObservationsBefore": learner.n_observations,
                    "trainedExamplesBefore": model.trained_examples,
                    "frozenRemovalProbability": prediction["removalProbability"],
                    "frozenHeuristicScore": prediction["heuristicScore"],
                    "predictiveEntropy": prediction["uncertainty"],
                    **{key: choice[key] for key in ("strategy", "selectionMethod", "selectionScore", "predictedReward",
                                                    "uncertainty", "explorationBonus", "informationGain", "propensityEstimate", "reasons")},
                    "contextDigest": _digest(choice["context"]),
                    "label": label, "skipped": bool(outcome["skip"]), "usefulness": usefulness,
                    "correctionSignal": correction, "reward": reward,
                    "cumulativeReward": float(sum(rewards))}
        decisions.append(decision)
        history.append({"trackId": candidate["trackId"], "artistIds": candidate["artistIds"], "strategy": choice["strategy"]})
        remaining.pop(choice["index"])
        if label is not None:
            model = PreferenceModel(training, seed=seed)
        if (step + 1) % 20 == 0 or step + 1 == budget:
            current = f"simulation-{seed}-{policy}-fit{len(training)}"
            learning_curve.append({"exposures": step + 1,
                                   "metrics": _metrics(model, training, environment["holdout"], current)})
    completed = len(training)
    useful = sum(row["usefulness"] is not None and row["usefulness"] >= USEFUL_THRESHOLD for row in decisions)
    known_artist_exposures = sum(bool(row["artistIds"]) for row in decisions)
    artists = {artist for row in decisions for artist in row["artistIds"]}
    metrics = {"exposures": budget, "completedReviews": completed, "skips": budget - completed,
               "cumulativeReward": float(sum(rewards)), "rewardPerExposure": float(sum(rewards) / budget),
               "usefulnessSum": float(sum(row["usefulness"] or 0. for row in decisions)),
               "usefulReviews": useful, "usefulReviewRate": useful / budget,
               "usefulReviewRateAmongCompleted": useful / completed if completed else None,
               "removals": sum(row["label"] == 1 for row in decisions),
               "keeps": sum(row["label"] == 0 for row in decisions),
               "explorationSelections": sum(row["strategy"] == "explore" for row in decisions),
               "meanDesignInformationGain": float(np.mean([row["informationGain"] for row in decisions])),
               "uniqueArtists": len(artists), "knownArtistExposures": known_artist_exposures,
               "unknownArtistExposures": budget - known_artist_exposures,
               "uniqueArtistRateAmongKnown": len(artists) / known_artist_exposures if known_artist_exposures else None,
               "diversityRelaxations": sum("artist_diversity_relaxed_no_eligible_candidate" in row["reasons"] for row in decisions)}
    return {"policy": policy, "seed": seed, "config": config,
            "environmentDigest": _digest(environment), "holdoutDigest": _digest(environment["holdout"]),
            "trainingTrackIds": [row["trackId"] for row in training],
            "policyMetrics": metrics, "predictiveMetrics": learning_curve[-1]["metrics"],
            "learningCurve": learning_curve, "decisions": decisions}


def _distribution(values: list[float | None]) -> dict:
    observed = [value for value in values if value is not None]
    return {"count": len(observed), "mean": float(np.mean(observed)) if observed else None,
            "sampleStd": float(np.std(observed, ddof=1)) if len(observed) > 1 else None}


def run_simulation(*, seeds=DEFAULT_SEEDS, size: int = 400, budget: int = 80,
                   holdout_size: int = 150, alpha: float = .5, epsilon: float = .15,
                   ridge: float = 1.) -> dict:
    seeds = list(seeds)
    if not seeds or any(type(seed) is not int for seed in seeds) or len(set(seeds)) != len(seeds):
        raise ValueError("seeds must contain distinct integers")
    _positive_integer(budget, "budget")
    _positive_integer(size, "size")
    if budget > size:
        raise ValueError("budget cannot exceed size")
    # Validate before generating or running any potentially expensive experiment.
    LinearUCB(1, alpha=alpha, ridge=ridge)
    if not math.isfinite(epsilon) or not 0 <= epsilon <= 1:
        raise ValueError("epsilon must be in [0,1]")
    runs = []
    environments = []
    for seed in seeds:
        environment = generate_environment(seed, size, holdout_size)
        environments.append({"seed": seed, "digest": _digest(environment),
                             "holdoutDigest": _digest(environment["holdout"]),
                             "potentialSkips": sum(row["skip"] for row in environment["outcomes"].values()),
                             "uncertainCandidates": sum(.4 <= row["latentRemovalProbability"] <= .6 for row in environment["outcomes"].values())})
        runs.extend(run_policy(environment, policy, budget=budget, alpha=alpha, epsilon=epsilon, ridge=ridge) for policy in POLICIES)
    summary = []
    for policy in POLICIES:
        rows = [row for row in runs if row["policy"] == policy]
        summary.append({"policy": policy,
                        **{key: _distribution([row["policyMetrics"][key] for row in rows])
                           for key in ("cumulativeReward", "rewardPerExposure", "completedReviews", "usefulReviews", "usefulReviewRate",
                                       "removals", "explorationSelections", "uniqueArtists", "meanDesignInformationGain")},
                        **{key: _distribution([row["predictiveMetrics"][key] for row in rows])
                           for key in ("trainedExamples", "brierScore", "logLoss", "rocAuc")}})
    paired = []
    for baseline in POLICIES[:-1]:
        comparisons = []
        for seed in seeds:
            by_policy = {row["policy"]: row for row in runs if row["seed"] == seed}
            comparisons.append(by_policy["linucb"]["policyMetrics"]["cumulativeReward"] - by_policy[baseline]["policyMetrics"]["cumulativeReward"])
        paired.append({"comparison": f"linucb minus {baseline}", "cumulativeRewardDifference": _distribution(comparisons)})
    return {"schemaVersion": "sortfm.c2-simulation.v1", "environmentVersion": "synthetic-review-environment-v1",
            "rewardVersion": "review-utility-v1", "dataset": "synthetic",
            "notice": "Synthetic on-policy simulation with generated counterfactual outcomes; not historical off-policy evaluation, real listener validation, calibration, or proof of policy improvement.",
            "design": {"seeds": seeds, "candidateCount": size, "exposureBudget": budget, "holdoutSize": holdout_size,
                       "alpha": alpha, "epsilon": epsilon, "ridge": ridge, "usefulThreshold": USEFUL_THRESHOLD,
                       "reward": "0.75 * usefulness + 0.25 * (label - frozenRemovalProbability)^2; correction is zero for heuristic; SKIP has null reward",
                       "initialState": "zero labels; each policy learns only from its own completed selected reviews",
                       "holdout": "Independent seeded stream, never selectable; observed selected library labels are training-only",
                       "learningCurve": "Evaluate every 20 exposures and at final budget; no checkpoint affects training or selection",
                       "baselineC1": "Recompute PreferenceModel.rank(limit=1) after each exposure; first recommendation in an adaptive C1 queue",
                       "baselineRandom": "Uniform over all remaining candidates; no artist, exploration-cap, or obvious-keep restriction",
                       "adaptivePolicies": "epsilon-greedy and LinUCB use learned review reward; 25% prefix exploration cap, 3-exposure artist window, obvious-keep threshold 0.1",
                       "uncertainty": "C1 predictive entropy, ridge leverage uncertainty and design information gain are distinct diagnostics",
                       "regret": "Not reported: adaptive classifier-dependent reward and changing contexts do not define stationary global regret. No theoretical LinUCB regret bound is claimed.",
                       "aggregation": "Arithmetic mean and sample standard deviation across distinct world seeds; null std for n<2; no significance or confidence-interval claim",
                       "selectionBias": "No IPS/DR estimator or unsupported cross-policy feedback replay. Potential outcomes exist for all actions only because this is a declared synthetic environment."},
            "runtime": {"python": platform.python_version(), "numpy": np.__version__, "scikitLearn": sklearn.__version__},
            "environments": environments, "summary": summary, "pairedComparisons": paired, "runs": runs}


def markdown_report(report: dict) -> str:
    def cell(value):
        if value["mean"] is None:
            return "unavailable"
        return f"{value['mean']:.4f}" + (f" ± {value['sampleStd']:.4f}" if value["sampleStd"] is not None else " (one seed)")

    design = report["design"]
    lines = ["# C2 reproducible synthetic policy evaluation", "", report["notice"], "",
             f"Seeds: {design['seeds']}. Per seed: {design['candidateCount']} candidate tracks, {design['exposureBudget']} exposures per policy, {design['holdoutSize']} disjoint held-out tracks. All policies start with zero labels.", "",
             "Values are mean ± sample standard deviation across seeds. Standard deviations describe seed variation; they are not confidence intervals. Reward weights and all hyperparameters were fixed before these runs.", "",
             "| Policy | Cumulative reward | Useful reviews / exposure | Completed / training labels | Removals (secondary) | Exploration choices | Distinct known artists |",
             "|---|---:|---:|---:|---:|---:|---:|"]
    for row in report["summary"]:
        lines.append("| " + row["policy"] + " | " + " | ".join(cell(row[key]) for key in ("cumulativeReward", "usefulReviewRate", "trainedExamples", "removals", "explorationSelections", "uniqueArtists")) + " |")
    lines += ["", "## Separate supervised predictive evaluation", "",
              "The same fixed test set is never selectable or used to fit features, centroids, the classifier, or the bandit. Unavailable metrics remain null when C1 eligibility fails. All probabilities remain uncalibrated.", "",
              "| Policy supplying training labels | Holdout Brier ↓ | Holdout log loss ↓ | Holdout ROC AUC ↑ |", "|---|---:|---:|---:|"]
    for row in report["summary"]:
        lines.append("| " + row["policy"] + " | " + " | ".join(cell(row[key]) for key in ("brierScore", "logLoss", "rocAuc")) + " |")
    lines += ["", "## Paired reward differences", "", "Same environment seed in each pair; adaptive model states and subsequent selected feedback differ.", ""]
    for row in report["pairedComparisons"]:
        lines.append(f"- {row['comparison']}: {cell(row['cumulativeRewardDifference'])}")
    lines += ["", "## Interpretation and limits", "",
              "Usefulness is a declared synthetic outcome about resolving neglected or ambiguous library items. Both KEEP and REMOVE can be useful. A completed review is counted as useful at usefulness ≥ 0.6; skips cost budget but supply no label or reward. The correction signal rewards a revealed mismatch with the frozen C1 probability; it is not measured information gain. Increasing it can reflect worse predictions, so assess usefulness and held-out prediction metrics alongside total reward.", "",
              "The random baseline is unrestricted. C1 uses the first item of its recomputed deterministic rank. Adaptive policies use the documented exploration and artist constraints; this compares deployable configurations, not an isolated causal effect of optimism. A missing artist does not establish diversity.", "",
              "All counterfactuals are synthetic and generated before selection. No unseen real feedback is imputed, and no unbiased off-policy policy-improvement claim is made. Global sequential regret is not estimated; adaptive C1 representations and prediction-dependent reward invalidate a stationary-reward interpretation. Design information gain is only a ridge-geometry proxy.", "",
              "No parameters were selected from these holdout results. Real listeners, live service latency, long-term retention and prospective randomized policy effectiveness remain untested. See docs/C2-evaluation.md for the environment, commands and benchmark scope.", ""]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seeds", nargs="+", type=int, default=list(DEFAULT_SEEDS))
    parser.add_argument("--size", type=int, default=400)
    parser.add_argument("--budget", type=int, default=80)
    parser.add_argument("--holdout-size", type=int, default=150)
    parser.add_argument("--alpha", type=float, default=.5)
    parser.add_argument("--epsilon", type=float, default=.15)
    parser.add_argument("--ridge", type=float, default=1.)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        report = run_simulation(seeds=args.seeds, size=args.size, budget=args.budget,
                                holdout_size=args.holdout_size, alpha=args.alpha, epsilon=args.epsilon, ridge=args.ridge)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
        args.output.with_suffix(".md").write_text(markdown_report(report))
    except (ValueError, OSError) as error:
        parser.error(str(error))
    print(f"Wrote {args.output} and {args.output.with_suffix('.md')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
