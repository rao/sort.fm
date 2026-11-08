"""Local C2 CPU stages on synthetic data; neither an HTTP SLA nor a quality test."""

import argparse
import asyncio
import json
from pathlib import Path
import platform
from statistics import median
from time import perf_counter
from tempfile import TemporaryDirectory
from uuid import NAMESPACE_URL, uuid5

import numpy as np
import sklearn

from sortfm_ml.bandit import LinearUCB, build_context, context_names, select_candidate
from sortfm_ml.model import PreferenceModel
from sortfm_ml.simulate import FEATURE_VERSION, FIXTURE_TIME, _digest, _example, generate_environment


def benchmark_service(candidates: list[dict], training: list[dict], historical: list[dict],
                      environment: dict, repeats: int, seed: int, config: dict) -> dict:
    """Authenticated ASGI request/serialization plus real local persistence.

    One committed association establishes a learned reward; the other C1
    labels were supplied in the initial fit. Each repetition starts from a new
    temporary directory to hold the workload and candidate pool fixed.
    """
    import httpx
    from sortfm_ml.app import create_app

    async def run() -> dict:
        timings, selections = [], []
        for iteration in range(repeats + 1):
            with TemporaryDirectory(prefix="sortfm-c2-benchmark-") as directory:
                app = create_app(shared_secret="synthetic-benchmark-only", storage_dir=Path(directory))
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://synthetic-test",
                                              headers={"Authorization": "Bearer synthetic-benchmark-only"}) as client:
                    user = "demo:c2-benchmark"
                    response = await client.post("/fit", json={"userId": user, "featureVersion": FEATURE_VERSION,
                                                "feedbackRevision": 1, "evaluationSeed": seed, "examples": training})
                    assert response.status_code == 200, response.text
                    fitted = response.json()
                    initial_id = str(uuid5(NAMESPACE_URL, "c2-benchmark:initial-exposure"))
                    response = await client.post("/policy/select", json={"userId": user, "featureVersion": FEATURE_VERSION,
                                                 "exposureId": initial_id, "modelVersion": fitted["modelVersion"],
                                                 "feedbackRevision": fitted["feedbackRevision"], "seed": seed,
                                                 "config": config, "candidates": historical[:1]})
                    assert response.status_code == 200, response.text
                    original = response.json()
                    outcome = environment["outcomes"][historical[0]["trackId"]]
                    decision_id = str(uuid5(NAMESPACE_URL, "c2-benchmark:feedback-decision"))
                    snapshot = [{**row, "decisionId": decision_id} if row["trackId"] == original["trackId"] else row
                                for row in training]
                    response = await client.post("/fit", json={"userId": user, "featureVersion": FEATURE_VERSION,
                                                "feedbackRevision": 2, "evaluationSeed": seed, "examples": snapshot})
                    assert response.status_code == 200, response.text
                    fitted = response.json()
                    response = await client.post("/policy/associate", json={"userId": user, "event": {
                                                 "eventId": str(uuid5(NAMESPACE_URL, "c2-benchmark:feedback-event")),
                                                 "sequence": 1, "source": "cleanup", "decisionId": decision_id,
                                                 "policyVersion": original["policyVersion"], "modelVersion": original["modelVersion"],
                                                 "exposureId": initial_id, "trackId": historical[0]["trackId"],
                                                 "feedbackRevision": 2, "operation": "upsert", "label": outcome["label"],
                                                 "features": historical[0]["features"], "occurredAt": FIXTURE_TIME,
                                                 "usefulness": outcome["usefulness"]}, "fitReceipt": {
                                                     "modelVersion": fitted["modelVersion"],
                                                     "synchronizedFeedbackRevision": fitted["feedbackRevision"]}})
                    assert response.status_code == 200, response.text
                    request = {"userId": user, "featureVersion": FEATURE_VERSION,
                               "exposureId": str(uuid5(NAMESPACE_URL, "c2-benchmark:measured-exposure")),
                               "modelVersion": fitted["modelVersion"], "feedbackRevision": fitted["feedbackRevision"],
                               "seed": seed, "config": config, "candidates": candidates}
                    start = perf_counter()
                    response = await client.post("/policy/select", json=request)
                    elapsed = perf_counter() - start
                    assert response.status_code == 200, response.text
                    selected = response.json()
                    assert selected["trainedRewards"] == 1
                    assert selected["candidateCount"] == len(candidates)
                    assert selected["prediction"]["trainedExamples"] == len(training)
                    if iteration:
                        timings.append(elapsed)
                        selections.append((selected["trackId"], selected["selection"]["selectionScore"]))
        assert len(set(selections)) == 1
        return {"notice": "Authenticated in-process ASGI /policy/select with real temporary POSIX artifacts, one warm-up excluded. Includes request/response JSON, validation, authentication, checksums and persistence; excludes a network socket, TLS and deployed concurrency.",
                "candidateCount": len(candidates), "trainingExamples": len(training), "trainedRewards": 1,
                "feedbackTransport": "fit_then_associate",
                "policyVersion": selected["policyVersion"],
                "reservationTtlSeconds": app.state.policy_service.reservation_ttl_seconds,
                "selectionReplayExact": True, "authenticatedAsgiSelectionSeconds": timings,
                "medianAuthenticatedAsgiSelectionSeconds": median(timings)}

    return asyncio.run(run())


