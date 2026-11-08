"""Offline sampling guarantees; all identities and feature data are synthetic."""
from copy import deepcopy
import hashlib
import json
import math

import pytest


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'),
                                     allow_nan=False).encode()).hexdigest()


def inputs():
    candidates, registry = [], []
    for i in range(20):
        track = f'demo:research:{i:02d}'
        candidates.append({'trackId': track, 'features': {
            'featureVersion': 'sortfm.features.v1', 'provenance': 'synthetic',
            'permittedForTraining': True, 'rightsBasis': 'Generated test fixture',
            'values': {'saved_age_days': float(i * 100), 'energy': (i % 3) / 2,
                       'danceability': (i % 4) / 4, 'release_age_years': float(i)},
        }})
        registry.append({'trackId': track, 'split': 'holdout' if i < 8 else 'train',
                         'role': 'evaluation' if i < 8 else 'training',
                         'feedbackState': 'unlabeled', 'revision': 0})
    snapshot = {'userId': 'demo:research', 'capturedAt': '2026-11-07T12:00:00Z',
                'featureVersion': 'sortfm.features.v1', 'candidates': candidates}
    training_ids = ['demo:prior-training:00', 'demo:prior-training:01']
    registry.extend({'trackId': track, 'split': 'train', 'role': 'training',
                     'feedbackState': 'active', 'revision': 1} for track in training_ids)
    predictions = {'modelVersion': 'research-fixture-v1', 'modelDigest': 'a' * 64,
                   'modelKind': 'logistic', 'trainingTrackIds': training_ids,
                   'featureVersion': 'sortfm.features.v1', 'sourceDigest': digest(snapshot),
                   'predictions': [{'trackId': row['trackId'], 'featureDigest': digest(row['features']),
                                    'removalProbability': (i % 5) / 4}
                                   for i, row in enumerate(candidates)]}
    return snapshot, registry, predictions


def prepare(snapshot=None, registry=None, predictions=None, **kwargs):
    from sortfm_ml.research_sampling import prepare_sampling
    source, roles, scores = inputs()
    return prepare_sampling(source if snapshot is None else snapshot,
                            roles if registry is None else registry,
                            pinned_predictions=scores if predictions is None else predictions,
                            **kwargs)


def test_pools_are_disjoint_and_representative_training_is_separate():
    manifest = prepare(evaluation_size=4, representative_size=3, diversity_size=3, uncertainty_size=3)
    rows = manifest['draws']
    assert len(rows) == len({r['trackId'] for r in rows}) == 13
    for row in rows:
        expected = ('holdout', 'evaluation') if row['strategy'] == 'representative_evaluation' else ('train', 'training')
        assert (row['split'], row['role']) == expected
        assert row['features']['provenance'] == 'synthetic'
        assert row['featureDigest'] == digest(row['features'])
        assert 'label' not in row
    assert manifest['offlineOnly'] is True
    assert manifest['promotionAllowed'] is False
    assert set(manifest['pools']['evaluation']).isdisjoint(manifest['pools']['training'])


def test_seed_replay_is_order_independent_and_does_not_mutate_inputs():
    from sortfm_ml.research_sampling import replay_sampling, validate_sampling_manifest
    snapshot, roles, predictions = inputs()
    originals = deepcopy((snapshot, roles, predictions))
    manifest = prepare(snapshot, roles, predictions, evaluation_size=4, representative_size=3,
                       diversity_size=3, uncertainty_size=3, sampling_seed=97)
    assert (snapshot, roles, predictions) == originals
    snapshot['candidates'].reverse()
    roles.reverse()
    predictions['predictions'].reverse()
    assert prepare(snapshot, roles, predictions, evaluation_size=4, representative_size=3,
                   diversity_size=3, uncertainty_size=3, sampling_seed=97) == manifest
    validate_sampling_manifest(manifest)
    assert replay_sampling(manifest) == manifest
    assert prepare(evaluation_size=4, sampling_seed=98)['manifestId'] != prepare(evaluation_size=4)['manifestId']
    manifest['draws'][0]['features']['values']['energy'] = .3
    with pytest.raises(ValueError, match='digest'):
        validate_sampling_manifest(manifest)


