"""Freeze train-only C1 fits, then evaluate saved predictions without fitting."""
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
from pathlib import Path
import platform
from uuid import NAMESPACE_URL, uuid5

import joblib
import numpy as np
import sklearn
from sklearn.metrics import average_precision_score, brier_score_loss, log_loss, ndcg_score, roc_auc_score

from .calibration import read_labels, validate_manifest
from .evaluate import evaluate_model
from .features import AUDIO_KEYS, observed_value
from .model import MIN_AUDIO_OBSERVATIONS, MIN_AUDIO_PER_CLASS, MODEL_RECIPE, PreferenceModel
from .service import atomic_bytes, canonical, digest


def _now():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


@contextmanager
def _locked_run(run: Path):
    run = Path(run)
    run.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (run / '.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield run


def _write(path: Path, value):
    atomic_bytes(path, canonical(value) + b'\n')
    path.chmod(0o600)


def _examples(manifest, labels, labeled_at):
    return [{'trackId': r['trackId'], 'features': r['features'], 'split': r['split'],
             'decisionId': str(uuid5(NAMESPACE_URL, manifest['experimentId'] + ':' + r['trackId'])),
             'label': labels[r['trackId']], 'labeledAt': labeled_at}
            for r in manifest['selected'] if r['trackId'] in labels]


def _covered(row, minimum, keys):
    return sum(observed_value(row['features']['values'], key) is not None for key in keys) >= minimum


def _audio_gate(manifest, train, holdout):
    p = manifest['protocol']
    support = {}
    for key in AUDIO_KEYS:
        counts = [sum(r['label'] == label and observed_value(r['features']['values'], key) is not None
                      for r in train) for label in (0, 1)]
        support[key] = {'keep': counts[0], 'remove': counts[1],
                        'enabled': sum(counts) >= MIN_AUDIO_OBSERVATIONS and min(counts) >= MIN_AUDIO_PER_CLASS}
    keys = [key for key, counts in support.items() if counts['enabled']]
    covered_train = [r for r in train if _covered(r, p['audioMinDescriptors'], keys)]
    covered_holdout = [r['trackId'] for r in holdout if _covered(r, p['audioMinDescriptors'], keys)]
    counts = [sum(r['label'] == label for r in covered_train) for label in (0, 1)]
    ready = (len(covered_train) >= p['audioMinTrain'] and min(counts) >= p['audioMinTrainPerClass']
             and len(covered_holdout) >= p['audioMinHoldout'])
    return {'status': 'ready' if ready else 'deferred', 'coveredTrain': len(covered_train),
            'supportedDescriptors': keys, 'descriptorSupport': support,
            'coveredTrainKeep': counts[0], 'coveredTrainRemove': counts[1],
            'coveredHoldout': len(covered_holdout), 'coveredHoldoutTrackIds': covered_holdout,
            'reason': 'Predeclared coverage gate met; effect remains unmeasured until final labels.' if ready else
                      'Need >=24 covered training tracks (>=6 per class) and >=12 covered holdout tracks; each needs >=3 train-supported audio descriptors (>=12 observations and >=3 per class per descriptor).',
            'thresholdsAre': 'Engineering adequacy gates, not statistical power or quality guarantees'}


def _contributions(model, train):
    if model.classifier is None:
        return []
    context = model.transform_context(train) * model.predictor_mask_
    coefficient = model.classifier.coef_[0]
    contributions = np.mean(np.abs(context * coefficient), axis=0)
    rows = [{'feature': key, 'coefficient': float(coefficient[i]),
             'meanAbsoluteTrainContribution': float(contributions[i]),
             'enabled': bool(model.predictor_mask_[i])}
            for i, key in enumerate(model.pipeline.feature_names)]
    return sorted(rows, key=lambda row: (-row['meanAbsoluteTrainContribution'], row['feature']))


def freeze(manifest: dict, train_sheet: Path, run: Path) -> dict:
    """No holdout label argument, no live service artifact or DB access.

    Save the actual fitted models and all final-holdout predictions. Evaluation
    reads only frozen.json, never joblib or a current online model. The run is
    immutable; a retry with different training labels/configuration is rejected.
    """
    validate_manifest(manifest)
    labels = read_labels(manifest, 'train', train_sheet)
    identity = digest({'manifest': manifest['experimentId'], 'labels': labels, 'recipe': MODEL_RECIPE})
    with _locked_run(run) as run:
        path = run / 'frozen.json'
        if path.exists():
            prior = _read_frozen(run)
            if prior['trainingIdentity'] != identity:
                raise ValueError('Run is sealed; changed training inputs require a new predeclared experiment')
            return prior
        frozen_at = _now()
        train = _examples(manifest, labels, frozen_at)
        holdout = [r for r in manifest['selected'] if r['split'] == 'holdout']
        candidates = [{'trackId': r['trackId'], 'features': r['features']} for r in holdout]
        gate = _audio_gate(manifest, train, holdout)
        groups = {'age_only': 'age', 'metadata_only': 'metadata', 'metadata_history': 'history', 'c1': 'personalized'}
        if gate['status'] == 'ready':
            groups['audio_enriched'] = 'audio'
        models, fitted = {}, {}
        for name, group in groups.items():
            model = PreferenceModel(train, seed=manifest['sampling']['evaluationSeed'], feature_group=group)
            version = f'calibration-{identity[:20]}-{name}'
            predictions = model.predict(candidates, version)
            models[name] = {'modelVersion': version, 'modelKind': model.model_kind,
                            'featureGroup': group, 'trainedExamples': model.trained_examples,
                            'probabilities': {r['trackId']: r['prediction']['removalProbability'] for r in predictions},
                            'contributions': _contributions(model, train),
                            'intercept': float(model.classifier.intercept_[0]) if model.classifier is not None else None,
                            'featureSupport': model.feature_support_}
            fitted[name] = model
        # A train-base-rate control, including degenerate one-class training.
        prior = sum(labels.values()) / len(labels)
        models['training_prior'] = {'modelVersion': f'calibration-{identity[:20]}-prior',
                                   'modelKind': 'constant_prior', 'featureGroup': 'constant',
                                   'trainedExamples': len(train), 'contributions': [], 'intercept': None,
                                   'featureSupport': {}, 'probabilities': {r['trackId']: prior for r in holdout}}
        frozen = {'schemaVersion': 'sortfm.calibration-frozen.v1', 'trainingIdentity': identity,
                  'frozenAt': frozen_at, 'recipe': MODEL_RECIPE, 'manifest': manifest,
                  'runtime': {'python': platform.python_version(), 'numpy': np.__version__, 'sklearn': sklearn.__version__},
                  'trainedExamples': len(train), 'trainKeep': len(train) - sum(labels.values()),
                  'trainRemove': sum(labels.values()), 'trainingExamples': train,
                  'audioExperiment': gate, 'models': models}
        # Trusted local artifact, never accept externally supplied pickle files.
        model_path = run / 'models.joblib'
        joblib.dump(fitted, model_path, compress=3)
        model_path.chmod(0o600)
        frozen['modelArtifactDigest'] = hashlib.sha256(model_path.read_bytes()).hexdigest()
        frozen['frozenDigest'] = digest(frozen)
        _write(path, frozen)
        return frozen


def _read_frozen(run):
    frozen = json.loads((run / 'frozen.json').read_text())
    if frozen.get('frozenDigest') != digest({k: v for k, v in frozen.items() if k != 'frozenDigest'}):
        raise ValueError('Frozen prediction digest mismatch')
    validate_manifest(frozen['manifest'])
    return frozen


class _FrozenModel:
    def __init__(self, stored):
        self.stored = stored
        # evaluate_model's probability eligibility gate also applies to this
        # explicit constant-probability control; report its true kind separately.
        self.model_kind = 'logistic' if stored['modelKind'] == 'constant_prior' else stored['modelKind']
        self.trained_examples = stored['trainedExamples']

    def predict(self, candidates, model_version):
        return [{'trackId': row['trackId'], 'prediction': {'removalProbability': self.stored['probabilities'][row['trackId']]}}
                for row in candidates]


def diagnostics(labels, probabilities, k=10):
    """Valid diagnostics also for a single-class/small evaluation subset.

    Wire ModelMetrics remains conservatively unavailable in these cases. ROC
    requires both classes; AP/recall/lift/NDCG require positive examples. Ties
    for precision/recall are broken by track ID; NDCG averages tied scores.
    """
    ids = sorted(labels)
    y = [labels[i] for i in ids]
    p = [probabilities.get(i) for i in ids]
    prob = {'logLoss': None, 'brierScore': None}
    rank = dict.fromkeys(('rocAuc', 'averagePrecision', 'precisionAtK', 'recallAtK', 'liftAtK', 'ndcgAtK'))
    rank.update(k=min(k, len(ids)), evaluatedExamples=len(ids), positives=sum(y))
    if not ids or any(v is None or not np.isfinite(v) or not 0 <= v <= 1 for v in p):
        return prob, rank
    prob.update(logLoss=float(log_loss(y, p, labels=[0, 1])), brierScore=float(brier_score_loss(y, p)))
    order = sorted(ids, key=lambda i: (-probabilities[i], i))
    actual_k, positives = min(k, len(ids)), sum(y)
    hits = sum(labels[i] for i in order[:actual_k])
    rank['precisionAtK'] = hits / actual_k
    if len(set(y)) == 2:
        rank['rocAuc'] = float(roc_auc_score(y, p))
    if positives:
        rank.update(averagePrecision=float(average_precision_score(y, p)), recallAtK=hits / positives,
                    liftAtK=(hits / actual_k) / (positives / len(ids)),
                    ndcgAtK=float(ndcg_score([y], [p], k=actual_k)) if len(ids) > 1 else 1.)
    return prob, rank


def evaluate(run: Path, holdout_sheet: Path) -> dict:
    """Consume the final labels once; changing them cannot silently replace results."""
    with _locked_run(run) as run:
        frozen = _read_frozen(run)
        manifest = frozen['manifest']
        labels = read_labels(manifest, 'holdout', holdout_sheet)
        final_digest = digest({'frozen': frozen['frozenDigest'], 'labels': labels})
        path = run / 'report.json'
        if path.exists():
            report = json.loads(path.read_text())
            if report['finalEvaluationDigest'] != final_digest:
                raise ValueError('Final holdout labels are sealed; changed labels require a disclosed new evaluation')
            return report
        evaluated_at = _now()
        holdout = _examples(manifest, labels, evaluated_at)
        report = {'schemaVersion': 'sortfm.calibration-report.v1', 'experimentId': manifest['experimentId'],
                  'userId': manifest['userId'], 'frozenDigest': frozen['frozenDigest'],
                  'finalEvaluationDigest': final_digest, 'frozenAt': frozen['frozenAt'], 'evaluatedAt': evaluated_at,
                  'sourceDigest': manifest['sourceDigest'], 'recipe': frozen['recipe'], 'runtime': frozen['runtime'],
                  'labelProvenance': 'Explicit caller-entered KEEP/REMOVE judgments; human origin is not independently verified',
                  'counts': {'population': manifest['populationSize'], 'selected': len(manifest['selected']),
                             'train': frozen['trainedExamples'], 'trainKeep': frozen['trainKeep'], 'trainRemove': frozen['trainRemove'],
                             'holdout': len(labels), 'holdoutKeep': len(labels) - sum(labels.values()), 'holdoutRemove': sum(labels.values())},
                  'sampling': manifest['sampling'], 'protocol': manifest['protocol'], 'models': {},
                  'audioExperiment': frozen['audioExperiment'], 'audioPairedComparison': {},
                  'limitations': [
                      'Exploratory single-listener sample; 20 holdout labels give unstable estimates, not established predictive improvement.',
                      'No model selection, hyperparameter tuning, threshold fitting or probability calibration used final labels.',
                      'Metrics describe this stratified sample without population weighting; sparse strata and label nonresponse can bias estimates.',
                      'Metadata-only excludes save age/history; metadata_history controls for these before assessing added audio.',
                      'Train-scaled coefficients and mean absolute training contributions are associations, not causal explanations.',
                      'Masked missing indicators cannot directly drive C1; missingness can still correlate with observed descriptors and coverage bias.',
                      'Online fits and C2 do not participate; no Spotify calls or live model promotion occurred.',
                      'Previously viewed/tuned-on holdouts are no longer a final validation set. Freeze a new prospective cohort for future claims.',
                  ]}
        for name, stored in frozen['models'].items():
            prob, rank = diagnostics(labels, stored['probabilities'])
            metrics = evaluate_model(_FrozenModel(stored), frozen['trainingExamples'] + holdout, stored['modelVersion'])
            report['models'][name] = {k: v for k, v in stored.items() if k != 'probabilities'}
            report['models'][name].update(metrics=metrics, diagnostics=prob, ranking=rank)
            if frozen['audioExperiment']['status'] == 'ready' and name in ('metadata_only', 'metadata_history', 'audio_enriched'):
                covered = {i: labels[i] for i in frozen['audioExperiment']['coveredHoldoutTrackIds']}
                cp, cr = diagnostics(covered, stored['probabilities'])
                report['audioPairedComparison'][name] = {'fullHoldout': {'diagnostics': prob, 'ranking': rank},
                                                       'sameCoveredSubset': {'diagnostics': cp, 'ranking': cr}}
        _write(path, report)
        atomic_bytes(run / 'report.md', markdown_report(report).encode())
        return report


def markdown_report(report):
    c = report['counts']
    lines = ['# C1 calibration report', '', report['labelProvenance'], '',
             f"Actual labels: {c['train']} training ({c['trainKeep']} Keep / {c['trainRemove']} Remove), "
             f"{c['holdout']} held out ({c['holdoutKeep']} Keep / {c['holdoutRemove']} Remove).", '',
             '| Model | ROC-AUC | Log loss | Brier | Precision@10 | NDCG@10 |',
             '|---|---:|---:|---:|---:|---:|']
    for name, result in report['models'].items():
        values = [result['ranking']['rocAuc'], result['diagnostics']['logLoss'], result['diagnostics']['brierScore'],
                  result['ranking']['precisionAtK'], result['ranking']['ndcgAtK']]
        lines.append(f'| {name} | ' + ' | '.join('unavailable' if v is None else f'{v:.4f}' for v in values) + ' |')
    lines += ['', f"Audio comparison: {report['audioExperiment']['status']}. {report['audioExperiment']['reason']}",
              '', 'Largest C1 mean absolute training contributions (log odds; not causal):', '']
    for row in report['models']['c1']['contributions'][:8]:
        lines.append(f"- {row['feature']}: coefficient {row['coefficient']:.4f}, mean |contribution| {row['meanAbsoluteTrainContribution']:.4f}")
    lines += ['', *['- ' + limit for limit in report['limitations']], '']
    return '\n'.join(lines)
