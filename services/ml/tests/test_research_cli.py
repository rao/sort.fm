from pathlib import Path
from copy import deepcopy
import hashlib
import json
import pytest

from sortfm_ml.research_cli import private_destination


def test_output_must_be_private_new_and_non_symlinked(tmp_path):
    with pytest.raises(ValueError,match='private-data'):
        private_destination(tmp_path/'public')
    target=tmp_path/'private-data'/'run'
    assert private_destination(target)==target.resolve()
    assert target.stat().st_mode & 0o777 == 0o700
    with pytest.raises(ValueError,match='exists'):
        private_destination(target)
    link=tmp_path/'private-data'/'link';link.symlink_to(tmp_path,target_is_directory=True)
    with pytest.raises(ValueError,match='symlink'):
        private_destination(link/'run2')


def test_parent_traversal_cannot_escape_private_output_or_change_parent_mode(tmp_path):
    before=tmp_path.stat().st_mode
    with pytest.raises(ValueError,match='traversal'):
        private_destination(tmp_path/'private-data'/'..'/'public-run')
    assert not (tmp_path/'public-run').exists()
    assert tmp_path.stat().st_mode==before


@pytest.mark.parametrize('reference', ['/tmp/model.joblib', '../model.joblib', 'model/../../model.joblib'])
def test_index_paths_cannot_escape_frozen_inputs(tmp_path, reference):
    from sortfm_ml.research_cli import freeze_inputs
    source=tmp_path/'source';source.mkdir()
    (source/'INDEX.json').write_text(json.dumps({'files':{'model':reference,'modelManifest':'model/model.json'}}))
    destination=tmp_path/'inputs'
    with pytest.raises(ValueError,match='relative|traversal'):
        freeze_inputs(source,destination,trusted_artifact=True)
    assert not destination.exists()


def test_frozen_package_remains_valid_after_original_changes(tmp_path):
    from test_research_data import package
    from sortfm_ml.research_cli import freeze_inputs
    from sortfm_ml.research_data import load_package
    source=tmp_path/'source';source.mkdir();package(source)
    destination=tmp_path/'inputs'
    hashes=freeze_inputs(source,destination)
    (source/'database-snapshot.json').write_text('changed after freeze')
    loaded=load_package(destination)
    assert loaded['provenance']['database_sha256']==hashes['database-snapshot.json']
    for name,expected in hashes.items():
        assert hashlib.sha256((destination/name).read_bytes()).hexdigest()==expected
        assert (destination/name).stat().st_mode & 0o777 == 0o600
    assert 'INDEX.json' not in hashes


def test_freeze_rejects_out_of_package_symlink_and_checksum_changes(tmp_path):
    from test_research_data import package
    from sortfm_ml.research_cli import freeze_inputs
    source=tmp_path/'source';source.mkdir();package(source)
    raw=source/'database-snapshot.json'
    contents=raw.read_bytes();raw.unlink()
    elsewhere=tmp_path/'elsewhere.json';elsewhere.write_bytes(contents)
    raw.symlink_to(elsewhere)
    with pytest.raises(ValueError,match='package'):
        freeze_inputs(source,tmp_path/'outside')
    raw.unlink();raw.write_bytes(b'changed')
    with pytest.raises(ValueError,match='checksum'):
        freeze_inputs(source,tmp_path/'changed')


def test_trusted_freeze_checks_model_bytes_and_default_never_reads_index(tmp_path):
    from test_research_data import package
    from sortfm_ml.research_cli import freeze_inputs
    source=tmp_path/'source';source.mkdir();package(source)
    (source/'INDEX.json').write_text('not JSON; default mode must ignore it')
    assert 'INDEX.json' not in freeze_inputs(source,tmp_path/'json-only')
    model_bytes=b'fake artifact bytes for checksum-only test; never deserialized'
    (source/'model/artifact.joblib').write_bytes(model_bytes)
    (source/'model/manifest.json').write_text(json.dumps({'sha256':hashlib.sha256(model_bytes).hexdigest()}))
    (source/'INDEX.json').write_text(json.dumps({'files':{'model':'model/artifact.joblib',
                                                        'modelManifest':'model/manifest.json'}}))
    hashes=freeze_inputs(source,tmp_path/'trusted',trusted_artifact=True)
    assert hashes['model/artifact.joblib']==hashlib.sha256(model_bytes).hexdigest()
    (source/'model/artifact.joblib').write_bytes(b'changed')
    with pytest.raises(ValueError,match='Model checksum'):
        freeze_inputs(source,tmp_path/'corrupt',trusted_artifact=True)


