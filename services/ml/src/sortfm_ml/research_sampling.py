"""Pure offline sampling reference. No fitting, feedback ingestion or service I/O.

The caller must supply the complete authoritative split/role history, including
revoked feedback. This module never invents/reassigns splits. All evaluation
draws are from never-labeled fixed holdout; all acquisition draws are train-only.
The returned JSON-compatible manifest pins inputs and records probabilities.
It is a research artifact, not a live queue, shared DTO, or promotion command.
"""
from collections import Counter
from copy import deepcopy
import hashlib
import json
import math
import random
from typing import Annotated, Literal

from pydantic import Field, StringConstraints, TypeAdapter

from .schemas import Candidate, FeatureVersion, Identifier, Probability, Timestamp, WireModel


SCHEMA_VERSION = 'sortfm.research-sampling.v1'
SHA256 = Annotated[str, StringConstraints(pattern=r'^[0-9a-f]{64}$')]


class _Snapshot(WireModel):
    userId: Identifier
    featureVersion: FeatureVersion
    capturedAt: Timestamp
    candidates: list[Candidate]


class _RoleRecord(WireModel):
    trackId: Identifier
    split: Literal['train', 'holdout']
    role: Literal['training', 'evaluation']
    feedbackState: Literal['unlabeled', 'active', 'revoked', 'superseded']
    revision: Annotated[int, Field(ge=0, le=2**53 - 1)]


class _PinnedPrediction(WireModel):
    trackId: Identifier
    featureDigest: SHA256
    removalProbability: Probability | None


class _PinnedPredictions(WireModel):
    modelVersion: Annotated[str, StringConstraints(min_length=1)]
    modelDigest: SHA256
    modelKind: Literal['logistic', 'sgd_logistic', 'tree']
    trainingTrackIds: Annotated[list[Identifier], Field(min_length=1)]
    featureVersion: FeatureVersion
    sourceDigest: SHA256
    predictions: list[_PinnedPrediction]


def content_digest(value: object) -> str:
    """Canonical SHA-256 for local snapshot, feature and model identities."""
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'),
                                     allow_nan=False).encode()).hexdigest()


def _normalize_snapshot(snapshot: dict) -> dict:
    source = _Snapshot.model_validate(snapshot).model_dump(exclude_unset=True)
    source['candidates'].sort(key=lambda row: row['trackId'])
    ids = [row['trackId'] for row in source['candidates']]
    if len(set(ids)) != len(ids):
        raise ValueError('Duplicate snapshot track IDs')
    if len({r['features']['provenance'] == 'synthetic' for r in source['candidates']}) > 1:
        raise ValueError('Synthetic and real candidates must remain separate')
    return source


def snapshot_digest(snapshot: dict) -> str:
    """Digest of the validated, track-sorted snapshot used in a prediction pin."""
    return content_digest(_normalize_snapshot(snapshot))


def _registry(records: list[dict]) -> tuple[list[dict], dict[str, dict], set[str]]:
    history = [_RoleRecord.model_validate(row).model_dump() for row in records]
    history.sort(key=lambda row: (row['trackId'], row['revision']))
    latest, ever_labeled, versions = {}, set(), set()
    for row in history:
        track = row['trackId']
        key = (track, row['revision'])
        if key in versions:
            raise ValueError('Duplicate track/revision in role registry')
        versions.add(key)
        previous = latest.get(track)
        if previous and (previous['split'], previous['role']) != (row['split'], row['role']):
            raise ValueError('Role and split are immutable, including after revocation')
        expected_role = 'evaluation' if row['split'] == 'holdout' else 'training'
        if row['role'] != expected_role:
            raise ValueError('A holdout split requires evaluation role; train requires training')
        if row['feedbackState'] != 'unlabeled':
            ever_labeled.add(track)
        latest[track] = row
    return history, latest, ever_labeled


def _stratum(features: dict) -> str:
    # Fixed boundaries: no training, evaluation statistics, labels or taste
    # centroids influence these metadata/audio diversity cells. Zero is observed.
    values = features['values']
    boundaries = {'saved_age_days': (90, 365, 1095), 'release_age_years': (2, 10),
                  'energy': (.5,), 'danceability': (.5,)}
    return '|'.join(f'{key}:' + ('missing' if values.get(key) is None else
                                str(sum(values[key] >= b for b in bins)))
                    for key, bins in boundaries.items())


def _entropy(probability: float) -> float:
    if probability in (0, 1):
        return 0.0
    return -(probability * math.log2(probability) + (1 - probability) * math.log2(1 - probability))


def _integer(value: int, name: str, *, nonnegative: bool = True) -> None:
    if type(value) is not int or abs(value) > 2**53 - 1 or (nonnegative and value < 0):
        raise ValueError(f'{name} must be a {"nonnegative " if nonnegative else ""}safe integer')


