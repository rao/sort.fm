import joblib
import numpy as np
import pytest
from sklearn.linear_model import LogisticRegression

from sortfm_ml.features import AUDIO_KEYS, CENTROID_KEYS, FEATURE_KEYS
from sortfm_ml.model import PreferenceModel
from test_model import candidate, example, labels


def test_audio_coverage_alone_cannot_predict_preference():
    rows = [example(i, i % 2, duration_ms=200000,
                    **({key: .5 for key in AUDIO_KEYS if key != 'tempo_bpm'} if i % 2 else {}))
            for i in range(60)]
    model = PreferenceModel(rows)
    probes = [candidate('missing', duration_ms=200000),
              candidate('covered', **rows[1]['features']['values'])]
    scores = [r['prediction']['removalProbability'] for r in model.predict(probes, 'test')]
    assert scores == pytest.approx([.5, .5], abs=1e-7)
    assert model.transform_context(probes).shape == (2, 2 * len(FEATURE_KEYS))


def test_sparse_audio_is_disabled_from_training_only_support():
    rows = [example(i, i % 2, **({'energy': .1 if i % 2 else .9} if i < 4 else {})) for i in range(40)]
    model = PreferenceModel(rows)
    probes = [candidate('low', energy=0), candidate('high', energy=1), candidate('none')]
    scores = [r['prediction']['removalProbability'] for r in model.predict(probes, 'test')]
    assert scores == pytest.approx([.5, .5, .5], abs=1e-7)
    for key in AUDIO_KEYS + CENTROID_KEYS:
        assert not model.predictor_mask_[model.pipeline.feature_names.index(key)]


def test_supported_audio_learns_but_missing_flags_have_zero_coefficients():
    model = PreferenceModel(labels())
    assert model.predictor_mask_[model.pipeline.feature_names.index('energy')]
    assert np.all(model.classifier.coef_[0][len(model.pipeline.value_names):] == 0)
    low, high = model.predict([candidate('low', energy=.1), candidate('high', energy=.9)], 'v')
    assert low['prediction']['removalProbability'] < high['prediction']['removalProbability']


def test_legacy_model_without_mask_retains_predictions_and_context(tmp_path):
    # Reproduce a v1 classifier whose nonzero missing coefficients must survive
    # upgrade. A newly trained v2 model with its mask deleted is not sufficient.
    rows = [example(i, i % 2, **({'energy': .5} if i % 2 else {})) for i in range(40)]
    model = PreferenceModel(rows)
    del model.predictor_mask_
    model.classifier = LogisticRegression(C=.5).fit(model.transform_context(rows), [r['label'] for r in rows])
    probes = [candidate('x', energy=.5), candidate('missing')]
    assert np.any(model.classifier.coef_[0][len(model.pipeline.value_names):] != 0)
    expected = model.predict(probes, 'old')
    np.testing.assert_allclose([r['prediction']['removalProbability'] for r in expected],
                               model.classifier.predict_proba(model.transform_context(probes))[:, 1])
    context = model.transform_context(probes)
    path = tmp_path / 'legacy.joblib'
    joblib.dump(model, path)
    restored = joblib.load(path)
    assert restored.predict(probes, 'old') == expected
    np.testing.assert_array_equal(restored.transform_context(probes), context)


def test_audio_gate_ignores_holdout_features_and_labels():
    train = [example(i, i % 2) for i in range(40)]
    holdout = [example(i, i % 2, split='holdout', energy=i / 100) for i in range(40, 60)]
    first, second = PreferenceModel(train), PreferenceModel(train + holdout)
    np.testing.assert_array_equal(first.predictor_mask_, second.predictor_mask_)
