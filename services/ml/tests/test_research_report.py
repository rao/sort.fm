from copy import deepcopy

import pytest

from sortfm_ml.research_data import audit_snapshot
from sortfm_ml.research_report import make_plots, write_report


def sparse_report():
    from test_research_data import fixture
    audit = audit_snapshot(fixture())
    empty = {'models': {}, 'reason': 'insufficient_labels'}
    benchmark = {'config': {'repeats': 1},
                 'protocols': {'train_repeated_stratified_cv': deepcopy(empty),
                               'monitoring_holdout': deepcopy(empty)},
                 'learning_curves': {'summary': []}}
    return {'audit': audit, 'original': benchmark, 'audio_augmented': deepcopy(benchmark),
            'audio_comparison': [], 'pinned_diagnostics': {
                'status': 'available_uncalibrated', 'feature_weights': [],
                'library_mean_abs_contributions_by_family': {},
                'scores': {name: {'probabilities': [], 'metrics': {'n': 0}}
                           for name in ('train_resubstitution', 'monitoring_holdout', 'unlabeled_library')},
                'unlabeled_score_spearman': {'saved_age_days': None},
                'holdout_reliability': [], 'errors': [],
                'decomposition_max_probability_error': 0.0}}


@pytest.mark.parametrize('empty_labels', [False, True])
def test_plots_handle_empty_holdout_and_label_cohorts(tmp_path, empty_labels):
    pytest.importorskip('matplotlib')
    report = sparse_report()
    if empty_labels:
        report['audit']['save_years']['labeled'] = {}
    make_plots(report, tmp_path)
    assert (tmp_path/'dataset-audit.png').is_file()
    assert (tmp_path/'pinned-score-distributions.png').is_file()


def test_report_marks_unavailable_metrics_and_omits_unavailable_figures(tmp_path):
    report = sparse_report()
    write_report(report, tmp_path)
    text = (tmp_path/'report.md').read_text()
    assert 'Monitoring: AUC —, AP —, log loss —, Brier —' in text
    assert 'plots/benchmark-comparison.png' not in text
    assert 'plots/calibration-and-oof-scores.png' not in text
    assert 'plots/learning-curves.png' not in text
    assert 'insufficient_labels' in text