def prepare_sampling(
    snapshot: dict,
    role_registry: list[dict],
    *,
    excluded_track_ids: list[str] | tuple[str, ...] = (),
    pinned_predictions: dict | None = None,
    evaluation_size: int = 0,
    representative_size: int = 0,
    diversity_size: int = 0,
    uncertainty_size: int = 0,
    sampling_seed: int = 42,
    exploration_probability: float = .1,
    previous_manifest: dict | None = None,
) -> dict:
    """Plan one offline batch without consuming or producing any labels.

    Representative evaluation and training draws are independent uniform
    samples without replacement. Diversity then uncertainty select from the
    remaining train pool, also without replacement, with an epsilon-uniform
    mixture. Only representative samples have known marginal inclusion k/N;
    adaptive draws report P(track at this draw | recorded previous draws).

    A role record is an append-only observation with trackId, revision, split,
    role and feedbackState. Active/superseded training feedback is excluded;
    *any* historical feedback excludes evaluation, even after Undo. Supply the
    prior manifest each subsequent round: old history must remain byte-for-
    byte equal after normalization, and all previously reserved tracks remain
    excluded. The authority/completeness of the initial history is a caller
    responsibility; a local digest is not an authentication signature.
    """
    sizes = {'representative_evaluation': evaluation_size, 'representative_train': representative_size,
             'diversity_train': diversity_size, 'uncertainty_train': uncertainty_size}
    for name, size in sizes.items():
        _integer(size, name)
    _integer(sampling_seed, 'sampling_seed', nonnegative=False)
    if (type(exploration_probability) not in (int, float)
            or not math.isfinite(exploration_probability)
            or not 1e-6 <= exploration_probability <= 1):
        raise ValueError('exploration_probability must be finite and in [1e-6, 1] for positive numerical support')
    epsilon = float(exploration_probability)
    source = _normalize_snapshot(snapshot)
    history, latest, ever_labeled = _registry(role_registry)
    candidates = {row['trackId']: row for row in source['candidates']}
    if set(candidates) - set(latest):
        raise ValueError('Every candidate requires authoritative role registry history')
    if not isinstance(excluded_track_ids, (list, tuple)):
        raise ValueError('excluded_track_ids must be a list or tuple of track IDs')
    exclusions = sorted(set(TypeAdapter(list[Identifier]).validate_python(list(excluded_track_ids))))
    reserved = set()
    previous = deepcopy(previous_manifest)
    if previous is not None:
        replay_sampling(previous)
        if previous['source']['userId'] != source['userId']:
            raise ValueError('Previous manifest belongs to another user')
        historical = {(row['trackId'], row['revision']): row for row in history}
        for row in previous['roleRegistry']:
            if historical.get((row['trackId'], row['revision'])) != row:
                raise ValueError('Previous role registry history must be preserved unchanged')
        reserved.update(previous['reservedTrackIds'])
    denied = set(exclusions) | reserved
    training, evaluation = [], []
    for track, row in candidates.items():
        if track in denied or not row['features']['permittedForTraining']:
            continue
        role = latest[track]
        if role['role'] == 'evaluation' and track not in ever_labeled:
            evaluation.append(track)
        elif role['role'] == 'training' and role['feedbackState'] in ('unlabeled', 'revoked'):
            training.append(track)
    if evaluation_size > len(evaluation):
        raise ValueError('Not enough never-labeled fixed evaluation candidates')
    if representative_size + diversity_size + uncertainty_size > len(training):
        raise ValueError('Not enough eligible fixed training candidates')

    source_digest = content_digest(source)
    features = {track: content_digest(row['features']) for track, row in candidates.items()}
    pins, probabilities = None, {}
    if pinned_predictions is not None:
        pins = _PinnedPredictions.model_validate(pinned_predictions).model_dump()
        pins['trainingTrackIds'].sort()
        if len(set(pins['trainingTrackIds'])) != len(pins['trainingTrackIds']):
            raise ValueError('Duplicate training track in model lineage')
        for track in pins['trainingTrackIds']:
            if track not in latest:
                raise ValueError('Model training lineage requires authoritative role registry history')
            if latest[track]['role'] != 'training':
                raise ValueError('Model training lineage cannot contain evaluation or holdout tracks')
        pins['predictions'].sort(key=lambda row: row['trackId'])
        if pins['sourceDigest'] != source_digest:
            raise ValueError('Pinned prediction sourceDigest does not match the immutable snapshot')
        for row in pins['predictions']:
            track = row['trackId']
            if track in probabilities:
                raise ValueError('Duplicate pinned prediction track')
            if track not in candidates or row['featureDigest'] != features[track]:
                raise ValueError('Pinned prediction featureDigest does not match snapshot features')
            probabilities[track] = row['removalProbability']
    if uncertainty_size and (pins is None or any(probabilities.get(track) is None for track in training)):
        raise ValueError('Uncertainty sampling requires pinned probabilities for every eligible training track')

    strata = {track: _stratum(candidates[track]['features']) for track in training}
    seen_strata, draws = Counter(), []
    train_remaining, evaluation_remaining = list(training), list(evaluation)
    for strategy, count in sizes.items():
        pool = evaluation_remaining if strategy == 'representative_evaluation' else train_remaining
        rng = random.Random(int(content_digest({'seed': sampling_seed, 'stream': strategy}), 16))
        initial_count = len(pool)
        for draw_number in range(count):
            n = len(pool)
            uniform = strategy.startswith('representative')
            if strategy == 'diversity_train':
                remaining_counts = Counter(strata[track] for track in pool)
                scores = {track: 1 / (remaining_counts[strata[track]] * (1 + seen_strata[strata[track]]))
                          for track in pool}
            elif strategy == 'uncertainty_train':
                scores = {track: _entropy(probabilities[track]) for track in pool}
            else:
                scores = {track: 1.0 for track in pool}
            total = math.fsum(scores.values())
            acquisition = {track: scores[track] / total if total else 1 / n for track in pool}
            exploration = 1.0 if uniform else epsilon
            distribution = {track: exploration / n + (1 - exploration) * acquisition[track] for track in pool}
            # The final floating point residual is assigned to the final item;
            # retain the actual probabilities used by inverse-CDF selection.
            distribution[pool[-1]] = 1.0 - math.fsum(distribution[track] for track in pool[:-1])
            if any(probability <= 0 for probability in distribution.values()):
                raise ValueError('Increase exploration_probability to preserve positive numerical support')
            threshold, cumulative, selected = rng.random(), 0.0, pool[-1]
            for track in pool:
                cumulative += distribution[track]
                if threshold < cumulative:
                    selected = track
                    break
            role = latest[selected]
            row = {'trackId': selected, 'split': role['split'], 'role': role['role'],
                   'strategy': strategy, 'drawNumber': draw_number + 1, 'eligiblePoolSize': n,
                   'conditionalProbability': distribution[selected],
                   'marginalInclusionProbability': count / initial_count if uniform else None,
                   'uniformComponentProbability': exploration / n,
                   'acquisitionScore': None if uniform else scores[selected],
                   'acquisitionScoreTotal': None if uniform else total,
                   'probabilityDistributionDigest': content_digest(distribution),
                   'randomUniform': threshold, 'featureDigest': features[selected],
                   'features': deepcopy(candidates[selected]['features'])}
            if not uniform:
                row['stratum'] = strata[selected]
            draws.append(row)
            pool.remove(selected)
            if role['role'] == 'training':
                seen_strata[strata[selected]] += 1
    reserved.update(row['trackId'] for row in draws)
    manifest = {
        'schemaVersion': SCHEMA_VERSION, 'offlineOnly': True, 'promotionAllowed': False,
        'source': source, 'roleRegistry': history, 'pinnedPredictions': pins,
        'excludedTrackIds': exclusions, 'previousManifest': previous,
        'reservedTrackIds': sorted(reserved),
        'identities': {'sourceDigest': source_digest, 'roleRegistryDigest': content_digest(history),
                       'featureVersion': source['featureVersion'],
                       'predictionDigest': content_digest(pins) if pins is not None else None,
                       'modelDigest': pins['modelDigest'] if pins else None,
                       'modelVersion': pins['modelVersion'] if pins else None},
        'plan': {'evaluation_size': evaluation_size, 'representative_size': representative_size,
                 'diversity_size': diversity_size, 'uncertainty_size': uncertainty_size,
                 'sampling_seed': sampling_seed, 'exploration_probability': epsilon},
        'pools': {'evaluation': evaluation, 'training': training},
        'diversity': {'method': 'inverse_remaining_stratum_size_times_inverse_previous_coverage',
                      'strataByTrack': strata},
        'protocol': {'rng': 'Python Random MT19937 random(); SHA-256 strategy streams; inverse CDF',
                     'strategyOrder': list(sizes), 'withReplacement': False,
                     'evaluationPopulation': 'Permitted, never-labeled fixed holdout; excluding prior reservations',
                     'representativePopulation': 'Eligible fixed split pool before this strategy in this batch',
                     'adaptiveProbability': 'P(track at draw | all prior draws in this batch)',
                     'adaptiveMarginalInclusionProbability': None,
                     'weighting': 'Do not use conditional draw probabilities as marginal inclusion/IPW weights',
                     'evaluationFeedbackForTraining': False},
        'draws': draws,
    }
    manifest['manifestId'] = content_digest(manifest)
    return manifest


def validate_sampling_manifest(manifest: dict) -> None:
    """Detect edits to a saved manifest; not a cryptographic authenticity check."""
    if (manifest.get('schemaVersion') != SCHEMA_VERSION or manifest.get('offlineOnly') is not True
            or manifest.get('promotionAllowed') is not False):
        raise ValueError('Unsupported offline sampling manifest')
    if manifest.get('manifestId') != content_digest({k: v for k, v in manifest.items() if k != 'manifestId'}):
        raise ValueError('Sampling manifest digest mismatch')


def replay_sampling(manifest: dict) -> dict:
    """Reproduce a manifest from its pinned inputs; raises on any draw mismatch."""
    validate_sampling_manifest(manifest)
    replayed = prepare_sampling(manifest['source'], manifest['roleRegistry'],
                                excluded_track_ids=manifest['excludedTrackIds'],
                                pinned_predictions=manifest['pinnedPredictions'],
                                previous_manifest=manifest['previousManifest'], **manifest['plan'])
    if replayed != manifest:
        raise ValueError('Sampling manifest replay mismatch')
    return replayed
