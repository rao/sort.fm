"""Read-only, private research snapshot validation and descriptive auditing."""
from collections import Counter
from copy import deepcopy
from datetime import datetime
import hashlib
import json
from pathlib import Path

import numpy as np

from .features import AUDIO_KEYS, CENTROID_KEYS, FEATURE_KEYS, observed_value
from .schemas import FeatureVector
from .service import RUNTIME


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def identity(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def load_package(path, trusted_artifact=False):
    """Default reads JSON only. Pickle loading requires explicit trusted-local opt-in.

    A digest verifies integrity, not trust. Never pass uploaded/untrusted joblib.
    No database/network/serving-state access is performed.
    """
    path = Path(path)
    raw_path = path / 'database-snapshot.json'
    verification = json.loads((path / 'database-verification.json').read_text())
    if sha256(raw_path) != verification['snapshotSha256']:
        raise ValueError('Database snapshot checksum mismatch')
    raw = json.loads(raw_path.read_text())
    data = raw['snapshot']
    state = json.loads((path / 'model/pinned-state.json').read_text())
    revisions = [data['state'][k] for k in ('feedback_revision', 'target_revision', 'acknowledged_revision')]
    if not data['matched'] or len(set(revisions + [state['revision']])) != 1:
        raise ValueError('Snapshot/model feedback revision mismatch')
    if data['owner'] != state['userId']:
        raise ValueError('Snapshot/model owner mismatch')
    examples = data['trainingExamples']
    for rows, key in [(examples, 'trackId'), (data['assembledCandidates'], 'trackId'), (data['labelContexts'], 'track_id')]:
        if len({r[key] for r in rows}) != len(rows):
            raise ValueError('Duplicate track in snapshot')
    if {r['trackId']: r for r in examples} != state['examples']:
        raise ValueError('Snapshot/model examples mismatch')
    for row in examples:
        if type(row['label']) is not int or row['label'] not in (0, 1) or row['split'] not in ('train', 'holdout'):
            raise ValueError('Invalid active label or split')
        if row['split'] != state['splits'].get(row['trackId']):
            raise ValueError('Snapshot/model split mismatch')
        if row['features']['featureVersion'] != 'sortfm.features.v1':
            raise ValueError('Unsupported feature version')
    contexts = {r['track_id']: r for r in data['labelContexts']}
    if set(contexts) != {r['trackId'] for r in examples}:
        raise ValueError('Active-label context coverage mismatch')
    if any(r['features'] != contexts[r['trackId']]['exposure_payload']['features'] for r in examples):
        raise ValueError('Original exposure feature mismatch')
    model, version = None, None
    provenance = {'database_sha256': sha256(raw_path), 'state_sha256': sha256(path/'model/pinned-state.json'),
                  'data_version': identity(examples), 'snapshot_at': data['state']['snapshot_at'],
                  'revision': revisions[0], 'feature_version': 'sortfm.features.v1'}
    if trusted_artifact:
        import joblib
        index = json.loads((path/'INDEX.json').read_text())
        if index['revision'] != state['revision']:
            raise ValueError('Indexed revision mismatch')
        model_file = (path/index['files']['model']).resolve()
        manifest_file = (path/index['files']['modelManifest']).resolve()
        if not model_file.is_relative_to(path.resolve()) or not manifest_file.is_relative_to(path.resolve()):
            raise ValueError('Artifact must remain inside trusted package')
        manifest = json.loads(manifest_file.read_text())
        if sha256(model_file) != manifest['sha256']:
            raise ValueError('Model checksum mismatch')
        if manifest['runtime'] != RUNTIME:
            raise ValueError('Model numerical runtime mismatch')
        bundle = joblib.load(model_file)
        if bundle['state'] != state:
            raise ValueError('Loaded artifact state mismatch')
        if bundle['version'] != index['modelVersion']:
            raise ValueError('Indexed model version mismatch')
        if bundle['metrics'] != raw['evaluation']:
            raise ValueError('Artifact/deployed evaluation mismatch')
        model, version = bundle['model'], bundle['version']
        if model.trained_examples != sum(r['split'] == 'train' and r['features']['permittedForTraining'] for r in examples):
            raise ValueError('Artifact trained count mismatch')
        provenance.update(model_sha256=manifest['sha256'], model_version=version, model_runtime=manifest['runtime'])
    augmented = audio_augmented_examples(data)
    provenance['audio_derivative'] = {'schema': 'sortfm.research-audio-only.v1',
        'sha256': identity(augmented), 'original_examples_sha256': identity(examples),
        'audio_sources_sha256': identity([{k:c.get(k) for k in ('track_id','current_audio_features')} for c in data['labelContexts']]),
        'method': 'Replace audio keys only from permitted current vectors; original metadata and history frozen',
        'source_counts': dict(Counter(c['current_audio_features']['provenance'] for c in data['labelContexts'] if c.get('current_audio_features')))}
    return {'snapshot': data, 'examples': deepcopy(examples), 'audio_augmented': augmented,
            'state': state, 'model': model, 'model_version': version, 'provenance': provenance}


def audio_augmented_examples(data):
    """Retrospective audio replacement only; never refresh decision-time history."""
    contexts = {r['track_id']: r for r in data['labelContexts']}
    result = deepcopy(data['trainingExamples'])
    for row in result:
        audio = contexts[row['trackId']].get('current_audio_features')
        if not audio or audio.get('permittedForTraining') is not True:
            continue
        FeatureVector.model_validate(audio)
        if audio['provenance'] not in ('musicae', 'soundnet', 'licensed', 'spotify'):
            raise ValueError('Real audio derivative cannot contain synthetic provenance')
        for key in AUDIO_KEYS:
            row['features']['values'].pop(key, None)
            if key in audio['values']:
                row['features']['values'][key] = audio['values'][key]
        # Metadata permission remains authoritative. Audio source identity is
        # preserved in the parent immutable snapshot rather than mislabeling it
        # as a historical exposure. This vector is an experimental derivative.
    return result


def counts(rows):
    return {'n': len(rows), 'keep': sum(r['label'] == 0 for r in rows), 'remove': sum(r['label'] == 1 for r in rows)}


def audio_count(row):
    return sum(observed_value(row['features']['values'], k) is not None for k in AUDIO_KEYS)


def coverage(rows):
    return {'n': len(rows), 'any_audio': sum(audio_count(r) > 0 for r in rows),
            'at_least_three_audio': sum(audio_count(r) >= 3 for r in rows),
            'feature_observed': {k: sum(observed_value(r['features']['values'], k) is not None for r in rows)
                                 for k in FEATURE_KEYS if k not in CENTROID_KEYS}}


def age_band(age):
    return 'missing' if age is None else '<90d' if age < 90 else '90-364d' if age < 365 else '365-1094d' if age < 1095 else '>=1095d'


def age_distribution(rows):
    bands = {k: [] for k in ('<90d', '90-364d', '365-1094d', '>=1095d', 'missing')}
    for r in rows:
        bands[age_band(observed_value(r['features']['values'], 'saved_age_days'))].append(r)
    return {k: {'n': len(v), 'fraction': len(v)/len(rows) if rows else None,
                'audio_covered': sum(audio_count(r) > 0 for r in v),
                'remove': sum(r.get('label') == 1 for r in v) if v and 'label' in v[0] else None}
            for k, v in bands.items()}


def audit_snapshot(data):
    rows = data['trainingExamples']; contexts = {r['track_id']: r for r in data['labelContexts']}
    groups = {s: [r for r in rows if r['split'] == s] for s in ('train', 'holdout')}
    candidates = data['assembledCandidates']; current = {r['trackId']: r for r in candidates}
    enriched = audio_augmented_examples(data)
    ordered = sorted(rows, key=lambda r: (r['labeledAt'], r['trackId']))
    chunks = np.array_split(np.arange(len(ordered)), 4)
    artist_map = {r['track']['trackId']: {('id:'+a['id']) if a.get('id') else ('name:'+a['name'].strip().casefold())
        for a in r['track']['artists'] if a.get('id') or a.get('name','').strip()} for r in data['library']}
    train_artists = set().union(*(artist_map.get(r['trackId'], set()) for r in groups['train']))
    return {'snapshot_at': data['state']['snapshot_at'], 'revision': data['state']['feedback_revision'],
        'counts': {'all_labels': counts(rows), **{s: counts(g) for s,g in groups.items()},
                   'library': len(candidates), 'unlabeled': len(data['unlabeledCurrentLibraryTrackIds']),
                   'calibration_eligible': len(data['calibrationEligibleTrackIds']),
                   'effective_feedback_rows_including_tombstones': len(data['effectiveFeedback']),
                   'not_permitted_training': sum(not r['features']['permittedForTraining'] for r in groups['train'])},
        'coverage': {'label_time': coverage(rows), 'library_current': coverage(candidates),
                     'labeled_audio_augmented': coverage(enriched),
                     **{s: coverage(g) for s,g in groups.items()},
                     'by_split_class': {f'{s}_{y}': coverage([r for r in g if r['label'] == y]) for s,g in groups.items() for y in (0,1)}},
        'age_distribution': {'library_current': age_distribution(candidates), 'label_time': age_distribution(rows),
                             **{s: age_distribution(g) for s,g in groups.items()}},
        'save_years': {'library': dict(sorted(Counter(r['track']['originalAddedAt'][:4] for r in data['library']).items())),
                      'labeled': dict(sorted(Counter(c['original_added_at'][:4] for c in contexts.values()).items()))},
        'selection': {'sources': dict(Counter(c['source'] for c in contexts.values())),
                      'methods': dict(Counter(c['exposure_payload']['exposure']['selectionMethod'] for c in contexts.values())),
                      'known_propensities': sum(c['exposure_payload']['exposure']['propensityEstimate'] is not None for c in contexts.values())},
        'label_time_quartiles': [{'quartile': i+1, **counts([ordered[j] for j in ix]),
                                  'audio': sum(audio_count(ordered[j]) > 0 for j in ix)} for i,ix in enumerate(chunks)],
        'label_time_range': [min((r['labeledAt'] for r in rows), default=None), max((r['labeledAt'] for r in rows), default=None)],
        'audio_changed_rows': sum(a['features']['values'] != b['features']['values'] for a,b in zip(rows,enriched)),
        'holdout_artist_overlap_with_train': sum(bool(artist_map.get(r['trackId'],set()) & train_artists) for r in groups['holdout']),
        'exposure_feature_mismatches': sum(r['features'] != contexts[r['trackId']]['exposure_payload']['features'] for r in rows),
        'label_before_exposure': sum(datetime.fromisoformat(r['labeledAt'].replace('Z','+00:00')) < datetime.fromisoformat(contexts[r['trackId']]['exposure_payload']['exposure']['servedAt'].replace('Z','+00:00')) for r in rows),
        'current_missing_labeled_tracks': sum(r['trackId'] not in current for r in rows)}
