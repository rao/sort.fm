from copy import deepcopy
import hashlib
import json
from types import SimpleNamespace

import pytest

from sortfm_ml.research_data import audit_snapshot, audio_augmented_examples, load_package
from sortfm_ml.service import RUNTIME


def fixture():
    f = {'featureVersion': 'sortfm.features.v1', 'values': {'saved_age_days': 900, 'energy': .2},
         'provenance': 'spotify', 'permittedForTraining': True}
    row = {'trackId': 'fixture', 'decisionId': 'd', 'label': 1, 'split': 'train',
           'labeledAt': '2026-01-02T00:00:00Z', 'features': f}
    return {'matched': True, 'owner': 'fixture-owner', 'state': {'feedback_revision': 1,
        'target_revision': 1, 'acknowledged_revision': 1, 'snapshot_at': '2026-01-03T00:00:00Z'},
        'trainingExamples': [row], 'effectiveFeedback': [], 'labelContexts': [{
        'track_id': 'fixture', 'source': 'calibration', 'original_added_at': '2020-01-01T00:00:00Z',
        'current_audio_features': {'featureVersion': 'sortfm.features.v1', 'values': {'energy': .8}, 'permittedForTraining': True, 'provenance': 'musicae'},
        'exposure_payload': {'features': deepcopy(f), 'exposure': {'selectionMethod': 'diverse',
        'propensityEstimate': None, 'servedAt': '2026-01-01T00:00:00Z'}}}],
        'library': [{'track': {'trackId': 'fixture', 'originalAddedAt': '2020-01-01T00:00:00Z', 'artists': []}}],
        'assembledCandidates': [{'trackId': 'fixture', 'features': deepcopy(f)}],
        'calibrationEligibleTrackIds': [], 'unlabeledCurrentLibraryTrackIds': []}


def test_audio_augmentation_never_refreshes_recency_or_mutates_original():
    data = fixture(); before = deepcopy(data)
    data['assembledCandidates'][0]['features']['values']['saved_age_days'] = 5000
    augmented = audio_augmented_examples(data)
    assert augmented[0]['features']['values'] == {'saved_age_days': 900, 'energy': .8}
    assert data['trainingExamples'] == before['trainingExamples']
    data['labelContexts'][0]['current_audio_features']['permittedForTraining'] = False
    assert audio_augmented_examples(data) == data['trainingExamples']


def test_audit_retains_selection_unknown_and_original_audio_population():
    report = audit_snapshot(fixture())
    assert report['counts']['train'] == {'n': 1, 'keep': 0, 'remove': 1}
    assert report['coverage']['label_time']['any_audio'] == 1
    assert report['selection']['known_propensities'] == 0
    assert report['exposure_feature_mismatches'] == 0
    assert 'fixture-owner' not in json.dumps(report)
    assert 'fixture' not in json.dumps(report['counts'])


@pytest.mark.parametrize('field,value', [('featureVersion','wrong'), ('provenance','synthetic'), ('values',{'energy': float('nan')})])
def test_audio_derivative_rejects_incompatible_or_synthetic_source(field,value):
    data = fixture()
    data['labelContexts'][0]['current_audio_features'][field] = value
    with pytest.raises(ValueError):
        audio_augmented_examples(data)


def test_missing_artist_id_does_not_create_false_group_overlap():
    data = fixture()
    second = deepcopy(data['trainingExamples'][0]); second.update(trackId='second',split='holdout')
    data['trainingExamples'].append(second)
    context = deepcopy(data['labelContexts'][0]); context['track_id']='second'; data['labelContexts'].append(context)
    data['library'][0]['track']['artists']=[{'id': None, 'name':'First artist'}]
    second_track=deepcopy(data['library'][0]); second_track['track'].update(trackId='second',artists=[{'id':None,'name':'Other artist'}])
    data['library'].append(second_track)
    assert audit_snapshot(data)['holdout_artist_overlap_with_train'] == 0


def package(tmp_path):
    data = fixture(); raw = json.dumps({'snapshot': data, 'capturedAt': '2026-01-03T00:00:00Z'})
    (tmp_path/'database-snapshot.json').write_text(raw)
    (tmp_path/'database-verification.json').write_text(json.dumps({'snapshotSha256': hashlib.sha256(raw.encode()).hexdigest()}))
    (tmp_path/'model').mkdir()
    state = {'userId': data['owner'], 'revision': 1, 'examples': {'fixture': data['trainingExamples'][0]},
             'splits': {'fixture': 'train'}, 'seed': 42}
    (tmp_path/'model/pinned-state.json').write_text(json.dumps(state))
    return tmp_path


def test_load_requires_integrity_and_reconciled_revision(tmp_path):
    path = package(tmp_path)
    assert len(load_package(path)['examples']) == 1
    data = json.loads((path/'database-snapshot.json').read_text())
    data['snapshot']['state']['acknowledged_revision'] = 0
    raw = json.dumps(data); (path/'database-snapshot.json').write_text(raw)
    with pytest.raises(ValueError, match='checksum'):
        load_package(path)
    (path/'database-verification.json').write_text(json.dumps({'snapshotSha256': hashlib.sha256(raw.encode()).hexdigest()}))
    with pytest.raises(ValueError, match='revision'):
        load_package(path)


def test_load_rejects_duplicate_tracks_even_with_valid_checksum(tmp_path):
    path = package(tmp_path)
    data = json.loads((path/'database-snapshot.json').read_text())
    data['snapshot']['trainingExamples'] *= 2
    raw = json.dumps(data); (path/'database-snapshot.json').write_text(raw)
    (path/'database-verification.json').write_text(json.dumps({'snapshotSha256': hashlib.sha256(raw.encode()).hexdigest()}))
    with pytest.raises(ValueError, match='Duplicate'):
        load_package(path)


@pytest.mark.parametrize('mutation,message', [('version','version'), ('engine','runtime'), ('revision','revision'), ('metrics','evaluation')])
def test_trusted_model_identity_must_match_index_and_deployed_evaluation(tmp_path,mutation,message):
    import joblib
    path=package(tmp_path)
    raw=json.loads((path/'database-snapshot.json').read_text());raw['evaluation']={'fixture':True}
    encoded=json.dumps(raw);(path/'database-snapshot.json').write_text(encoded)
    (path/'database-verification.json').write_text(json.dumps({'snapshotSha256':hashlib.sha256(encoded.encode()).hexdigest()}))
    state=json.loads((path/'model/pinned-state.json').read_text())
    bundle={'state':state,'version':'fixture-v1','metrics':raw['evaluation'],'model':SimpleNamespace(trained_examples=1)}
    index={'files':{'model':'model/test.joblib','modelManifest':'model/test.json'},'revision':1,'modelVersion':'fixture-v1'}
    runtime=dict(RUNTIME)
    if mutation=='version':index['modelVersion']='other'
    if mutation=='revision':index['revision']=2
    if mutation=='engine':runtime['engine']='wrong-engine'
    if mutation=='metrics':bundle['metrics']={'different':True}
    joblib.dump(bundle,path/'model/test.joblib')
    manifest={'runtime':runtime,'sha256':hashlib.sha256((path/'model/test.joblib').read_bytes()).hexdigest()}
    (path/'model/test.json').write_text(json.dumps(manifest));(path/'INDEX.json').write_text(json.dumps(index))
    with pytest.raises(ValueError,match=message):
        load_package(path,trusted_artifact=True)
