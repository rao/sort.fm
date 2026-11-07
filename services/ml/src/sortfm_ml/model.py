"""Per-user regularized logistic preference model, separate from queue policy.

Probabilities are uncalibrated estimates from explicit KEEP/REMOVE labels.
Normalized predictive entropy measures ambiguity in that estimate, not
epistemic confidence, a confidence interval, or a claim of listener utility.
"""

from __future__ import annotations

import math

import numpy as np
from sklearn.linear_model import LogisticRegression

from .features import AUDIO_KEYS, CENTROID_KEYS, FEATURE_VERSION, FeaturePipeline, observed_value, training_examples

# A model recipe identity, separate from the compatible persisted artifact format.
MODEL_RECIPE = "c1-logistic-supported-values-v2"
MIN_AUDIO_OBSERVATIONS = 12
MIN_AUDIO_PER_CLASS = 3


class PreferenceModel:
    """Immutable fit: scoring never changes preprocessing or model state.

    The service must pass one user's deduplicated active labels. At least 12
    permitted training decisions and 3 from each class enable a supervised fit;
    these are engineering defaults, not a validated sample-size guarantee.
    """

    def __init__(self, examples: list[dict], seed: int = 42, feature_group: str = "personalized"):
        self.seed = seed
        self.feature_group = feature_group
        train = training_examples(examples)
        self.trained_examples = len(train)
        self.pipeline = FeaturePipeline(feature_group)
        features = self.pipeline.fit_transform(train)
        labels = np.array([row["label"] for row in train], dtype=np.int64)
        # Keep the full context (including masks) for C2. C1 must not learn a
        # listener preference from provider availability repeated across 13
        # correlated masks. Missing values already map to the training median.
        self.predictor_mask_ = np.ones(features.shape[1], dtype=bool)
        self.predictor_mask_[len(self.pipeline.value_names):] = False
        self.feature_support_ = {}
        for index, key in enumerate(self.pipeline.value_names):
            observed = np.isfinite(self.pipeline.training_values_[:, index])
            counts = [int(np.sum(observed & (labels == label))) for label in (0, 1)]
            supported = key not in AUDIO_KEYS + CENTROID_KEYS or (
                sum(counts) >= MIN_AUDIO_OBSERVATIONS and min(counts) >= MIN_AUDIO_PER_CLASS)
            self.feature_support_[key] = {"observed": sum(counts), "keep": counts[0],
                                         "remove": counts[1], "enabled": supported}
            self.predictor_mask_[index] = supported
        # Sparse descriptors must not enter indirectly through audio distances.
        sparse_audio = any(v["observed"] and not v["enabled"] for k, v in self.feature_support_.items() if k in AUDIO_KEYS)
        if sparse_audio:
            for key in CENTROID_KEYS:
                if key in self.pipeline.value_names:
                    self.predictor_mask_[self.pipeline.value_names.index(key)] = False
                    self.feature_support_[key]["enabled"] = False
        features = features * self.predictor_mask_
        self.classifier = None
        self.model_kind = "heuristic"
        if len(train) >= 12 and (labels == 0).sum() >= 3 and (labels == 1).sum() >= 3:
            # No class balancing: changing the removal base rate should affect
            # estimated preference. L2 regularization restrains sparse fits.
            # The wire contract allows signed safe integers, while sklearn's
            # RNG accepts uint32. Keep the original seed as model identity.
            self.classifier = LogisticRegression(C=.5, solver="lbfgs", max_iter=1000, tol=1e-9, random_state=int(seed) % (2**32))
            self.classifier.fit(features, labels)
            self.model_kind = "logistic"

    def transform_context(self, candidates: list[dict]) -> np.ndarray:
        """Stable C2 context: ordered standardized values and missing masks.

        The returned fresh array is finite even for a zero-label model. C2 must
        pin model versions because feature scales legitimately change on refit.
        """
        return self.pipeline.transform(candidates)

    def _baseline(self, candidate: dict) -> tuple[float, list[dict]]:
        values = candidate["features"]["values"]
        age = observed_value(values, "saved_age_days")
        plays = observed_value(values, "recent_play_count")
        # A taper to exactly zero at 90 days prevents an age-equals-obsolescence
        # assumption; lifetime/top-play history is never a cold-start label.
        save_prior = -.08 * max(0, 1 - age / 90) if age is not None else 0.
        play_prior = -.07 * (1 - math.exp(-plays / 3)) if plays is not None else 0.
        terms = [{"feature": "baseline", "value": None, "contribution": .5, "description": "Neutral discovery heuristic; this is not a removal probability."}]
        if save_prior:
            terms.append({"feature": "saved_age_days", "value": age, "contribution": save_prior, "description": "A recent save is a small keep-affinity hint, never a KEEP label."})
        if play_prior:
            terms.append({"feature": "recent_play_count", "value": plays, "contribution": play_prior, "description": "Observed recent plays are a small keep-affinity hint; the listening window may be incomplete."})
        return .5 + save_prior + play_prior, terms

    def _explain(self, context: np.ndarray, values: np.ndarray, uncertainty: float) -> list[dict]:
        contributions = context * self.classifier.coef_[0]
        # Keep responses compact while retaining an exact additive decomposition.
        strongest = sorted(range(len(contributions)), key=lambda i: (-abs(float(contributions[i])), i))[:6]
        terms = [{"feature": "intercept", "value": 1., "contribution": float(self.classifier.intercept_[0]), "description": "Baseline removal log odds of the uncalibrated fitted model."}]
        for index in strongest:
            contribution = float(contributions[index])
            if contribution == 0:
                continue
            key = self.pipeline.feature_names[index]
            if index < len(self.pipeline.value_names):
                value = float(values[index]) if np.isfinite(values[index]) else None
                description = "Train-scaled feature contribution to removal log odds; an association, not a cause."
                if key in ("saved_age_days", "release_age_years", "duration_ms", "artist_library_count", "recent_play_count", "tempo_bpm"):
                    description += " Value uses log(1 + raw observation)."
                elif key.endswith("centroid_distance"):
                    description += " Distance uses only permitted training labels and jointly observed audio descriptors."
            else:
                value = float(context[index])
                description = "Missing-observation indicator contribution to removal log odds."
            terms.append({"feature": key, "value": value, "contribution": contribution, "description": description})
        other = float(sum(contributions[i] for i in range(len(contributions)) if i not in strongest))
        if other:
            terms.append({"feature": "other_features", "value": None, "contribution": other, "description": "Combined remaining feature contributions to removal log odds."})
        terms.append({"feature": "predictive_entropy", "value": uncertainty, "contribution": None, "description": "Normalized entropy measures predictive ambiguity, not epistemic confidence or a confidence interval."})
        return terms

    def predict(self, candidates: list[dict], model_version: str) -> list[dict]:
        """Produce frozen-contract predictions in candidate input order."""
        if not candidates:
            return []
        context = self.transform_context(candidates)
        # Old artifacts intentionally retain their original coefficients and
        # semantics. New fits store this mask; C2 still gets the full context.
        context = context * getattr(self, "predictor_mask_", np.ones(context.shape[1]))
        values = self.pipeline.values(candidates)
        probabilities = self.classifier.predict_proba(context)[:, 1] if self.classifier is not None else None
        results = []
        for index, candidate in enumerate(candidates):
            probability = None
            uncertainty = None
            heuristic = None
            if probabilities is None:
                heuristic, explanations = self._baseline(candidate)
            else:
                probability = float(probabilities[index])
                entropy_p = np.clip(probability, 1e-15, 1 - 1e-15)
                uncertainty = float(-(entropy_p * math.log2(entropy_p) + (1 - entropy_p) * math.log2(1 - entropy_p)))
                explanations = self._explain(context[index], values[index], uncertainty)
            results.append({
                "trackId": candidate["trackId"],
                "prediction": {
                    "modelKind": self.model_kind, "modelVersion": model_version,
                    "featureVersion": FEATURE_VERSION, "trainedExamples": self.trained_examples,
                    "removalProbability": probability, "heuristicScore": heuristic,
                    "uncertainty": uncertainty, "uncertaintyMethod": "entropy" if probabilities is not None else "none",
                    "calibrated": False, "explanations": explanations,
                },
            })
        return results

    def rank(self, candidates: list[dict], model_version: str, limit: int = 20, diversity_weight: float = .25) -> list[dict]:
        """Optional deterministic baseline ordering with feature diversity.

        This uses a greedy feature-distance bonus. Cold calibration includes a
        recent save among its first five selections (when any are available and
        limit >= 2), so weak keep priors cannot exclude that cohort. It is not a
        bandit or an exposure propensity. Candidate DTOs lack artist IDs, so
        artist diversity cannot be enforced. Classifier scores stay unchanged.
        """
        ordered = sorted(candidates, key=lambda row: row["trackId"])
        predictions = self.predict(ordered, model_version)
        if not ordered or limit <= 0:
            return []
        context = self.transform_context(ordered)
        scores = np.array([row["prediction"]["removalProbability"] if row["prediction"]["removalProbability"] is not None else row["prediction"]["heuristicScore"] for row in predictions])
        distance = np.zeros(len(ordered))
        available = np.ones(len(ordered), dtype=bool)
        ages = [observed_value(row["features"]["values"], "saved_age_days") for row in ordered]
        recent = np.array([age is not None and age < 90 for age in ages])
        recent_selected = False
        selected = []
        for position in range(min(limit, len(ordered))):
            utility = np.where(available, scores + diversity_weight * np.minimum(distance, 1), -np.inf)
            if self.classifier is None and limit >= 2 and position == min(limit, 5) - 1 and not recent_selected and (recent & available).any():
                utility = np.where(recent & available, utility, -np.inf)
            index = int(np.argmax(utility))
            selected.append(predictions[index])
            available[index] = False
            recent_selected = recent_selected or bool(recent[index])
            current_distance = np.sqrt(np.mean((context - context[index]) ** 2, axis=1))
            distance = current_distance if position == 0 else np.minimum(distance, current_distance)
        return selected