def test_representative_draws_ignore_predictions_and_other_strategy_sizes():
    snapshot, roles, scores = inputs()
    changed = deepcopy(scores)
    for row in changed['predictions']:
        row['removalProbability'] = .5
    one = prepare(snapshot, roles, scores, evaluation_size=5, representative_size=3, uncertainty_size=1)
    two = prepare(snapshot, roles, changed, evaluation_size=5, representative_size=3, uncertainty_size=7)
    representative = lambda m: [r for r in m['draws'] if r['strategy'].startswith('representative')]
    assert representative(one) == representative(two)


def test_previously_labeled_holdout_is_never_eligible_even_after_revocation():
    snapshot, roles, scores = inputs()
    roles.extend([{**roles[0], 'revision': 1, 'feedbackState': 'active'},
                  {**roles[0], 'revision': 2, 'feedbackState': 'revoked'}])
    roles[1]['feedbackState'] = 'revoked'  # Even an incomplete history retains this tombstone.
    roles[2]['feedbackState'] = 'superseded'
    manifest = prepare(snapshot, roles, scores, evaluation_size=5, uncertainty_size=5)
    assert set(manifest['pools']['evaluation']) == {r['trackId'] for r in roles[3:8]}
    assert all(row['trackId'] not in {roles[i]['trackId'] for i in range(3)} for row in manifest['draws'])
    with pytest.raises(ValueError, match='enough.*evaluation'):
        prepare(snapshot, roles, scores, evaluation_size=6)


def test_authoritative_active_labels_and_explicit_exclusions_are_not_sampled():
    snapshot, roles, scores = inputs()
    roles[8]['feedbackState'] = 'active'
    excluded = [roles[9]['trackId'], roles[3]['trackId']]
    manifest = prepare(snapshot, roles, scores, excluded_track_ids=excluded,
                       evaluation_size=7, representative_size=10)
    assert not {roles[8]['trackId'], *excluded} & {r['trackId'] for r in manifest['draws']}


@pytest.mark.parametrize('old_state', ['unlabeled', 'active', 'revoked', 'superseded'])
def test_role_and_split_changes_are_rejected_for_every_historical_state(old_state):
    snapshot, roles, scores = inputs()
    roles[0]['feedbackState'] = old_state
    roles.append({**roles[0], 'revision': 1, 'split': 'train', 'role': 'training'})
    with pytest.raises(ValueError, match='[Rr]ole.*immutable|[Rr]ole.*change'):
        prepare(snapshot, roles, scores, uncertainty_size=1)
    roles.pop()
    roles[0]['role'] = 'training'
    with pytest.raises(ValueError, match='holdout.*evaluation|role.*split'):
        prepare(snapshot, roles, scores)


def test_continuity_keeps_old_roles_and_reservations_when_candidates_disappear():
    snapshot, roles, scores = inputs()
    first = prepare(snapshot, roles, scores, evaluation_size=2, uncertainty_size=2)
    first_ids = {r['trackId'] for r in first['draws']}
    second = prepare(snapshot, roles, scores, previous_manifest=first, evaluation_size=2, uncertainty_size=2)
    assert not first_ids & {r['trackId'] for r in second['draws']}
    assert first_ids <= set(second['reservedTrackIds'])
    with pytest.raises(ValueError, match='history|registry'):
        prepare(snapshot, roles[1:], scores, previous_manifest=first)
    changed = deepcopy(roles)
    changed[0]['feedbackState'] = 'revoked'
    with pytest.raises(ValueError, match='history|registry'):
        prepare(snapshot, changed, scores, previous_manifest=first)
    roles.append({**roles[0], 'revision': 1, 'feedbackState': 'revoked'})
    third = prepare(snapshot, roles, scores, previous_manifest=second, evaluation_size=1)
    assert first_ids <= set(third['reservedTrackIds'])


def test_uniform_probabilities_are_conditional_and_have_known_marginal_inclusion():
    manifest = prepare(evaluation_size=3, representative_size=4)
    for strategy, n, k in [('representative_evaluation', 8, 3), ('representative_train', 12, 4)]:
        rows = [r for r in manifest['draws'] if r['strategy'] == strategy]
        assert [r['conditionalProbability'] for r in rows] == pytest.approx([1 / (n - i) for i in range(k)])
        assert all(r['marginalInclusionProbability'] == pytest.approx(k / n) for r in rows)


