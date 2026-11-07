"""Feedback is state, not an append-only bag of independent labels."""
from copy import deepcopy
from uuid import UUID

import pytest

from sortfm_ml.service import ModelService, ServiceError

FEATURE_VERSION = 'sortfm.features.v1'


def candidate(i=0):
    return {'trackId': f'demo:{i}', 'features': {'featureVersion': FEATURE_VERSION,
        'values': {'energy': (i % 10) / 10}, 'provenance': 'synthetic', 'permittedForTraining': True}}


def fit_payload(n=40, revision=1):
    examples = [dict(candidate(i), decisionId=str(UUID(int=i+1)), label=i % 2,
        split='train' if i < 20 else 'holdout', labeledAt='2026-11-07T12:00:00Z') for i in range(n)]
    return {'userId':'demo:user', 'featureVersion':FEATURE_VERSION, 'feedbackRevision':revision,
            'examples':examples, 'evaluationSeed':42}


def event(i=80, revision=2, label=1):
    return dict(candidate(i), userId='demo:user', eventId=str(UUID(int=1000+revision)),
        decisionId=str(UUID(int=i+1)), exposureId=str(UUID(int=i+2000)),
        feedbackRevision=revision, operation='upsert', label=label, occurredAt='2026-11-07T13:00:00Z')


def score(service, version=None, user='demo:user'):
    return service.score({'userId':user,'featureVersion':FEATURE_VERSION,'candidates':[candidate(99)],'modelVersion':version})


def test_fit_restart_and_pinned_scores(tmp_path):
    service=ModelService(tmp_path)
    initial=score(service)
    fitted=service.fit(fit_payload())
    predicted=score(service)
    assert predicted['modelVersion']==fitted['modelVersion']
    assert predicted['predictions'][0]['prediction']['trainedExamples']==20
    assert score(ModelService(tmp_path))==predicted
    assert score(service,initial['modelVersion'])==initial
    service.observe(event())
    assert score(service,predicted['modelVersion'])==predicted
    assert score(service)['modelVersion']!=predicted['modelVersion']


def test_fit_replay_and_conflicting_revision(tmp_path):
    service=ModelService(tmp_path)
    payload=fit_payload()
    assert service.fit(payload)==service.fit(deepcopy(payload))
    payload['examples'][0]['label']=1
    with pytest.raises(ServiceError) as error: service.fit(payload)
    assert error.value.status==409


def test_observe_idempotency_and_skip(tmp_path):
    service=ModelService(tmp_path); service.fit(fit_payload())
    e=event(label=None)
    previous=score(service)
    result=service.observe(e)
    assert service.observe(e)==result
    assert score(service)['predictions'][0]['prediction']['trainedExamples']==20
    changed=dict(e,label=0)
    with pytest.raises(ServiceError) as error: service.observe(changed)
    assert error.value.code=='IDEMPOTENCY_CONFLICT'
    # Same input/version remains reproducible even for an unlabeled revision.
    assert score(service,previous['modelVersion'])==previous


def test_undo_removes_train_label_and_keeps_split_identity(tmp_path):
    service=ModelService(tmp_path); service.fit(fit_payload())
    e=event(0,label=None); e['operation']='revoke'
    service.observe(e)
    assert score(service)['predictions'][0]['prediction']['trainedExamples']==19
    replacement=fit_payload(revision=3); replacement['examples'][0]['split']='holdout'
    with pytest.raises(ServiceError) as error: service.fit(replacement)
    assert error.value.code=='SPLIT_CONFLICT'


def test_holdout_is_never_added_to_training_by_observe(tmp_path):
    service=ModelService(tmp_path); service.fit(fit_payload())
    before=score(service)['predictions'][0]['prediction']
    e=event(20,label=1); service.observe(e)
    after=score(service)['predictions'][0]['prediction']
    assert after['trainedExamples']==20
    assert before['removalProbability']==after['removalProbability']


