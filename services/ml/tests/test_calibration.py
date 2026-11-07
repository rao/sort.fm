from copy import deepcopy
import csv
import json
import subprocess
import sys

import pytest

from sortfm_ml.cli import generate_synthetic, split_for_track
from sortfm_ml.calibration import prepare, read_labels, write_label_sheet
from sortfm_ml.calibration_run import freeze, evaluate


def snapshot(audio=True):
    rows = generate_synthetic(size=600)['examples']
    candidates = [{'trackId': row['trackId'], 'features': row['features']} for row in rows]
    if not audio:
        for row in candidates:
            row['features']['values'] = {k: v for k, v in row['features']['values'].items()
                                         if k in ('saved_age_days', 'release_age_years', 'duration_ms', 'artist_library_count')}
    return {'userId': 'demo:calibration', 'featureVersion': 'sortfm.features.v1',
            'capturedAt': '2026-11-07T12:00:00Z', 'candidates': candidates,
            'display': {c['trackId']: {'title': 'A track', 'artists': ['An artist']} for c in candidates}}


def completed_sheet(manifest, split, path, one_class=False):
    write_label_sheet(manifest, split, path)
    with path.open(newline='') as f:
        rows = list(csv.DictReader(f))
    for i, row in enumerate(rows):
        row['decision'] = 'KEEP' if one_class or i % 2 else 'REMOVE'
    with path.open('w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=rows[0].keys())
        writer.writeheader()
        writer.writerows(rows)
    return rows


def test_sampling_is_reproducible_order_independent_and_honors_live_split():
    data = snapshot()
    manifest = prepare(data, size=60, sampling_seed=7)
    reordered = deepcopy(data)
    reordered['candidates'].reverse()
    assert prepare(reordered, size=60, sampling_seed=7) == manifest
    assert prepare(data, size=60, sampling_seed=8)['experimentId'] != manifest['experimentId']
    rows = manifest['selected']
    assert len(rows) == len({r['trackId'] for r in rows}) == 60
    assert sum(r['split'] == 'holdout' for r in rows) == 20
    assert all(r['split'] == split_for_track(data['userId'], r['trackId'], 42) for r in rows)
    assert len({r['stratum'].split('|')[0] for r in rows}) >= 3
    assert manifest['sampling']['musicalAxes'] == ['energy', 'danceability']
    assert sum(r['selected'] for r in manifest['sampling']['strata']) == 60
    assert all('label' not in r for r in rows)


def test_metadata_fallback_and_small_or_invalid_inputs():
    data = snapshot(audio=False)
    assert prepare(data)['sampling']['musicalAxes'] == ['release_age_years', 'duration_ms']
    for size in (49, 81):
        with pytest.raises(ValueError, match='50.*80'):
            prepare(data, size=size)
    data['candidates'] = data['candidates'][:10]
    with pytest.raises(ValueError, match='enough'):
        prepare(data)
    data = snapshot()
    data['candidates'].append(data['candidates'][0])
    with pytest.raises(ValueError, match='[Dd]uplicate'):
        prepare(data)


def test_label_sheets_require_explicit_complete_matching_listener_decisions(tmp_path):
    manifest = prepare(snapshot())
    sheet = tmp_path / 'train.csv'
    write_label_sheet(manifest, 'train', sheet)
    with pytest.raises(ValueError, match='incomplete'):
        read_labels(manifest, 'train', sheet)
    completed_sheet(manifest, 'train', sheet)
    labels = read_labels(manifest, 'train', sheet)
    assert len(labels) == 40 and set(labels.values()) == {0, 1}
    text = sheet.read_text()
    sheet.write_text(text.replace('KEEP', 'ARCHIVE'))
    with pytest.raises(ValueError, match='KEEP.*REMOVE'):
        read_labels(manifest, 'train', sheet)
    sheet.write_text(text.replace(manifest['experimentId'], 'different-user'))
    with pytest.raises(ValueError, match='experiment'):
        read_labels(manifest, 'train', sheet)


def test_frozen_run_evaluates_without_refit_and_seals_final_labels(tmp_path, monkeypatch):
    manifest = prepare(snapshot(), sampling_seed=17)
    train, holdout, run = tmp_path / 'train.csv', tmp_path / 'holdout.csv', tmp_path / 'run'
    completed_sheet(manifest, 'train', train)
    frozen = freeze(manifest, train, run)
    assert not holdout.exists()  # Freeze cannot consult final labels.
    assert frozen['trainedExamples'] == 40
    assert {'age_only', 'metadata_only', 'metadata_history', 'c1', 'audio_enriched'} <= set(frozen['models'])
    assert frozen['models']['c1']['contributions']
    assert len(frozen['models']['c1']['probabilities']) == 20
    assert freeze(manifest, train, run) == frozen
    completed_sheet(manifest, 'holdout', holdout)
    monkeypatch.setattr('sortfm_ml.model.PreferenceModel.__init__', lambda *a, **k: pytest.fail('evaluation refitted'))
    report = evaluate(run, holdout)
    assert report['models']['c1']['metrics']['status'] == 'available'
    assert report['models']['c1']['metrics']['trainedExamples'] == 40
    assert report['models']['c1']['metrics']['heldOutExamples'] == 20
    assert report['models']['age_only']['metrics']['logLoss'] is not None
    assert report['models']['c1']['ranking']['ndcgAtK'] is not None
    assert evaluate(run, holdout) == report
    holdout.write_text(holdout.read_text().replace('KEEP', 'REMOVE'))
    with pytest.raises(ValueError, match='sealed'):
        evaluate(run, holdout)


def test_sparse_audio_defers_experiment_and_reports_null_metrics_for_one_class(tmp_path):
    manifest = prepare(snapshot(audio=False))
    train, holdout, run = tmp_path / 'train.csv', tmp_path / 'holdout.csv', tmp_path / 'run'
    completed_sheet(manifest, 'train', train)
    frozen = freeze(manifest, train, run)
    assert frozen['audioExperiment']['status'] == 'deferred'
    assert 'audio_enriched' not in frozen['models']
    completed_sheet(manifest, 'holdout', holdout, one_class=True)
    report = evaluate(run, holdout)
    assert report['models']['c1']['metrics']['rocAuc'] is None
    assert report['models']['c1']['metrics']['status'] == 'insufficient_data'
    # Valid single-class probabilistic diagnostics are separate from frozen wire metrics.
    assert report['models']['c1']['diagnostics']['logLoss'] is not None
    assert report['models']['c1']['diagnostics']['brierScore'] is not None
    assert report['models']['c1']['ranking']['rocAuc'] is None


def test_manifest_edits_and_unknown_track_labels_fail_closed(tmp_path):
    manifest = prepare(snapshot())
    sheet = tmp_path / 'train.csv'
    completed_sheet(manifest, 'train', sheet)
    modified = deepcopy(manifest)
    modified['selected'][0]['features']['values']['energy'] = .99
    with pytest.raises(ValueError, match='digest'):
        freeze(modified, sheet, tmp_path / 'run')
    sheet.write_text(sheet.read_text() + sheet.read_text().splitlines()[1] + '\n')
    with pytest.raises(ValueError, match='[Dd]uplicate'):
        read_labels(manifest, 'train', sheet)


def test_cli_runs_all_phases_and_accepts_integration_export(tmp_path):
    data = snapshot()
    exported = {k: data[k] for k in ('userId', 'featureVersion', 'capturedAt', 'candidates')}
    exported.update(snapshotVersion='sortfm.calibration-export.v1', assembly='Exact API assembler',
                    tracks=[{'track': {'trackId': i, 'title': d['title'], 'artists': [{'name': a} for a in d['artists']]},
                             'currentStatus': 'saved'} for i, d in data['display'].items()])
    source, experiment = tmp_path / 'snapshot.json', tmp_path / 'experiment'
    source.write_text(json.dumps(exported))
    def cli(*args):
        return subprocess.run([sys.executable, '-m', 'sortfm_ml.calibration_cli', *map(str, args)],
                              capture_output=True, text=True, check=True)
    cli('prepare', source, '--output', experiment, '--size', 80)
    manifest = json.loads((experiment / 'manifest.json').read_text())
    assert len(manifest['selected']) == 80
    assert json.loads((experiment / 'pending-report.json').read_text())['trainedExamples'] == 0
    assert (experiment / 'manifest.json').stat().st_mode & 0o777 == 0o600
    completed_sheet(manifest, 'train', experiment / 'train-labels.csv')
    cli('freeze', experiment / 'manifest.json', '--train-labels', experiment / 'train-labels.csv', '--run', experiment / 'run')
    completed_sheet(manifest, 'holdout', experiment / 'holdout-labels.csv')
    cli('evaluate', '--run', experiment / 'run', '--holdout-labels', experiment / 'holdout-labels.csv')
    assert (experiment / 'run/report.md').exists()


def test_online_holdout_updates_cannot_change_fitted_probabilities(tmp_path):
    from sortfm_ml.service import ModelService
    from test_service import fit_payload, event, score
    service = ModelService(tmp_path / 'online')
    service.fit(fit_payload())
    before = score(service)['predictions'][0]['prediction']['removalProbability']
    update = event(i=25, label=0)
    update['features']['values']['energy'] = .99
    service.observe(update)
    after = score(service)['predictions'][0]['prediction']['removalProbability']
    assert before == after
    assert service.evaluation('demo:user')['trainedExamples'] == 20


def test_complementary_audio_coverage_defers_unusable_audio_comparison(tmp_path):
    from sortfm_ml.features import AUDIO_KEYS
    from sortfm_ml.service import digest
    manifest = prepare(snapshot())
    for split in ('train', 'holdout'):
        for i, row in enumerate(r for r in manifest['selected'] if r['split'] == split):
            values = row['features']['values']
            for key in AUDIO_KEYS:
                values.pop(key, None)
            # Every row has three descriptors, but no descriptor spans classes.
            keys = ('energy', 'danceability', 'happiness') if i % 2 else ('acousticness', 'instrumentalness', 'liveness')
            values.update({key: .5 for key in keys})
    manifest['experimentId'] = digest({k: v for k, v in manifest.items() if k != 'experimentId'})
    train = tmp_path / 'train.csv'
    completed_sheet(manifest, 'train', train)
    frozen = freeze(manifest, train, tmp_path / 'run')
    assert frozen['audioExperiment']['status'] == 'deferred'
    assert frozen['audioExperiment']['supportedDescriptors'] == []
    assert 'audio_enriched' not in frozen['models']


def test_ranking_and_probability_diagnostics_match_hand_checked_values():
    from sortfm_ml.calibration_run import diagnostics
    prob, rank = diagnostics({'a': 1, 'b': 0, 'c': 1, 'd': 0},
                             {'a': .8, 'b': .6, 'c': .4, 'd': .2}, k=2)
    assert prob['logLoss'] == pytest.approx(.5697171415941824)
    assert prob['brierScore'] == pytest.approx(.2)
    assert rank['rocAuc'] == .75
    assert rank['averagePrecision'] == pytest.approx(5 / 6)
    assert rank['precisionAtK'] == rank['recallAtK'] == .5
    assert rank['liftAtK'] == 1
    assert rank['ndcgAtK'] == pytest.approx(.6131471927654584)
    assert rank['k'] == 2
    _, no_remove = diagnostics({'a': 0, 'b': 0}, {'a': .8, 'b': .2})
    assert no_remove['precisionAtK'] == 0
    assert all(no_remove[k] is None for k in ('rocAuc', 'averagePrecision', 'recallAtK', 'liftAtK', 'ndcgAtK'))


def test_one_class_training_cannot_claim_fitted_c1_metrics(tmp_path):
    manifest = prepare(snapshot())
    train, holdout, run = tmp_path / 'train.csv', tmp_path / 'holdout.csv', tmp_path / 'run'
    completed_sheet(manifest, 'train', train, one_class=True)
    frozen = freeze(manifest, train, run)
    assert frozen['models']['c1']['modelKind'] == 'heuristic'
    assert frozen['models']['c1']['contributions'] == []
    completed_sheet(manifest, 'holdout', holdout)
    report = evaluate(run, holdout)
    assert report['models']['c1']['metrics']['status'] == 'insufficient_data'
    assert report['models']['c1']['diagnostics']['logLoss'] is None