def sampling_package():
    from sortfm_ml.cli import generate_synthetic
    from sortfm_ml.model import PreferenceModel
    generated=generate_synthetic(size=300)
    active=[r for r in generated['examples'] if r['split']=='train'][:30]
    candidates=[{'trackId':r['trackId'],'features':deepcopy(r['features'])} for r in generated['examples']]
    # Exercise normalization: raw JSON int values become schema floats.
    for row in candidates: row['features']['values']['saved_age_days']=100
    return {'snapshot':{'assembledCandidates':candidates,
                         'state':{'snapshot_at':'2026-11-07T12:00:00Z'},
                         'effectiveFeedback':[],
                         'calibrationEligibleTrackIds':[r['trackId'] for r in candidates]},
            'state':{'userId':'demo:synthetic-listener','seed':42,'revision':1,
                     'splits':{r['trackId']:r['split'] for r in active}},
            'examples':active,'model':PreferenceModel(active,seed=42),
            'model_version':'fixture-v1','provenance':{'model_sha256':'a'*64}}


def test_sampling_normalizes_features_and_replays_without_mutating_snapshot():
    from sortfm_ml.research_cli import sampling_reference
    from sortfm_ml.research_sampling import replay_sampling
    package=sampling_package();before=deepcopy(package['snapshot'])
    manifest=sampling_reference(package)
    assert len(manifest['draws'])==90
    assert replay_sampling(manifest)==manifest
    assert package['snapshot']==before


def test_sampling_preserves_database_tombstone_absent_from_ml_ledger():
    from sortfm_ml.cli import split_for_track
    from sortfm_ml.research_cli import sampling_reference
    package=sampling_package()
    track=next(r['trackId'] for r in package['snapshot']['assembledCandidates']
               if split_for_track(package['state']['userId'],r['trackId'],42)=='holdout')
    package['snapshot']['effectiveFeedback']=[{'track_id':track,'split':'holdout','label':None,
                                               'revoked':True,'revision':1}]
    manifest=sampling_reference(package)
    assert track not in manifest['pools']['evaluation']
    assert next(r for r in manifest['roleRegistry'] if r['trackId']==track)['feedbackState']=='revoked'
    package['state']['splits'][track]='train'
    with pytest.raises(ValueError,match='split'):
        sampling_reference(package)


def test_sampling_unavailable_is_explicit_for_no_artifact_or_small_pools():
    from sortfm_ml.research_cli import sampling_reference
    package=sampling_package();package['snapshot']['calibrationEligibleTrackIds']=[]
    result=sampling_reference(package)
    assert result['status']=='unavailable' and result['reason']=='insufficient_sampling_pool'
    assert result['eligible_counts']=={'evaluation':0,'training':0}
    package['model']=None
    assert sampling_reference(package)['reason']=='pinned_model_required'


def test_json_only_run_produces_private_report_and_verified_frozen_inputs(tmp_path):
    pytest.importorskip('matplotlib')
    from test_research_data import fixture
    from sortfm_ml.research_cli import run
    data=fixture();original=deepcopy(data)
    for key in ('trainingExamples','labelContexts','assembledCandidates','library'): data[key]=[]
    for i in range(4):
        track=f'fixture:{i}';split='train' if i<2 else 'holdout'
        row=deepcopy(original['trainingExamples'][0]);row.update(trackId=track,split=split,label=i%2)
        data['trainingExamples'].append(row)
        context=deepcopy(original['labelContexts'][0]);context['track_id']=track
        data['labelContexts'].append(context)
        candidate=deepcopy(original['assembledCandidates'][0]);candidate['trackId']=track
        data['assembledCandidates'].append(candidate)
        entry=deepcopy(original['library'][0]);entry['track']['trackId']=track
        data['library'].append(entry)
    source=tmp_path/'source';source.mkdir();(source/'model').mkdir()
    raw=json.dumps({'snapshot':data,'capturedAt':'2026-01-03T00:00:00Z'})
    (source/'database-snapshot.json').write_text(raw)
    (source/'database-verification.json').write_text(json.dumps({'snapshotSha256':hashlib.sha256(raw.encode()).hexdigest()}))
    (source/'model/pinned-state.json').write_text(json.dumps({'userId':data['owner'],'revision':1,'seed':42,
        'examples':{r['trackId']:r for r in data['trainingExamples']},
        'splits':{r['trackId']:r['split'] for r in data['trainingExamples']}}))
    output=run(source,tmp_path/'private-data'/'run',repeats=1)
    assert (output/'report.md').exists()
    assert 'fixture-owner' not in (output/'report.md').read_text()
    assert all(f'fixture:{i}' not in (output/'report.md').read_text() for i in range(4))
    assert json.loads((output/'sampling-reference.json').read_text())['reason']=='pinned_model_required'
    report=json.loads((output/'results.json').read_text())
    assert report['input_files']['database-snapshot.json']==report['provenance']['database_sha256']
    manifest=json.loads((output/'manifest.json').read_text())
    assert all(hashlib.sha256((output/name).read_bytes()).hexdigest()==checksum
               for name,checksum in manifest['files'].items())
    assert all(p.stat().st_mode & 0o777==(0o700 if p.is_dir() else 0o600) for p in output.rglob('*'))