def test_cross_user_stale_unknown_version_and_unknown_revoke(tmp_path):
    service=ModelService(tmp_path); result=service.fit(fit_payload())
    assert score(service,user='demo:other')['predictions'][0]['prediction']['trainedExamples']==0
    with pytest.raises(ServiceError): score(service,result['modelVersion'],user='demo:other')
    with pytest.raises(ServiceError) as error: service.observe(event(revision=1))
    assert error.value.code=='STALE_REVISION'
    e=event(label=None); e['operation']='revoke'
    with pytest.raises(ServiceError) as error: service.observe(e)
    assert error.value.code=='UNKNOWN_DECISION'


def test_train_permission_and_duplicate_track_rejected(tmp_path):
    service=ModelService(tmp_path)
    payload=fit_payload(); payload['examples'][0]['features']['permittedForTraining']=False
    with pytest.raises(ServiceError) as error: service.fit(payload)
    assert error.value.code=='TRAINING_NOT_PERMITTED'
    payload=fit_payload(); payload['examples'][1]['trackId']=payload['examples'][0]['trackId']
    with pytest.raises(ServiceError): service.fit(payload)


def test_explanation_registration_is_immutable_and_user_scoped(tmp_path):
    service=ModelService(tmp_path); response=score(service)
    prediction=response['predictions'][0]['prediction']; eid=str(UUID(int=9001))
    service.register_exposure('demo:user',eid,'demo:99',response['modelVersion'],prediction)
    service.fit(fit_payload())
    assert ModelService(tmp_path).explain('demo:user',eid)=={'exposureId':eid,'prediction':prediction}
    with pytest.raises(ServiceError): service.explain('demo:other',eid)
    changed=dict(prediction,heuristicScore=0.99)
    with pytest.raises(ServiceError): service.register_exposure('demo:user',eid,'demo:99',response['modelVersion'],changed)


def test_split_seed_cannot_change_and_failure_keeps_previous_model(tmp_path):
    service=ModelService(tmp_path); service.fit(fit_payload())
    before=score(service)
    bad=fit_payload(revision=2); bad['evaluationSeed']=7
    with pytest.raises(ServiceError): service.fit(bad)
    assert score(service)==before


def test_corrupt_artifact_is_explicit_and_not_silent_cold_start(tmp_path):
    service=ModelService(tmp_path); service.fit(fit_payload())
    for path in tmp_path.rglob('*.joblib'): path.write_bytes(b'corrupted')
    with pytest.raises(ServiceError) as error: score(ModelService(tmp_path))
    assert error.value.code=='ARTIFACT_UNAVAILABLE'


def test_keyed_score_replay_after_retrain_and_atomic_batch_conflict(tmp_path):
    service=ModelService(tmp_path)
    first=dict(candidate(1),exposureId=str(UUID(int=345)))
    payload={'userId':'demo:user','featureVersion':FEATURE_VERSION,'candidates':[first],'modelVersion':None}
    original=service.score(payload)
    service.fit(fit_payload())
    assert service.score(payload)==original
    assert service.explain('demo:user',first['exposureId'])['prediction']==original['predictions'][0]['prediction']
    new=dict(candidate(2),exposureId=str(UUID(int=346)))
    wrong=deepcopy(first); wrong['features']['values']['energy']=0.8
    with pytest.raises(ServiceError) as error:
        service.score(dict(payload,candidates=[new,wrong]))
    assert error.value.code=='EXPOSURE_CONFLICT'
    with pytest.raises(ServiceError): service.explain('demo:user',new['exposureId'])
    with pytest.raises(ServiceError): service.score(dict(payload,modelVersion=score(service)['modelVersion']))