def benchmark(*, size: int = 2700, training_size: int = 100, repeats: int = 5, seed: int = 42) -> dict:
    if any(type(value) is not int or value < 1 for value in (size, training_size, repeats)):
        raise ValueError("size, training and repeats must be positive integers")
    environment = generate_environment(seed, size + training_size, holdout_size=20)
    historical = [row for row in environment["candidates"] if not environment["outcomes"][row["trackId"]]["skip"]][:training_size]
    if len(historical) != training_size:
        raise ValueError("Synthetic pool has fewer completed reviews than requested training examples")
    historical_ids = {row["trackId"] for row in historical}
    candidates = [row for row in environment["candidates"] if row["trackId"] not in historical_ids]
    training = [_example(row, environment["outcomes"][row["trackId"]]["label"], seed) for row in historical]
    # Historical reward fixtures use a declared frozen probability of .5. Their
    # values only exercise fitting cost; no behavioral finding is inferred.
    rewards = np.asarray([.75 * environment["outcomes"][row["trackId"]]["usefulness"] + .25 * .25 for row in historical])
    runs, selections = [], []
    config = {"strategy": "linucb", "alpha": .5, "maxExplorationFraction": .25,
              "diversityWindow": 3, "maxPerArtist": 1, "obviousKeepThreshold": .1}
    # One unreported warm-up excludes import and numerical initialization cost.
    for iteration in range(repeats + 1):
        start = perf_counter()
        model = PreferenceModel(training, seed=seed)
        fit_seconds = perf_counter() - start
        start = perf_counter()
        predictions = model.predict(candidates, "benchmark-c2")
        predict_seconds = perf_counter() - start
        start = perf_counter()
        contexts = build_context(model, candidates, predictions)
        context_seconds = perf_counter() - start
        start = perf_counter()
        learner = LinearUCB(len(context_names(model)), alpha=.5, ridge=1.)
        historical_predictions = model.predict(historical, "benchmark-c2")
        learner.fit(build_context(model, historical, historical_predictions), rewards)
        rebuild_seconds = perf_counter() - start
        start = perf_counter()
        choice = select_candidate(candidates, predictions, contexts, learner,
                                  seed=seed, step=100, config=config,
                                  history=[{"trackId": row["trackId"], "artistIds": row["artistIds"], "strategy": "exploit"} for row in historical])
        selection_seconds = perf_counter() - start
        assert len(candidates) == size and model.trained_examples == training_size
        assert len(predictions) == size and np.isfinite(contexts).all()
        if iteration:
            runs.append({"fitSeconds": fit_seconds, "predictSeconds": predict_seconds,
                         "contextSeconds": context_seconds, "policyRebuildSeconds": rebuild_seconds,
                         "selectionSeconds": selection_seconds,
                         "fullSelectionSeconds": predict_seconds + context_seconds + rebuild_seconds + selection_seconds})
            selections.append((choice["trackId"], choice["selectionScore"], choice["uncertainty"]))
    assert len(set(selections)) == 1, "Benchmark repeats must preserve exact policy selection"
    return {"schemaVersion": "sortfm.c2-benchmark.v1",
            "notice": "Local synthetic CPU timings, one warm-up excluded; no HTTP, persistence, concurrency, load, real listener, or deployment SLA claims.",
            "machine": platform.machine(), "python": platform.python_version(),
            "numpy": np.__version__, "scikitLearn": sklearn.__version__, "seed": seed,
            "candidateCount": size, "trainingExamples": training_size,
            "contextColumns": len(context_names(model)), "repeats": repeats,
            "inputDigest": _digest(environment), "selectionReplayExact": True,
            "chosenTrackId": selections[0][0], "policyConfig": config,
            "timingDefinitions": {
                "fitSeconds": "C1 PreferenceModel constructor refit from all historical labels",
                "predictSeconds": "C1 predictions including explanations for every candidate",
                "contextSeconds": "C2 candidate contexts from pinned C1 transform and predictions",
                "policyRebuildSeconds": "Current-version C1 observed predictions + observed contexts + ridge fit",
                "selectionSeconds": "Pure C2 selection with uncertainty scores, caps, history, artist rules and diagnostic result",
                "fullSelectionSeconds": "Sum of predict, context, rebuild and select; excludes C1 refit, HTTP, storage and serialization"},
            "runs": runs,
            "medians": {key: median(run[key] for run in runs) for key in runs[0]},
            "service": benchmark_service(candidates, training, historical, environment, repeats, seed, config)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--size", type=int, default=2700)
    parser.add_argument("--training", type=int, default=100)
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        report = benchmark(size=args.size, training_size=args.training, repeats=args.repeats, seed=args.seed)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    except (ValueError, OSError) as error:
        parser.error(str(error))
    print(json.dumps({"candidateCount": report["candidateCount"], "trainingExamples": report["trainingExamples"], "medians": report["medians"],
                      "medianAuthenticatedAsgiSelectionSeconds": report["service"]["medianAuthenticatedAsgiSelectionSeconds"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
