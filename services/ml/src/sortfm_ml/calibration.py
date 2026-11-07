"""Label-blind sampling and private local Keep/Remove sheets; no provider I/O."""
from collections import Counter, defaultdict
import csv
import math
from pathlib import Path
import random

import numpy as np
from pydantic import Field

from .cli import split_for_track
from .features import AUDIO_KEYS, FEATURE_VERSION, observed_value
from .schemas import Candidate, FeatureVersion, Identifier, Timestamp, WireModel
from .service import digest


class Display(WireModel):
    title: str = ''
    artists: list[str] = Field(default_factory=list)


class LibrarySnapshot(WireModel):
    userId: Identifier
    featureVersion: FeatureVersion
    capturedAt: Timestamp
    candidates: list[Candidate]
    display: dict[str, Display] = Field(default_factory=dict)


def normalize_snapshot(snapshot: dict) -> dict:
    """Accept the integration lead's read-only export, without fetching anything."""
    if snapshot.get('snapshotVersion') == 'sortfm.calibration-export.v1':
        display = {}
        for item in snapshot['tracks']:
            track = item['track']
            if track['trackId'] in display:
                raise ValueError('Duplicate display track ID')
            display[track['trackId']] = {'title': track['title'], 'artists': [a['name'] for a in track['artists']]}
        return {k: snapshot[k] for k in ('userId', 'featureVersion', 'capturedAt', 'candidates')} | {'display': display}
    return snapshot


def validate_manifest(manifest: dict) -> None:
    if manifest.get('schemaVersion') != 'sortfm.calibration.v1':
        raise ValueError('Unsupported calibration manifest')
    if manifest.get('experimentId') != digest({k: v for k, v in manifest.items() if k != 'experimentId'}):
        raise ValueError('Calibration manifest digest mismatch; create a new experiment before labeling')


def _recency(age):
    if age is None:
        return 'unknown'
    return '<90d' if age < 90 else '90-364d' if age < 365 else '365-1094d' if age < 1095 else '>=1095d'


def _sample(pool, count, rng):
    """Proportional largest-remainder allocation; seeded ties and within cells."""
    if len(pool) < count:
        raise ValueError('Not enough eligible tracks in the fixed train/holdout pools')
    groups = defaultdict(list)
    for row in pool:
        groups[row['stratum']].append(row)
    keys = sorted(groups)
    quotas = {key: count * len(groups[key]) / len(pool) for key in keys}
    allocated = {key: math.floor(quotas[key]) for key in keys}
    tie = {key: rng.random() for key in keys}
    remainder = sorted(keys, key=lambda key: (-(quotas[key] - allocated[key]), tie[key]))
    for key in remainder[:count - sum(allocated.values())]:
        allocated[key] += 1
    result = []
    for key in keys:
        candidates = sorted(groups[key], key=lambda r: r['trackId'])
        rng.shuffle(candidates)
        result.extend(candidates[:allocated[key]])
    rng.shuffle(result)
    return result