def test_independent_service_instances_serialize_writes(tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    service=ModelService(tmp_path); service.fit(fit_payload())
    update=event()
    with ThreadPoolExecutor(max_workers=4) as pool:
        results=list(pool.map(lambda _: ModelService(tmp_path).observe(update),range(4)))
    assert all(result==results[0] for result in results)
    assert results[0]['modelVersion']==score(service)['modelVersion']


def test_duplicate_keyed_candidate_does_not_shift_other_predictions(tmp_path):
    service=ModelService(tmp_path)
    one=dict(candidate(1),exposureId=str(UUID(int=7001)))
    two=dict(candidate(2),exposureId=str(UUID(int=7002)))
    one['features']['values']['saved_age_days']=0
    two['features']['values']['saved_age_days']=1000
    request={'userId':'demo:user','featureVersion':FEATURE_VERSION,'modelVersion':None}
    single=service.score(dict(request,candidates=[two]))['predictions'][0]
    # New exposure identity for a fresh batch, including repeated identical input.
    two['exposureId']=str(UUID(int=7003))
    batch=service.score(dict(request,candidates=[one,one,two]))
    assert batch['predictions'][2]==single


def test_failed_publication_does_not_advance_model_or_feedback(tmp_path, monkeypatch):
    import sortfm_ml.service as storage
    service=ModelService(tmp_path); service.fit(fit_payload())
    before=score(service)
    original=storage.atomic_bytes
    def fail_pointer(path,data):
        if path.name=='current.json': raise OSError('simulated disk failure')
        return original(path,data)
    monkeypatch.setattr(storage,'atomic_bytes',fail_pointer)
    with pytest.raises(ServiceError) as error: service.observe(event())
    assert error.value.code=='STORAGE_UNAVAILABLE'
    assert score(ModelService(tmp_path))==before
    monkeypatch.setattr(storage,'atomic_bytes',original)
    response=service.observe(event())
    assert service.observe(event())==response
    assert response['modelVersion']!=before['modelVersion']


def test_superseded_decision_undo_does_not_erase_new_label(tmp_path):
    service=ModelService(tmp_path); service.fit(fit_payload())
    replacement=event(0,label=1); replacement['decisionId']=str(UUID(int=8900))
    service.observe(replacement)
    before=score(service)['predictions'][0]['prediction']['removalProbability']
    undo=event(0,revision=3,label=None); undo['operation']='revoke'
    service.observe(undo)
    after=score(service)['predictions'][0]['prediction']
    assert after['trainedExamples']==20
    assert after['removalProbability']==before


def test_identical_fit_in_fresh_stores_reproduces_version_and_scores(tmp_path):
    a,b=ModelService(tmp_path/'a'),ModelService(tmp_path/'b')
    assert a.fit(fit_payload())['modelVersion']==b.fit(fit_payload())['modelVersion']
    assert score(a)==score(b)


def test_missing_current_manifest_never_resets_existing_feedback(tmp_path):
    service=ModelService(tmp_path); service.fit(fit_payload())
    for path in tmp_path.rglob('current.json'): path.unlink()
    with pytest.raises(ServiceError) as error: score(ModelService(tmp_path))
    assert error.value.code=='ARTIFACT_UNAVAILABLE'
    with pytest.raises(ServiceError): ModelService(tmp_path).fit(fit_payload(revision=0))


@pytest.mark.parametrize('corruption',[None,[],{'bad':None},{'bad':{'prediction':None}}])
def test_structurally_corrupt_exposure_storage_fails_closed(tmp_path,corruption):
    import json
    service=ModelService(tmp_path)
    response=score(service)
    folder=next(tmp_path.iterdir())
    (folder/'exposures.json').write_text(json.dumps(corruption))
    with pytest.raises(ServiceError) as error: service.explain('demo:user','bad')
    assert error.value.status==503 and error.value.code=='ARTIFACT_UNAVAILABLE'
    with pytest.raises(ServiceError) as error: score(service)
    assert error.value.code=='ARTIFACT_UNAVAILABLE'


def _observe_in_process(arguments):
    directory,payload=arguments
    try:
        return ModelService(directory).observe(payload)
    except ServiceError as error:
        return {'error':error.code}


def test_separate_processes_serialize_competing_revisions(tmp_path):
    from concurrent.futures import ProcessPoolExecutor
    import multiprocessing
    service=ModelService(tmp_path); service.fit(fit_payload())
    first,second=event(81),event(82)
    second['eventId']=str(UUID(int=9911))
    with ProcessPoolExecutor(max_workers=2,mp_context=multiprocessing.get_context('spawn')) as pool:
        results=list(pool.map(_observe_in_process,[(str(tmp_path),first),(str(tmp_path),second)]))
    assert sum(result.get('accepted',False) for result in results)==1
    assert [result.get('error') for result in results].count('STALE_REVISION')==1
    assert service.evaluation('demo:user')['labeledExamples']==41
