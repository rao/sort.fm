"""Frozen, train-only transforms for the shared sortfm.features.v1 schema.

Zero is observed data. Every selected value has a missingness indicator even
when that column was fully observed during fit. HTTP rejects invalid numbers;
the local numerical boundary additionally treats nonfinite values as missing
and bounds finite extremes so one bad provider value cannot overflow a model.
"""

from __future__ import annotations

import math
from numbers import Real

import numpy as np

FEATURE_VERSION = "sortfm.features.v1"
FEATURE_KEYS = (
    "saved_age_days", "release_age_years", "duration_ms", "artist_library_count",
    "top_track_short", "top_track_medium", "top_track_long", "top_artist",
    "recent_play_count", "energy", "danceability", "happiness", "acousticness",
    "instrumentalness", "liveness", "speechiness", "tempo_bpm", "loudness_db",
    "key_sin", "key_cos", "mode_major", "soundnet_popularity",
    "kept_centroid_distance", "removed_centroid_distance",
)
METADATA_KEYS = ("release_age_years", "duration_ms", "artist_library_count")
HISTORY_KEYS = ("saved_age_days", "top_track_short", "top_track_medium", "top_track_long", "top_artist", "recent_play_count")
AUDIO_KEYS = FEATURE_KEYS[9:-2]
CENTROID_KEYS = FEATURE_KEYS[-2:]
FEATURE_GROUPS = ("metadata", "history", "audio", "personalized")
_LOG_KEYS = {"saved_age_days", "release_age_years", "duration_ms", "artist_library_count", "recent_play_count", "tempo_bpm"}
_BOUNDS = {
    "saved_age_days": (0, 36525), "release_age_years": (0, 200),
    "duration_ms": (0, 86400000), "artist_library_count": (0, 1000000),
    "recent_play_count": (0, 1000000), "tempo_bpm": (1, 400),
    "loudness_db": (-100, 10), "key_sin": (-1, 1), "key_cos": (-1, 1),
}


def observed_value(values: dict, key: str) -> float | None:
    """Return a bounded raw observation; bool/invalid/missing are not zero."""
    value = values.get(key)
    if isinstance(value, bool) or not isinstance(value, Real):
        return None
    value = float(value)
    if not math.isfinite(value):
        return None
    low, high = _BOUNDS.get(key, (0, 1))
    return float(np.clip(value, low, high))


def training_examples(examples: list[dict]) -> list[dict]:
    """Exclude holdouts, revoked/skipped labels and disallowed source vectors.

    User isolation, event identity, versions and rights validation belong to
    ModelService. Sorting here also makes numerical fitting order reproducible.
    """
    accepted = [
        row for row in examples
        if row.get("split") == "train"
        and row.get("label") in (0, 1)
        and not isinstance(row.get("label"), bool)
        and row.get("features", {}).get("permittedForTraining") is True
    ]
    return sorted(accepted, key=lambda row: (row["trackId"], row.get("decisionId", "")))