def test_uncertainty_mixture_probability_matches_entropy_and_has_positive_support():
    snapshot, roles, scores = inputs()
    epsilon = .2
    manifest = prepare(snapshot, roles, scores, uncertainty_size=12, exploration_probability=epsilon)
    remaining = {r['trackId']: r['removalProbability'] for r in scores['predictions'] if r['trackId'] in manifest['pools']['training']}
    for row in manifest['draws']:
        entropy = {key: 0.0 if p in (0, 1) else -(p * math.log2(p) + (1-p) * math.log2(1-p))
                   for key, p in remaining.items()}
        n, total = len(remaining), sum(entropy.values())
        expected = {key: epsilon / n + (1-epsilon) * (value / total if total else 1 / n)
                    for key, value in entropy.items()}
        assert sum(expected.values()) == pytest.approx(1)
        assert all(p > 0 for p in expected.values())
        assert row['conditionalProbability'] == pytest.approx(expected[row['trackId']])
        assert row['marginalInclusionProbability'] is None
        assert row['uniformComponentProbability'] == pytest.approx(epsilon / n)
        remaining.pop(row['trackId'])


def test_diversity_probabilities_match_published_strata_and_uniform_floor():
    manifest = prepare(diversity_size=12, exploration_probability=.3)
    remaining = set(manifest['pools']['training'])
    strata, seen = manifest['diversity']['strataByTrack'], {}
    for row in manifest['draws']:
        counts = {s: sum(strata[t] == s for t in remaining) for s in set(strata.values())}
        weights = {t: 1 / (counts[strata[t]] * (1 + seen.get(strata[t], 0))) for t in remaining}
        expected = .3 / len(remaining) + .7 * weights[row['trackId']] / sum(weights.values())
        assert row['conditionalProbability'] == pytest.approx(expected)
        assert row['marginalInclusionProbability'] is None
        assert row['stratum'] == strata[row['trackId']]
        remaining.remove(row['trackId'])
        seen[row['stratum']] = seen.get(row['stratum'], 0) + 1


@pytest.mark.parametrize('bad', [0, -1, 1.01, float('nan'), True])
def test_exploration_requires_positive_finite_probability(bad):
    with pytest.raises(ValueError, match='exploration'):
        prepare(uncertainty_size=1, exploration_probability=bad)


@pytest.mark.parametrize('field,value', [('sampling_seed', True), ('sampling_seed', 2**53),
                                        ('evaluation_size', -1), ('representative_size', True),
                                        ('diversity_size', 1.2), ('uncertainty_size', 13)])
def test_invalid_sizes_and_seeds_fail(field, value):
    with pytest.raises(ValueError):
        prepare(**{field: value})


def test_missing_or_stale_pinned_probabilities_fail_closed():
    from sortfm_ml.research_sampling import prepare_sampling
    snapshot, roles, scores = inputs()
    with pytest.raises(ValueError, match='pinned'):
        prepare_sampling(snapshot, roles, uncertainty_size=1)
    for field, value in [('sourceDigest', 'b' * 64), ('modelDigest', ''), ('featureVersion', 'future')]:
        changed = deepcopy(scores)
        changed[field] = value
        with pytest.raises(ValueError):
            prepare(snapshot, roles, changed, uncertainty_size=1)
    for field, value in [('featureDigest', 'b' * 64), ('removalProbability', None),
                         ('removalProbability', float('nan')), ('removalProbability', 2.0)]:
        changed = deepcopy(scores)
        changed['predictions'][8][field] = value
        with pytest.raises(ValueError):
            prepare(snapshot, roles, changed, uncertainty_size=1)
    scores['predictions'] = scores['predictions'][:8]
    with pytest.raises(ValueError, match='probabilit'):
        prepare(snapshot, roles, scores, uncertainty_size=1)


