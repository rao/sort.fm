from copy import deepcopy
import json

import numpy as np
import pytest

from sortfm_ml.cli import generate_synthetic
from sortfm_ml.model import PreferenceModel
from sortfm_ml.research_diagnostics import pinned_diagnostics, reliability


def _package():
    rows=generate_synthetic(seed=73,size=100)['examples']
    for i,r in enumerate(rows): r['split']='train' if i<60 else 'holdout'
    labeled=rows[:80]
    return {'model':PreferenceModel(labeled),'model_version':'fixture', 'examples':labeled,
            'snapshot':{'assembledCandidates':[{'trackId':r['trackId'],'features':r['features']} for r in rows]}}


def test_pinned_diagnostics_reconstruct_scores_and_holdout_labels_cannot_change_predictions():
    package=_package()
    original=deepcopy(package['examples'])
    first=pinned_diagnostics(package)
    assert first['decomposition_max_probability_error']<1e-12
    assert first['scores']['train_resubstitution']['n']==60
    assert first['scores']['monitoring_holdout']['n']==20
    assert first['scores']['unlabeled_library']['n']==20
    assert package['examples']==original
    for r in package['examples']:
        if r['split']=='holdout':r['label']=1-r['label']
    second=pinned_diagnostics(package)
    assert first['feature_weights']==second['feature_weights']
    assert first['scores']['unlabeled_library']==second['scores']['unlabeled_library']
    assert first['scores']['monitoring_holdout']['probabilities']==second['scores']['monitoring_holdout']['probabilities']


def test_constant_fitted_scores_have_unavailable_correlations_and_valid_json():
    package=_package()
    # Constant training features yield a real fitted intercept-only solution;
    # varying unlabeled features must not make constant scores correlatable.
    values=deepcopy(package['examples'][0]['features']['values'])
    for row in package['examples']:
        if row['split']=='train': row['features']['values']=deepcopy(values)
    package['model']=PreferenceModel(package['examples'],feature_group='history')
    result=pinned_diagnostics(package)
    scores=result['scores']['unlabeled_library']['probabilities']
    assert len(set(scores))==1
    assert all(value is None for value in result['unlabeled_score_spearman'].values())
    json.dumps(result,allow_nan=False)


def test_empty_monitoring_holdout_still_produces_serializable_diagnostics():
    package=_package()
    package['examples']=[row for row in package['examples'] if row['split']=='train']
    result=pinned_diagnostics(package)
    holdout=result['scores']['monitoring_holdout']
    assert holdout['n']==0
    assert holdout['probabilities']==[]
    assert holdout['metrics']=={'n':0}
    assert result['errors']==[]
    assert result['holdout_reliability']==[]
    json.dumps(result,allow_nan=False)


def test_decomposition_check_detects_corrupt_exported_terms_with_unchanged_scores(monkeypatch):
    package=_package()
    before=pinned_diagnostics(package)
    explain=package['model']._explain

    def wrong_intercept(*args):
        terms=explain(*args)
        terms[0]['contribution']+=1.
        return terms

    # Inject only an explanation defect, keeping actual fitting and prediction.
    monkeypatch.setattr(package['model'],'_explain',wrong_intercept)
    after=pinned_diagnostics(package)
    assert before['scores']==after['scores']
    assert after['decomposition_max_probability_error']>.05


@pytest.mark.parametrize('intercept',[-1000.,1000.])
def test_saturated_probabilities_have_finite_error_log_loss(intercept):
    package=_package()
    package['model'].classifier.coef_[:]=0.
    package['model'].classifier.intercept_[:]=intercept
    result=pinned_diagnostics(package)
    losses=[row['log_loss'] for row in result['errors']]
    assert all(np.isfinite(loss) for loss in losses)
    assert np.mean(losses)==pytest.approx(result['scores']['monitoring_holdout']['metrics']['log_loss'])
    json.dumps(result,allow_nan=False)


def test_reliability_includes_endpoint_probabilities_and_shows_sparse_counts():
    bins=reliability([0,1,0,1],[0,.25,.8,1])
    assert sum(b['n'] for b in bins)==4
    assert all(0<=b['wilson_low']<=b['remove_fraction']<=b['wilson_high']<=1 for b in bins)
    assert all(b['wilson_high']-b['wilson_low']>.5 for b in bins)
