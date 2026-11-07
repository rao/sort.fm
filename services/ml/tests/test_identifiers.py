"""Dotted IDs are data, never artifact paths (shared contract widening)."""
import hashlib
from uuid import uuid4

import pytest
from pydantic import TypeAdapter, ValidationError

from sortfm_ml.app import create_app
from sortfm_ml.schemas import Identifier
from sortfm_ml.service import ModelService, ServiceError
from test_app import AUTH, fit_payload, request, score_payload


@pytest.mark.parametrize('identifier', ['listener.test', 'demo:track.v1', '.', '..', 'a' * 127 + '.'])
def test_dotted_identifiers_are_preserved_exactly(identifier):
    assert TypeAdapter(Identifier).validate_python(identifier) == identifier


@pytest.mark.parametrize('identifier', ['../listener', '/listener', r'..\listener', 'listener%2etest', 'listener\n', '', 'a' * 129])
def test_identifiers_still_reject_paths_encoding_controls_and_invalid_lengths(tmp_path, identifier):
    with pytest.raises(ValidationError):
        TypeAdapter(Identifier).validate_python(identifier)
    with pytest.raises(ServiceError) as error:
        ModelService(tmp_path).evaluation(identifier)
    assert error.value.code == 'BAD_REQUEST'
    assert list(tmp_path.iterdir()) == []


def test_dotted_user_and_track_work_through_all_http_routes_and_restart(tmp_path):
    app = create_app(shared_secret='test-service-secret', storage_dir=tmp_path)
    user_id, track_id = 'demo:listener.test', 'demo:track.v1'
    fit = fit_payload()
    fit['userId'] = user_id
    fit['examples'][0]['trackId'] = track_id
    fitted = request(app, 'POST', '/fit', AUTH, json=fit)
    assert fitted.status_code == 200
    assert fitted.json()['userId'] == user_id

    payload = score_payload()
    payload['userId'] = user_id
    payload['candidates'][0]['trackId'] = track_id
    exposure_id = str(uuid4())
    payload['candidates'][0]['exposureId'] = exposure_id
    scored = request(app, 'POST', '/score', AUTH, json=payload)
    assert scored.status_code == 200
    assert scored.json()['predictions'][0]['trackId'] == track_id

    # Persisted exposure validation must accept the same dotted track on reload.
    restarted = create_app(shared_secret='test-service-secret', storage_dir=tmp_path)
    assert request(restarted, 'POST', '/score', AUTH, json=payload).json() == scored.json()
    explanation = request(restarted, 'GET', '/explain', AUTH,
                          params={'userId': user_id, 'exposureId': exposure_id})
    assert explanation.status_code == 200
    assert explanation.json()['prediction'] == scored.json()['predictions'][0]['prediction']
    assert request(restarted, 'GET', '/evaluation', AUTH, params={'userId': user_id}).status_code == 200
    row = fit['examples'][0]
    observed = request(restarted, 'POST', '/observe', AUTH, json={
        'userId': user_id, 'trackId': track_id, 'eventId': str(uuid4()),
        'decisionId': row['decisionId'], 'exposureId': exposure_id,
        'feedbackRevision': fit['feedbackRevision'] + 1, 'operation': 'revoke',
        'label': None, 'features': row['features'], 'occurredAt': row['labeledAt'],
    })
    assert observed.status_code == 200
    assert observed.json()['accepted'] is True


def test_dot_and_dotdot_users_are_distinct_hashed_storage_keys(tmp_path):
    root = tmp_path / 'artifacts'
    service = ModelService(root)
    users = ['.', '..', 'demo:listener.test']
    versions = {}
    for user in users:
        payload = score_payload()
        payload['userId'] = user
        versions[user] = service.score(payload)['modelVersion']
    expected = {hashlib.sha256(user.encode()).hexdigest() for user in users}
    assert {path.name for path in root.iterdir()} == expected
    assert {path.name for path in tmp_path.iterdir()} == {'artifacts'}
    assert all(path.parent == root for path in root.iterdir())
    for user in users:
        assert ModelService(root).evaluation(user)['modelVersion'] == versions[user]
    with pytest.raises(ServiceError) as error:
        service.evaluation('.', versions['..'])
    assert error.value.code == 'MODEL_NOT_FOUND'