def test_duplicate_missing_unauthorized_and_invalid_features_are_rejected_or_excluded():
    snapshot, roles, scores = inputs()
    snapshot['candidates'].append(deepcopy(snapshot['candidates'][0]))
    with pytest.raises(ValueError, match='[Dd]uplicate'):
        prepare(snapshot, roles, scores)
    snapshot, roles, scores = inputs()
    with pytest.raises(ValueError, match='registry'):
        prepare(snapshot, roles[:-1], scores)
    snapshot['candidates'][0]['features']['permittedForTraining'] = False
    snapshot['candidates'][8]['features']['permittedForTraining'] = False
    from sortfm_ml.research_sampling import prepare_sampling
    manifest = prepare_sampling(snapshot, roles, evaluation_size=7, representative_size=11)
    assert len(manifest['draws']) == 18
    snapshot['candidates'][1]['features']['values']['energy'] = float('inf')
    with pytest.raises(ValueError):
        prepare_sampling(snapshot, roles)


def test_prediction_model_lineage_cannot_include_evaluation_or_unknown_training():
    snapshot, roles, scores = inputs()
    for training_ids in ([roles[0]['trackId']], ['demo:unknown'], [],
                         ['demo:prior-training:00', 'demo:prior-training:00']):
        changed = {**scores, 'trainingTrackIds': training_ids}
        with pytest.raises(ValueError, match='training|[Tt]rain'):
            prepare(snapshot, roles, changed, uncertainty_size=1)
    with pytest.raises(ValueError):
        prepare(snapshot, roles, {**scores, 'modelKind': 'heuristic'}, uncertainty_size=1)


def test_holdout_features_cannot_change_adaptive_draws_and_zero_is_observed():
    snapshot, roles, scores = inputs()
    first = prepare(snapshot, roles, scores, diversity_size=4, uncertainty_size=4)
    for row in snapshot['candidates'][:8]:
        row['features']['values'] = {'energy': 0.0}
    scores['sourceDigest'] = digest(snapshot)
    for row, pin in zip(snapshot['candidates'], scores['predictions']):
        pin['featureDigest'] = digest(row['features'])
    second = prepare(snapshot, roles, scores, diversity_size=4, uncertainty_size=4)
    assert first['draws'] == second['draws']
    assert 'energy:0' in second['diversity']['strataByTrack']['demo:research:09']


def test_no_entropy_falls_back_to_uniform_without_claiming_adaptive_marginals():
    snapshot, roles, scores = inputs()
    for row in scores['predictions']:
        row['removalProbability'] = 0.0
    manifest = prepare(snapshot, roles, scores, uncertainty_size=12)
    for row in manifest['draws']:
        assert row['conditionalProbability'] == pytest.approx(1 / row['eligiblePoolSize'])
        assert row['acquisitionScoreTotal'] == 0
        assert row['marginalInclusionProbability'] is None


def test_round_lineage_cannot_drop_assignments_even_when_tracks_leave_snapshot():
    from sortfm_ml.research_sampling import prepare_sampling
    snapshot, roles, scores = inputs()
    previous = prepare(snapshot, roles, scores, evaluation_size=2)
    snapshot['candidates'] = snapshot['candidates'][1:]
    with pytest.raises(ValueError, match='history'):
        prepare_sampling(snapshot, roles[1:], previous_manifest=previous)
    manifest = prepare_sampling(snapshot, roles, previous_manifest=previous)
    assert roles[0] in manifest['roleRegistry']


def test_replay_rejects_rehashed_but_inconsistent_draws():
    from sortfm_ml.research_sampling import replay_sampling
    manifest = prepare(evaluation_size=2)
    manifest['draws'][0]['conditionalProbability'] = .99
    manifest['manifestId'] = digest({k: v for k, v in manifest.items() if k != 'manifestId'})
    with pytest.raises(ValueError, match='replay'):
        replay_sampling(manifest)


def test_unrepresentably_small_exploration_fails_instead_of_recording_zero_support():
    with pytest.raises(ValueError, match='exploration'):
        prepare(uncertainty_size=12, exploration_probability=1e-300)


def test_exclusions_require_a_collection_of_track_ids_not_a_single_string():
    with pytest.raises(ValueError, match='excluded_track_ids'):
        prepare(excluded_track_ids='demo:research:00', evaluation_size=1)


def test_next_round_rejects_rehashed_prior_manifest_with_lost_reservations():
    previous = prepare(evaluation_size=2)
    previous['reservedTrackIds'] = []
    previous['manifestId'] = digest({k: v for k, v in previous.items() if k != 'manifestId'})
    with pytest.raises(ValueError, match='replay'):
        prepare(previous_manifest=previous, evaluation_size=2)