def _statistics(values: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Median/IQR with fixed defaults for absent and constant columns."""
    medians = np.zeros(values.shape[1], dtype=np.float64)
    scales = np.ones(values.shape[1], dtype=np.float64)
    for column in range(values.shape[1]):
        observed = values[:, column][np.isfinite(values[:, column])]
        if observed.size:
            medians[column] = np.median(observed)
            iqr = np.percentile(observed, 75) - np.percentile(observed, 25)
            if iqr > 1e-12:
                scales[column] = max(float(iqr), .05)
    return medians, scales


class FeaturePipeline:
    """Missing-aware audio centroids plus robust, immutable preprocessing.

    Distances are RMS differences on jointly observed, train-scaled audio
    descriptors. Incoming distance fields are never read. Training distances
    exclude the row itself from both label pools; inference uses only the
    stored training pools and also excludes matching training track IDs.
    Missing audio produces missing distances, not invented taste evidence.
    """

    def __init__(self, feature_group: str = "personalized"):
        if feature_group not in FEATURE_GROUPS:
            raise ValueError(f"Unknown feature group: {feature_group}")
        self.feature_group = feature_group
        level = FEATURE_GROUPS.index(feature_group)
        selected = set(METADATA_KEYS)
        if level >= 1:
            selected.update(HISTORY_KEYS)
        if level >= 2:
            selected.update(AUDIO_KEYS)
        self.base_names = tuple(key for key in FEATURE_KEYS if key in selected)
        self.value_names = self.base_names + (CENTROID_KEYS if level >= 3 else ())
        self.feature_names = self.value_names + tuple(f"{key}_missing" for key in self.value_names)
        self._audio_indices = [i for i, key in enumerate(self.base_names) if key in AUDIO_KEYS]

    def _base_values(self, rows: list[dict]) -> np.ndarray:
        values = np.full((len(rows), len(self.base_names)), np.nan)
        for row_index, row in enumerate(rows):
            source = row["features"]["values"]
            for column, key in enumerate(self.base_names):
                observed = observed_value(source, key)
                if observed is not None:
                    values[row_index, column] = math.log1p(observed) if key in _LOG_KEYS else observed
        return values

    def fit_transform(self, examples: list[dict]) -> np.ndarray:
        """Fit only the provided permitted training rows, returning their order.

        PreferenceModel filters and sorts rows before this boundary. Rejecting
        other rows here prevents accidentally adding holdout preprocessing in
        future callers while preserving matrix/label alignment.
        """
        if any(row.get("split") != "train" or row.get("label") not in (0, 1) or row["features"].get("permittedForTraining") is not True for row in examples):
            raise ValueError("FeaturePipeline can fit only permitted training labels")
        base = self._base_values(examples)
        self.base_medians_, self.base_scales_ = _statistics(base)
        scaled = np.clip((base - self.base_medians_) / self.base_scales_, -8, 8)
        self._training_audio = scaled[:, self._audio_indices]
        self._training_labels = np.array([row["label"] for row in examples], dtype=np.int64)
        self._training_ids = [row["trackId"] for row in examples]
        self._index_by_id = {}
        for index, track_id in enumerate(self._training_ids):
            self._index_by_id.setdefault(track_id, []).append(index)
        self._class_sums = []
        self._class_counts = []
        for label in (0, 1):
            pool = self._training_audio[self._training_labels == label]
            self._class_sums.append(np.nansum(pool, axis=0))
            self._class_counts.append(np.isfinite(pool).sum(axis=0))
        self.training_values_ = self._augment(base, examples)
        self.medians_, self.scales_ = _statistics(self.training_values_)
        return self._standardize(self.training_values_)

    def _augment(self, base: np.ndarray, rows: list[dict]) -> np.ndarray:
        if self.feature_group != "personalized":
            return base
        distances = np.full((len(rows), 2), np.nan)
        audio = np.clip((base - self.base_medians_) / self.base_scales_, -8, 8)[:, self._audio_indices]
        # Most inference rows are unseen: calculate their distances in a single
        # matrix operation, then correct known track rows using LOO reference pools.
        for label in (0, 1):
            counts = self._class_counts[label]
            centroid = np.divide(self._class_sums[label], counts, out=np.full(len(counts), np.nan), where=counts > 0)
            difference = audio - centroid
            shared = np.isfinite(difference).sum(axis=1)
            distances[:, label] = np.sqrt(np.divide(np.nansum(difference ** 2, axis=1), shared, out=np.full(len(rows), np.nan), where=shared > 0))
            for row_index, row in enumerate(rows):
                excluded = self._index_by_id.get(row["trackId"], ())
                excluded = [i for i in excluded if self._training_labels[i] == label]
                if not excluded:
                    continue
                pool = self._training_audio[excluded]
                remaining_count = counts - np.isfinite(pool).sum(axis=0)
                remaining_sum = self._class_sums[label] - np.nansum(pool, axis=0)
                loo_centroid = np.divide(remaining_sum, remaining_count, out=np.full(len(counts), np.nan), where=remaining_count > 0)
                difference = audio[row_index] - loo_centroid
                valid = np.isfinite(difference)
                distances[row_index, label] = np.sqrt(np.mean(difference[valid] ** 2)) if valid.any() else np.nan
        return np.column_stack((base, distances))

    def values(self, rows: list[dict]) -> np.ndarray:
        """Return log-transformed observations and derived RMS distances."""
        return self._augment(self._base_values(rows), rows)

    def _standardize(self, values: np.ndarray) -> np.ndarray:
        missing = ~np.isfinite(values)
        filled = np.where(missing, self.medians_, values)
        standardized = np.clip((filled - self.medians_) / self.scales_, -8, 8)
        return np.column_stack((standardized, missing.astype(np.float64)))

    def transform(self, rows: list[dict]) -> np.ndarray:
        return self._standardize(self.values(rows))
