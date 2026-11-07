"""CPU timing only; no accuracy claims and no external/private data."""
import argparse
import hashlib
import json
from pathlib import Path
import platform
from statistics import median
from time import perf_counter

import numpy
import sklearn

from sortfm_ml.cli import generate_synthetic
from sortfm_ml.model import PreferenceModel


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    payload=generate_synthetic(seed=42,size=2700)
    training=[row for row in payload['examples'] if row['split']=='train'][:100]
    candidates=[{'trackId':row['trackId'],'features':row['features']} for row in payload['examples']]
    fits,scores=[],[]
    for _ in range(5):
        start=perf_counter(); model=PreferenceModel(training,seed=42); fits.append(perf_counter()-start)
        start=perf_counter(); predictions=model.predict(candidates,'benchmark'); scores.append(perf_counter()-start)
        assert len(predictions)==2700 and all(row['prediction']['removalProbability'] is not None for row in predictions)
    report={'notice':'Local CPU timings on synthetic data, five measured runs; not a latency SLA or predictive evaluation.',
        'machine':platform.machine(),'python':platform.python_version(),'numpy':numpy.__version__,'sklearn':sklearn.__version__,
        'trainingExamples':100,'scoredCandidates':2700,'contextColumns':len(model.pipeline.feature_names),
        'seed':42,'inputSha256':hashlib.sha256(json.dumps(payload,sort_keys=True).encode()).hexdigest(),
        'fitSeconds':fits,'scoreSeconds':scores,'medianFitSeconds':median(fits),'medianScoreSeconds':median(scores)}
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({key:report[key] for key in ('trainingExamples','scoredCandidates','medianFitSeconds','medianScoreSeconds')}))


if __name__=='__main__': main()
