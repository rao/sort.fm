"""Diagnostics of a pinned private model; no fits or production mutations."""
from collections import defaultdict
import math

import numpy as np
from scipy.special import expit
from scipy.stats import spearmanr
from sklearn.metrics import average_precision_score, brier_score_loss, log_loss, roc_auc_score

from .features import AUDIO_KEYS, CENTROID_KEYS, HISTORY_KEYS, METADATA_KEYS, observed_value
from .research_data import audio_count


def family(key):
    key = key.removesuffix('_missing')
    if key == 'saved_age_days': return 'save age'
    if key in AUDIO_KEYS: return 'audio'
    if key in CENTROID_KEYS: return 'similarity'
    if key in METADATA_KEYS: return 'metadata'
    return 'listening'


def measures(y, p):
    if not len(y): return {'n': 0}
    return {'n': len(y), 'remove': int(sum(y)), 'log_loss': float(log_loss(y,p,labels=[0,1])),
            'brier': float(brier_score_loss(y,p)),
            'roc_auc': float(roc_auc_score(y,p)) if len(set(y)) == 2 else None,
            'average_precision': float(average_precision_score(y,p)) if len(set(y)) == 2 else None}


def reliability(y, p, bins=5):
    result = []
    for low, high in zip(np.linspace(0,1,bins+1)[:-1], np.linspace(0,1,bins+1)[1:]):
        selected = [(a,b) for a,b in zip(y,p) if low <= b and (b < high or high == 1)]
        n = len(selected)
        if not n: continue
        fraction = sum(a for a,b in selected)/n
        # Wilson interval for descriptive bin frequency; does not include fitted-
        # model uncertainty or selection bias. Wide bins preferable at this n.
        denom = 1+1.96**2/n; center = (fraction+1.96**2/(2*n))/denom
        width = 1.96*math.sqrt(fraction*(1-fraction)/n+1.96**2/(4*n*n))/denom
        result.append({'lower':float(low), 'upper':float(high), 'n':n,
                       'mean_probability':sum(b for a,b in selected)/n, 'remove_fraction':fraction,
                       'wilson_low':center-width, 'wilson_high':center+width})
    return result


def pinned_diagnostics(package):
    model = package['model']
    if model is None or model.classifier is None: return {'status':'no_trained_pinned_model'}
    examples = package['examples']; candidates = package['snapshot']['assembledCandidates']
    train = [r for r in examples if r['split'] == 'train' and r['features']['permittedForTraining']]
    holdout = [r for r in examples if r['split'] == 'holdout']
    ids = {r['trackId'] for r in examples}
    unlabeled = [r for r in candidates if r['trackId'] not in ids]
    mask = getattr(model,'predictor_mask_',np.ones(len(model.pipeline.feature_names)))
    coef = model.classifier.coef_[0]
    def context(rows): return model.transform_context(rows)*mask
    def predict(rows):
        return model.classifier.predict_proba(context(rows))[:,1] if rows else np.array([])
    xt, xu = context(train), context(unlabeled)
    weights = [{'feature':k,'family':family(k),'weight':float(coef[i]),'enabled':bool(mask[i]),
                'mean_abs_train_contribution':float(np.mean(np.abs(xt[:,i]*coef[i]))),
                'mean_abs_library_contribution':float(np.mean(np.abs(xu[:,i]*coef[i]))) if len(unlabeled) else None,
                'support':getattr(model,'feature_support_',{}).get(k)} for i,k in enumerate(model.pipeline.feature_names)]
    contributions = defaultdict(float)
    for row in weights: contributions[row['family']] += row['mean_abs_library_contribution'] or 0.
    scores = {}
    for name,rows in [('train_resubstitution',train),('monitoring_holdout',holdout),('unlabeled_library',unlabeled)]:
        p = predict(rows) if rows else np.array([])
        scores[name] = {'n':len(rows),'probabilities':p.tolist(), 'labels':[r.get('label') for r in rows],
                       'metrics':measures([r['label'] for r in rows],p) if name != 'unlabeled_library' else None}
    p = predict(unlabeled) if unlabeled else []
    correlations = {}
    for key in ('saved_age_days',*METADATA_KEYS,*HISTORY_KEYS[1:]):
        observed = [(observed_value(r['features']['values'],key),score) for r,score in zip(unlabeled,p)]
        observed = [(x,y) for x,y in observed if x is not None]
        correlation = None
        if len(observed)>2 and len({x for x,y in observed})>1 and len({y for x,y in observed})>1:
            value = float(spearmanr(*zip(*observed)).statistic)
            if math.isfinite(value): correlation = value
        correlations[key] = correlation
    errors = []
    for i,(row,probability) in enumerate(zip(sorted(holdout,key=lambda r:r['trackId']),predict(sorted(holdout,key=lambda r:r['trackId'])))):
        terms = context([row])[0]*coef
        important = sorted(range(len(coef)),key=lambda j:-abs(terms[j]))[:3]
        # Match sklearn's floating-point endpoint clipping without altering
        # the recorded probability, including exact zero and one predictions.
        clipped = np.clip(probability,np.finfo(float).eps,1-np.finfo(float).eps)
        errors.append({'row_alias':f'H{i+1:02d}','label':row['label'],'probability':float(probability),
                       'log_loss':float(-(row['label']*np.log(clipped)+(1-row['label'])*np.log1p(-clipped))),
                       'saved_age_days':observed_value(row['features']['values'],'saved_age_days'),
                       'audio_descriptors_at_label':audio_count(row),
                       'largest_terms':[{'feature':model.pipeline.feature_names[j],'contribution':float(terms[j])} for j in important]})
    public_predictions = [r['prediction'] for r in model.predict(examples,package['model_version'])]
    # Verify the exported explanation itself, independently of predict_proba.
    # Intercept and other_features are additive; entropy is not a log-odds term.
    reconstructed = [expit(math.fsum(term['contribution'] for term in row['explanations']
                                    if term['contribution'] is not None)) for row in public_predictions]
    reconstruction = np.max(np.abs(np.asarray(reconstructed)-np.array([r['removalProbability'] for r in public_predictions])))
    return {'status':'available_uncalibrated', 'intercept':float(model.classifier.intercept_[0]),
            'feature_weights':weights,'library_mean_abs_contributions_by_family':dict(contributions),
            'unlabeled_score_spearman':correlations,'scores':scores,
            'errors':sorted(errors,key=lambda r:-r['log_loss']),
            'decomposition_max_probability_error':float(reconstruction),
            'decomposition_method':'sigmoid of summed exported log-odds terms, including intercept and other_features, compared with public removalProbability',
            'holdout_reliability':reliability([r['label'] for r in holdout],predict(holdout))}