def prepare(snapshot: dict, size: int = 60, sampling_seed: int = 42, evaluation_seed: int = 42) -> dict:
    """Select 30–60 training and exactly 20 held-out tracks before seeing labels.

    Splits match the live API hash. Oversampling the hash-assigned holdout pool
    reaches the existing >=20 metric gate without changing track membership.
    Seeds and strata must be fixed before labeling; repeated final-holdout
    experiments are not independent evidence.
    """
    if not 50 <= size <= 80:
        raise ValueError('Calibration size must be between 50 and 80')
    if not all(type(seed) is int and abs(seed) <= 2**53 - 1 for seed in (sampling_seed, evaluation_seed)):
        raise ValueError('Seeds must be signed safe integers')
    snapshot = LibrarySnapshot.model_validate(normalize_snapshot(snapshot)).model_dump(exclude_unset=True)
    candidates = sorted(snapshot['candidates'], key=lambda r: r['trackId'])
    if len({r['trackId'] for r in candidates}) != len(candidates):
        raise ValueError('Duplicate snapshot track IDs')
    snapshot['candidates'] = candidates
    if len({r['features']['provenance'] == 'synthetic' for r in candidates}) > 1:
        raise ValueError('Synthetic and real candidates must remain separate')
    eligible = [r for r in candidates if r['features']['permittedForTraining']]
    coverage = {key: sum(observed_value(r['features']['values'], key) is not None for r in eligible)
                for key in AUDIO_KEYS}
    axes = [key for key in ('energy', 'danceability') if coverage[key] >= max(1, len(eligible) / 2)]
    axes += ['release_age_years', 'duration_ms'][:2 - len(axes)]
    medians = {}
    for key in axes:
        values = [observed_value(r['features']['values'], key) for r in eligible]
        values = [v for v in values if v is not None]
        medians[key] = float(np.median(values)) if values else None
    rows = []
    for row in eligible:
        values = row['features']['values']
        bins = []
        for key in axes:
            v = observed_value(values, key)
            bins.append('unknown' if v is None else 'low' if v <= medians[key] else 'high')
        rows.append({**row, 'split': split_for_track(snapshot['userId'], row['trackId'], evaluation_seed),
                     'stratum': '|'.join([_recency(observed_value(values, 'saved_age_days')), *bins])})
    rng = random.Random(sampling_seed)
    selected = _sample([r for r in rows if r['split'] == 'train'], size - 20, rng)
    selected += _sample([r for r in rows if r['split'] == 'holdout'], 20, rng)
    population = Counter((r['split'], r['stratum']) for r in rows)
    sampled = Counter((r['split'], r['stratum']) for r in selected)
    manifest = {
        'schemaVersion': 'sortfm.calibration.v1', 'userId': snapshot['userId'],
        'featureVersion': FEATURE_VERSION, 'capturedAt': snapshot['capturedAt'],
        'sourceDigest': digest(snapshot), 'populationSize': len(candidates), 'eligibleSize': len(eligible),
        'sampling': {'seed': sampling_seed, 'evaluationSeed': evaluation_seed,
                     'method': 'Proportional recency × musical-bin strata within fixed hash splits',
                     'musicalAxes': axes, 'medianBoundaries': medians,
                     'audioObservedCounts': coverage,
                     'strata': [{'split': split, 'stratum': key, 'population': n,
                                 'selected': sampled[(split, key)]} for (split, key), n in sorted(population.items())]},
        'protocol': {'holdoutSize': 20, 'threshold': .5, 'rankingK': 10,
                     'logisticC': .5, 'audioMinTrain': 24, 'audioMinTrainPerClass': 6,
                     'audioMinHoldout': 12, 'audioMinDescriptors': 3,
                     'audioComparison': 'Same full frozen holdout and same covered subset; no winner selection',
                     'modelSelection': 'None; all models and gates fixed before final labels'},
        'selected': selected,
        'display': {r['trackId']: snapshot.get('display', {}).get(r['trackId'], {}) for r in selected},
    }
    manifest['experimentId'] = digest(manifest)
    return manifest


def _cell(value: str) -> str:
    # Treat titles as text even when opened by a spreadsheet program.
    return "'" + value if value.startswith(('=', '+', '-', '@', '\t', '\r', '\n')) else value


def write_label_sheet(manifest: dict, split: str, path: Path) -> None:
    validate_manifest(manifest)
    if split not in ('train', 'holdout'):
        raise ValueError('Unknown split')
    with Path(path).open('w', newline='') as f:
        Path(path).chmod(0o600)
        writer = csv.DictWriter(f, fieldnames=['experimentId', 'trackId', 'title', 'artists', 'decision'])
        writer.writeheader()
        for row in manifest['selected']:
            if row['split'] != split:
                continue
            display = manifest['display'].get(row['trackId'], {})
            writer.writerow({'experimentId': manifest['experimentId'], 'trackId': row['trackId'],
                             'title': _cell(display.get('title', '')),
                             'artists': _cell(', '.join(display.get('artists', []))), 'decision': ''})


def read_labels(manifest: dict, split: str, path: Path) -> dict[str, int]:
    validate_manifest(manifest)
    expected = {r['trackId'] for r in manifest['selected'] if r['split'] == split}
    labels = {}
    with Path(path).open(newline='') as f:
        for row in csv.DictReader(f):
            if row.get('experimentId') != manifest['experimentId']:
                raise ValueError('Label sheet belongs to a different experiment')
            track = row.get('trackId')
            if track not in expected:
                raise ValueError('Foreign track or wrong split in label sheet')
            if track in labels:
                raise ValueError('Duplicate track in label sheet')
            decision = row.get('decision', '').strip().upper()
            if not decision:
                raise ValueError('Label sheet is incomplete; every selected track needs a listener judgment')
            if decision not in ('KEEP', 'REMOVE'):
                raise ValueError('Only KEEP or REMOVE are calibration labels; neither causes a Spotify mutation')
            labels[track] = int(decision == 'REMOVE')
    if set(labels) != expected:
        raise ValueError('Label sheet is incomplete')
    return labels
