"""Reproducible, local-only C1 listener calibration. Never calls Spotify or ML HTTP."""
import argparse
import json
from pathlib import Path

from .calibration import prepare, write_label_sheet
from .calibration_run import _write, evaluate, freeze


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    sample = commands.add_parser('prepare', help='Freeze a stratified sample and create blank Keep/Remove sheets')
    sample.add_argument('snapshot', type=Path)
    sample.add_argument('--output', type=Path, required=True, help='New private experiment directory')
    sample.add_argument('--size', type=int, default=60)
    sample.add_argument('--sampling-seed', type=int, default=42)
    sample.add_argument('--evaluation-seed', type=int, default=42, help='Must match the existing API split seed')
    fitting = commands.add_parser('freeze', help='Fit training labels and seal holdout predictions BEFORE labeling holdout')
    fitting.add_argument('manifest', type=Path)
    fitting.add_argument('--train-labels', type=Path, required=True)
    fitting.add_argument('--run', type=Path, required=True, help='Isolated offline run, never live ML artifacts')
    final = commands.add_parser('evaluate', help='Evaluate sealed predictions once, without fitting or tuning')
    final.add_argument('--run', type=Path, required=True)
    final.add_argument('--holdout-labels', type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == 'prepare':
            manifest = prepare(json.loads(args.snapshot.read_text()), args.size, args.sampling_seed, args.evaluation_seed)
            args.output.mkdir(mode=0o700, parents=True, exist_ok=False)
            _write(args.output / 'manifest.json', manifest)
            for split in ('train', 'holdout'):
                write_label_sheet(manifest, split, args.output / f'{split}-labels.csv')
            _write(args.output / 'pending-report.json', {
                'schemaVersion': 'sortfm.calibration-pending.v1', 'experimentId': manifest['experimentId'],
                'status': 'awaiting_listener_labels', 'populationSize': manifest['populationSize'],
                'plannedTraining': args.size - 20, 'plannedHoldout': 20,
                'labeledExamples': 0, 'trainedExamples': 0, 'heldOutExamples': 0,
                'rocAuc': None, 'logLoss': None, 'brierScore': None, 'precisionAtK': None,
                'reason': 'No listener labels supplied to this experiment; selected tracks are not labels.',
                'audioObservedCounts': manifest['sampling']['audioObservedCounts'],
            })
            print(f'Prepared {args.size} tracks in {args.output}. Fill train-labels.csv, freeze, then label holdout.')
        elif args.command == 'freeze':
            result = freeze(json.loads(args.manifest.read_text()), args.train_labels, args.run)
            print(f"Frozen {result['trainedExamples']} training labels; audio comparison {result['audioExperiment']['status']}. No final labels read.")
        else:
            result = evaluate(args.run, args.holdout_labels)
            print(f"Wrote {args.run / 'report.json'} and report.md; C1 metrics {result['models']['c1']['metrics']['status']}.")
    except (ValueError, OSError, KeyError, TypeError) as error:
        parser.error(str(error))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
