"""Per-user feedback ledger and immutable, atomically published model snapshots.

The artifact directory is trusted server storage, never an upload target. A single
local filesystem (POSIX flock + atomic rename) supports threads/processes; separate
replicas require shared coordination and are not supported by this adapter.
"""
from __future__ import annotations

from contextlib import contextmanager
from copy import deepcopy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
from typing import Iterator

import joblib
import numpy as np
import sklearn

from .evaluate import evaluate_model
from .model import PreferenceModel
from .schemas import Prediction

FEATURE_VERSION = 'sortfm.features.v1'
ENGINE_VERSION = 'c1-logistic-v1'
RUNTIME = {'numpy': np.__version__, 'sklearn': sklearn.__version__, 'engine': ENGINE_VERSION}
VERSION_PATTERN = re.compile(r'^c1-r[0-9]+-[a-f0-9]{24}$')
ID_PATTERN = re.compile(r'^[a-zA-Z0-9:_-]{1,128}$')


class ServiceError(Exception):
    def __init__(self, status: int, code: str, message: str, retryable: bool = False):
        super().__init__(message)
        self.status, self.code, self.message, self.retryable = status, code, message, retryable


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def digest(value: object) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


def atomic_bytes(path: Path, data: bytes) -> None:
    fd, name = tempfile.mkstemp(prefix='.pending-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if os.path.exists(name):
            os.unlink(name)


class ModelService:
    def __init__(self, storage_dir: str | Path):
        self.storage_dir = Path(storage_dir)

    @contextmanager
    def _locked(self, user_id: str) -> Iterator[Path]:
        if not isinstance(user_id, str) or not ID_PATTERN.fullmatch(user_id):
            raise ServiceError(422, 'BAD_REQUEST', 'Invalid user identifier.')
        folder = self.storage_dir / hashlib.sha256(user_id.encode()).hexdigest()
        try:
            folder.mkdir(parents=True, exist_ok=True, mode=0o700)
            lock_fd = os.open(folder / '.lock', os.O_RDWR | os.O_CREAT, 0o600)
            with os.fdopen(lock_fd, 'a+b') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                try:
                    yield folder
                finally:
                    fcntl.flock(lock, fcntl.LOCK_UN)
        except OSError as exc:
            raise ServiceError(503, 'STORAGE_UNAVAILABLE', 'Model storage is unavailable.', True) from exc

    @staticmethod
    def _empty(user_id: str) -> dict:
        return {'userId': user_id, 'revision': -1, 'seed': 42, 'examples': {},
                'splits': {}, 'decisions': {}, 'events': {}, 'fitFingerprint': None}

    def _load(self, folder: Path, user_id: str, version: str | None = None) -> dict:
        if version is None:
            if not (folder / 'current.json').exists():
                if any(path.suffix in ('.json', '.joblib') for path in folder.iterdir()):
                    raise ServiceError(503, 'ARTIFACT_UNAVAILABLE',
                        'Current model manifest is missing from existing state; restore a verified snapshot.')
                return self._publish(folder, self._empty(user_id))
            try:
                version = json.loads((folder / 'current.json').read_text())['modelVersion']
            except (ValueError, KeyError, TypeError) as exc:
                raise ServiceError(503, 'ARTIFACT_UNAVAILABLE', 'Current model manifest is invalid.') from exc
        if not isinstance(version, str) or not VERSION_PATTERN.fullmatch(version):
            raise ServiceError(404, 'MODEL_NOT_FOUND', 'The requested model version is not available for this user.')
        artifact = folder / f'{version}.joblib'
        manifest = folder / f'{version}.json'
        if not artifact.exists() or not manifest.exists():
            raise ServiceError(404, 'MODEL_NOT_FOUND', 'The requested model version is not available for this user.')
        try:
            info = json.loads(manifest.read_text())
            if info['runtime'] != RUNTIME or info['sha256'] != hashlib.sha256(artifact.read_bytes()).hexdigest():
                raise ValueError('Artifact integrity or runtime mismatch')
            bundle = joblib.load(artifact)
            if bundle['state']['userId'] != user_id or bundle['version'] != version:
                raise ValueError('Artifact identity mismatch')
            return bundle
        except Exception as exc:
            raise ServiceError(503, 'ARTIFACT_UNAVAILABLE', 'Model artifact cannot be loaded with this runtime.') from exc

    def _publish(self, folder: Path, state: dict) -> dict:
        state = deepcopy(state)
        examples = sorted(state['examples'].values(), key=lambda row: (row['trackId'], row['decisionId']))
        identity = deepcopy(state)
        for event in identity['events'].values():
            event['response']['modelVersion'] = None
        version = f"c1-r{max(0, state['revision'])}-{digest({'state':identity,'runtime':RUNTIME})[:24]}"
        for event in state['events'].values():
            if event['response']['modelVersion'] is None:
                event['response']['modelVersion'] = version
        artifact = folder / f'{version}.joblib'
        # A retry after a crash may find a complete unpublished immutable artifact.
        if artifact.exists() and (folder / f'{version}.json').exists():
            bundle = self._load(folder, state['userId'], version)
        else:
            model = PreferenceModel(examples, seed=state['seed'])
            metrics = evaluate_model(model, examples, version)
            bundle = {'version':version, 'state':state, 'model':model, 'metrics':metrics}
            fd, name = tempfile.mkstemp(prefix='.model-', dir=folder)
            os.close(fd)
            try:
                joblib.dump(bundle, name, compress=3)
                with open(name, 'rb') as stream:
                    os.fsync(stream.fileno())
                    checksum = hashlib.sha256(stream.read()).hexdigest()
                os.replace(name, artifact)
                atomic_bytes(folder / f'{version}.json', canonical({'runtime':RUNTIME,'sha256':checksum}))
            finally:
                if os.path.exists(name):
                    os.unlink(name)
        atomic_bytes(folder / 'current.json', canonical({'modelVersion':version}))
        return bundle

    @staticmethod
    def _feature_version(payload: dict) -> None:
        if payload.get('featureVersion') != FEATURE_VERSION:
            raise ServiceError(422, 'FEATURE_VERSION_UNSUPPORTED', 'Unsupported feature version.')

    @staticmethod
    def _rights(examples: list[dict]) -> None:
        if any(not row['features']['permittedForTraining'] for row in examples):
            raise ServiceError(422, 'TRAINING_NOT_PERMITTED', 'Every labeled example must be permitted for training.')
        sources = {row['features']['provenance'] == 'synthetic' for row in examples}
        if len(sources) > 1:
            raise ServiceError(422, 'MIXED_DATASET', 'Synthetic and real feedback must be separate experiments.')

    @staticmethod
    def _fit_response(bundle: dict) -> dict:
        return {'userId':bundle['state']['userId'], 'modelVersion':bundle['version'],
                'featureVersion':FEATURE_VERSION, 'feedbackRevision':max(0,bundle['state']['revision']),
                'trainedExamples':bundle['model'].trained_examples, 'metrics':deepcopy(bundle['metrics'])}

    def fit(self, payload: dict) -> dict:
        self._feature_version(payload)
        fingerprint = digest(payload)
        with self._locked(payload['userId']) as folder:
            previous = self._load(folder, payload['userId'])
            state = deepcopy(previous['state'])
            revision = payload['feedbackRevision']
            if revision <= state['revision']:
                if revision == state['revision'] and state['fitFingerprint'] == fingerprint:
                    return self._fit_response(previous)
                raise ServiceError(409, 'STALE_REVISION', 'Fit requires a newer feedback revision or an identical retry.')
            if state['revision'] >= 0 and payload['evaluationSeed'] != state['seed']:
                raise ServiceError(409, 'SPLIT_CONFLICT', 'Evaluation seed is fixed for this user experiment.')
            examples = deepcopy(payload['examples'])
            self._rights(examples)
            if len({e['trackId'] for e in examples}) != len(examples) or len({e['decisionId'] for e in examples}) != len(examples):
                raise ServiceError(422, 'DUPLICATE_EXAMPLE', 'Use one active decision per track and one track per decision.')
            for row in examples:
                track, decision = row['trackId'], row['decisionId']
                if track in state['splits'] and state['splits'][track] != row['split']:
                    raise ServiceError(409, 'SPLIT_CONFLICT', 'A track cannot move between training and holdout.')
                if decision in state['decisions'] and state['decisions'][decision] != track:
                    raise ServiceError(409, 'DECISION_CONFLICT', 'A decision cannot identify a different track.')
                state['splits'][track] = row['split']
                state['decisions'][decision] = track
            state.update(revision=revision, seed=payload['evaluationSeed'],
                         examples={e['trackId']:e for e in examples}, fitFingerprint=fingerprint)
            return self._fit_response(self._publish(folder, state))

    @staticmethod
    def _read_exposures(folder: Path) -> dict:
        path = folder / 'exposures.json'
        try:
            exposures = json.loads(path.read_text()) if path.exists() else {}
            if not isinstance(exposures, dict):
                raise ValueError('Exposure store must be an object')
            for key, entry in exposures.items():
                if not isinstance(key, str) or not isinstance(entry, dict):
                    raise ValueError('Invalid exposure entry')
                if not {'trackId', 'modelVersion', 'prediction'} <= entry.keys():
                    raise ValueError('Incomplete exposure entry')
                if not isinstance(entry['trackId'], str) or not ID_PATTERN.fullmatch(entry['trackId']):
                    raise ValueError('Invalid track identity')
                if not isinstance(entry['modelVersion'], str) or not VERSION_PATTERN.fullmatch(entry['modelVersion']):
                    raise ValueError('Invalid model identity')
                prediction = Prediction.model_validate(entry['prediction'])
                if prediction.modelVersion != entry['modelVersion']:
                    raise ValueError('Exposure prediction version mismatch')
                if 'fingerprint' in entry and (not isinstance(entry['fingerprint'], str)
                    or not re.fullmatch(r'[a-f0-9]{64}', entry['fingerprint'])):
                    raise ValueError('Invalid exposure fingerprint')
            return exposures
        except (ValueError, TypeError) as exc:
            raise ServiceError(503, 'ARTIFACT_UNAVAILABLE', 'Exposure storage is invalid.') from exc

    def score(self, payload: dict) -> dict:
        self._feature_version(payload)
        with self._locked(payload['userId']) as folder:
            path = folder / 'exposures.json'
            exposures = self._read_exposures(folder)
            requested_version = payload.get('modelVersion')
            fixed_versions = set()
            fingerprints = {}
            for candidate in payload['candidates']:
                exposure_id = candidate.get('exposureId')
                if exposure_id is None:
                    continue
                fingerprint = digest({'trackId':candidate['trackId'], 'features':candidate['features']})
                if exposure_id in fingerprints and fingerprints[exposure_id] != fingerprint:
                    raise ServiceError(409, 'EXPOSURE_CONFLICT', 'A batch cannot reuse an exposure for different candidates.')
                fingerprints[exposure_id] = fingerprint
                if exposure_id in exposures:
                    saved = exposures[exposure_id]
                    if (saved.get('fingerprint') != fingerprint or
                        (requested_version is not None and requested_version != saved['modelVersion'])):
                        raise ServiceError(409, 'EXPOSURE_CONFLICT', 'Exposure track, features and model version are immutable.')
                    fixed_versions.add(saved['modelVersion'])
            if len(fixed_versions) > 1:
                raise ServiceError(409, 'EXPOSURE_CONFLICT', 'Score each immutable model version in a separate batch.')
            resolved_version = requested_version or next(iter(fixed_versions), None)
            bundle = self._load(folder, payload['userId'], resolved_version)
            fresh_indices = [index for index, candidate in enumerate(payload['candidates'])
                             if candidate.get('exposureId') not in exposures]
            fresh_candidates = [payload['candidates'][index] for index in fresh_indices]
            fresh = dict(zip(fresh_indices, bundle['model'].predict(fresh_candidates, bundle['version'])))
            predictions = []
            changed = False
            for index, candidate in enumerate(payload['candidates']):
                exposure_id = candidate.get('exposureId')
                if exposure_id in exposures:
                    prediction = deepcopy(exposures[exposure_id]['prediction'])
                else:
                    prediction = fresh[index]['prediction']
                    if exposure_id is not None:
                        exposures[exposure_id] = {'trackId':candidate['trackId'],
                            'modelVersion':bundle['version'], 'prediction':deepcopy(prediction),
                            'fingerprint':fingerprints[exposure_id]}
                        changed = True
                predictions.append({'trackId':candidate['trackId'], 'prediction':prediction})
            if changed:
                atomic_bytes(path, canonical(exposures))
            return {'userId':payload['userId'], 'modelVersion':bundle['version'],
                    'featureVersion':FEATURE_VERSION, 'predictions':predictions}

    def observe(self, payload: dict) -> dict:
        with self._locked(payload['userId']) as folder:
            bundle = self._load(folder, payload['userId'])
            state = deepcopy(bundle['state'])
            fingerprint = digest(payload)
            prior_event = state['events'].get(payload['eventId'])
            if prior_event:
                if prior_event['fingerprint'] != fingerprint:
                    raise ServiceError(409, 'IDEMPOTENCY_CONFLICT', 'An event ID cannot be reused with different contents.')
                return deepcopy(prior_event['response'])
            if payload['feedbackRevision'] <= state['revision']:
                raise ServiceError(409, 'STALE_REVISION', 'Feedback revision must advance monotonically.')
            track, decision = payload['trackId'], payload['decisionId']
            if decision in state['decisions'] and state['decisions'][decision] != track:
                raise ServiceError(409, 'DECISION_CONFLICT', 'A decision cannot identify a different track.')
            if payload['operation'] == 'revoke':
                if payload['label'] is not None:
                    raise ServiceError(422, 'BAD_REQUEST', 'Revocation must not contain a label.')
                if decision not in state['decisions']:
                    raise ServiceError(404, 'UNKNOWN_DECISION', 'The decision to revoke is unknown for this user.')
                if track in state['examples'] and state['examples'][track]['decisionId'] == decision:
                    del state['examples'][track]
            else:
                state['decisions'][decision] = track
                if payload['label'] is not None:
                    self._rights([payload])
                    if track not in state['splits']:
                        key = digest([state['seed'], payload['userId'], track])
                        state['splits'][track] = 'holdout' if int(key[:16],16) % 5 == 0 else 'train'
                    state['examples'][track] = {'trackId':track, 'decisionId':decision,
                        'features':deepcopy(payload['features']), 'label':payload['label'],
                        'split':state['splits'][track], 'labeledAt':payload['occurredAt']}
                    self._rights(list(state['examples'].values()))
            state['revision'] = payload['feedbackRevision']
            state['fitFingerprint'] = None
            # Response points at this event's version; avoid circular version hashes.
            response = {'accepted':True, 'feedbackRevision':state['revision'], 'modelVersion':None}
            state['events'][payload['eventId']] = {'fingerprint':fingerprint, 'response':response}
            new_bundle = self._publish(folder, state)
            return deepcopy(new_bundle['state']['events'][payload['eventId']]['response'])

    def evaluation(self, user_id: str, model_version: str | None = None) -> dict:
        with self._locked(user_id) as folder:
            return deepcopy(self._load(folder, user_id, model_version)['metrics'])

    def _register_many(self, folder: Path, registrations: list[tuple], model_version: str) -> None:
        path = folder / 'exposures.json'
        exposures = self._read_exposures(folder)
        for exposure_id, track_id, prediction in registrations:
            value = {'trackId':track_id, 'modelVersion':model_version, 'prediction':deepcopy(prediction)}
            if exposure_id in exposures and exposures[exposure_id] != value:
                raise ServiceError(409, 'EXPOSURE_CONFLICT', 'An exposure must preserve its original prediction.')
            exposures[exposure_id] = value
        atomic_bytes(path, canonical(exposures))

    def register_exposure(self, user_id: str, exposure_id: str, track_id: str,
                          model_version: str, prediction: dict) -> None:
        with self._locked(user_id) as folder:
            self._load(folder, user_id, model_version)
            if prediction['modelVersion'] != model_version:
                raise ServiceError(409, 'EXPOSURE_CONFLICT', 'Prediction version must match exposure version.')
            self._register_many(folder, [(exposure_id, track_id, prediction)], model_version)

    def explain(self, user_id: str, exposure_id: str) -> dict:
        with self._locked(user_id) as folder:
            path = folder / 'exposures.json'
            exposures = self._read_exposures(folder)
            if exposure_id not in exposures:
                raise ServiceError(404, 'EXPOSURE_NOT_FOUND', 'No prediction snapshot was registered for this exposure.')
            return {'exposureId':exposure_id, 'prediction':deepcopy(exposures[exposure_id]['prediction'])}
