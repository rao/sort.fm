"""Run private C1 research without network or serving writes.

python -m sortfm_ml.research_cli --package PRIVATE_PACKAGE --output private-data/RUN
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess

import numpy as np
import sklearn

from .cli import split_for_track
from .research_benchmark import run_benchmarks, paired_log_loss
from .research_data import audit_snapshot, identity, load_package, sha256
from .research_diagnostics import pinned_diagnostics
from .research_report import audio_comparison, make_plots, write_report
from .research_sampling import prepare_sampling, content_digest, snapshot_digest
from .schemas import Candidate


# Preserve source bytes associated with this process and reject later edits.
# Run a fresh process after edits; source_commit alone omits uncommitted files.
_SOURCE_AT_IMPORT={p:p.read_bytes() for p in Path(__file__).parent.glob('*.py')}


def _assert_source_unchanged():
    if (set(Path(__file__).parent.glob('*.py'))!=set(_SOURCE_AT_IMPORT)
            or any(p.read_bytes()!=contents for p,contents in _SOURCE_AT_IMPORT.items())):
        raise ValueError('Research implementation changed during this process; restart with frozen source')


def private_destination(path):
    if '..' in Path(path).parts:
        raise ValueError('Parent traversal is forbidden in private output paths')
    path=Path(path).absolute()
    if 'private-data' not in path.parts:
        raise ValueError('Research output must be inside an ignored private-data directory')
    if any(p.is_symlink() for p in [path,*path.parents]):
        raise ValueError('Research output cannot traverse a symlink')
    if path.exists():
        raise ValueError('Output exists; choose a new immutable run directory')
    private_root=Path(*path.parts[:path.parts.index('private-data')+1])
    private_root.mkdir(parents=True,exist_ok=True,mode=0o700);private_root.chmod(0o700)
    path.mkdir(parents=True,mode=0o700)
    for parent in [path,*path.parents]:
        parent.chmod(0o700)
        if parent==private_root: break
    return path.resolve()


def save_json(path, data):
    path.write_text(json.dumps(data,sort_keys=True,indent=2,allow_nan=False)+'\n');path.chmod(0o600)


def _package_member(root, name):
    if not isinstance(name,str) or not name or Path(name).is_absolute() or '\\' in name:
        raise ValueError('Package artifact paths must be relative paths')
    if '..' in Path(name).parts:
        raise ValueError('Package artifact parent traversal is forbidden')
    source=(root/name).resolve()
    if not source.is_relative_to(root) or not source.is_file():
        raise ValueError('Artifact must be a file inside the source package')
    return source


def freeze_inputs(package_path, destination, trusted_artifact=False):
    """Capture exact whitelisted bytes, check hashes, then publish private copies.

    Loading and all numerical work consume only these copies. Raw INDEX paths
    never become destinations before lexical and resolved confinement checks.
    Untrusted/default runs never copy or deserialize a pickle artifact.
    """
    root=Path(package_path).resolve();destination=Path(destination)
    names=['database-snapshot.json','database-verification.json','model/pinned-state.json']
    payloads={}
    if trusted_artifact:
        payloads['INDEX.json']=_package_member(root,'INDEX.json').read_bytes()
        index=json.loads(payloads['INDEX.json'])
        for key in ('model','modelManifest'):
            name=index['files'][key]
            _package_member(root,name)  # Reject unsafe INDEX names before any output.
            if name in names or name in payloads:
                raise ValueError('Duplicate artifact path in package index')
            names.append(name)
    for name in names:
        payloads[name]=_package_member(root,name).read_bytes()
    hashes={name:hashlib.sha256(contents).hexdigest() for name,contents in payloads.items()}
    if hashes['database-snapshot.json']!=json.loads(payloads['database-verification.json'])['snapshotSha256']:
        raise ValueError('Database snapshot checksum mismatch during freeze')
    if trusted_artifact:
        artifact_manifest=json.loads(payloads[index['files']['modelManifest']])
        if hashes[index['files']['model']]!=artifact_manifest['sha256']:
            raise ValueError('Model checksum mismatch during freeze')
    destination.mkdir(mode=0o700)
    for name,contents in payloads.items():
        target=destination/name
        target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        with target.open('xb') as stream:
            target.chmod(0o600)
            stream.write(contents)
        if sha256(target)!=hashes[name]:
            raise ValueError('Frozen input checksum mismatch')
    save_json(destination/'frozen-inputs-manifest.json',
              {'schema':'sortfm.frozen-research-inputs.v1','files':hashes})
    return hashes


def sampling_reference(package):
    """Private proposal only: no reservations, labels, queue or model publish."""
    data=package['snapshot'];state=package['state']
    model=package['model']
    if model is None or model.model_kind not in ('logistic','sgd_logistic','tree'):
        return {'status':'unavailable','reason':'pinned_model_required','offlineOnly':True}
    candidates=[Candidate.model_validate(row).model_dump(exclude_unset=True)
                for row in data['assembledCandidates']]
    snapshot={'userId':state['userId'],'featureVersion':'sortfm.features.v1',
              'capturedAt':data['state']['snapshot_at'],'candidates':candidates}
    fixed_splits=dict(state['splits']);active={r['trackId'] for r in package['examples']}
    # Database tombstones can predate any ML snapshot when outbox revisions
    # coalesce. They still permanently exclude a track from a fresh evaluation.
    database_seen=set()
    for row in data['effectiveFeedback']:
        track,split=row['track_id'],row['split']
        if track in database_seen or split not in ('train','holdout'):
            raise ValueError('Invalid duplicate or split in effective feedback')
        database_seen.add(track)
        if track in fixed_splits and fixed_splits[track]!=split:
            raise ValueError('Database/model historical split mismatch')
        fixed_splits[track]=split
    known=set(fixed_splits)
    registry=[]
    for track in sorted(known | {r['trackId'] for r in candidates}):
        split=fixed_splits.get(track,split_for_track(state['userId'],track,state['seed']))
        registry.append({'trackId':track,'split':split,'role':'training' if split=='train' else 'evaluation',
                         'feedbackState':'active' if track in active else 'revoked' if track in known else 'unlabeled',
                         'revision':state['revision']})
    eligible=set(data['calibrationEligibleTrackIds'])
    excluded={r['trackId'] for r in candidates if r['trackId'] not in eligible}
    # Validate roles/features first and report shortages without silently
    # shrinking the prespecified recipe or aborting the empirical report.
    pools=prepare_sampling(snapshot,registry,excluded_track_ids=sorted(excluded))['pools']
    counts={name:len(ids) for name,ids in pools.items()}
    if counts['evaluation']<25 or counts['training']<65:
        return {'status':'unavailable','reason':'insufficient_sampling_pool','offlineOnly':True,
                'eligible_counts':counts,'required_counts':{'evaluation':25,'training':65}}
    predictions=model.predict(candidates,package['model_version'])
    features={r['trackId']:r['features'] for r in candidates}
    pins={'modelVersion':package['model_version'],'modelDigest':package['provenance']['model_sha256'],
          'modelKind':model.model_kind,'trainingTrackIds':[r['trackId'] for r in package['examples'] if r['split']=='train' and r['features']['permittedForTraining']],
          'featureVersion':'sortfm.features.v1','sourceDigest':snapshot_digest(snapshot),
          'predictions':[{'trackId':r['trackId'],'featureDigest':content_digest(features[r['trackId']]),
                          'removalProbability':r['prediction']['removalProbability']} for r in predictions]}
    return prepare_sampling(snapshot,registry,evaluation_size=25,representative_size=20,
                            diversity_size=25,uncertainty_size=20,excluded_track_ids=sorted(excluded),
                            pinned_predictions=pins,sampling_seed=42,exploration_probability=.2)


def run(package_path, output, trusted_artifact=False, repeats=5):
    # Freeze first, then validate/load only frozen bytes. All writes remain in
    # the explicitly new private output directory.
    if type(repeats) is not int or repeats<1:
        raise ValueError('repeats must be a positive integer')
    _assert_source_unchanged()
    package_path=Path(package_path).resolve()
    output=private_destination(output)
    previous_umask=os.umask(0o077)
    try:
        input_dir=output/'inputs'
        input_hashes=freeze_inputs(package_path,input_dir,trusted_artifact=trusted_artifact)
        package=load_package(input_dir,trusted_artifact=trusted_artifact)
        frozen=output/'implementation';frozen.mkdir(mode=0o700)
        ml_root=Path(__file__).resolve().parents[2]
        for source,contents in sorted(_SOURCE_AT_IMPORT.items()):
            (frozen/source.name).write_bytes(contents)
        for name in ('pyproject.toml','uv.lock'):
            shutil.copyfile(ml_root/name,frozen/name)
        for source in sorted((ml_root/'docs').glob('research-*.md')):
            shutil.copyfile(source,frozen/source.name)
        save_json(input_dir/'original-examples.json',package['examples'])
        save_json(input_dir/'audio-augmented-examples.json',package['audio_augmented'])
        original=run_benchmarks(package['examples'],repeats=repeats)
        augmented=run_benchmarks(package['audio_augmented'],repeats=repeats)
        contrasts={}
        for protocol in original['protocols']:
            left=original['protocols'][protocol];right=augmented['protocols'][protocol]
            if not left['models']: continue
            # Metadata-only must be EXACTLY invariant to an audio-only edit.
            if left['folds']!=right['folds'] or left['models']['E2']['predictions']!=right['models']['E2']['predictions']:
                raise ValueError('Audio ablation changed metadata predictions or evaluation population')
            contrasts[protocol]={name:paired_log_loss(left['models'][name]['predictions'],right['models'][name]['predictions']) for name in ('E3','C1')}
        try:
            commit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ml_root,text=True).strip()
        except (OSError,subprocess.CalledProcessError): commit=None
        report={'private':True,'schema_version':'sortfm.research-report.v1',
                'generated_at':datetime.now(timezone.utc).isoformat(),
                'provenance':package['provenance'],
                'runtime':{'python':platform.python_version(),'numpy':np.__version__,'sklearn':sklearn.__version__},
                'source_commit':commit,'source_files':{p.name:sha256(p) for p in sorted(frozen.iterdir())},
                'input_files':input_hashes,
                'audit':audit_snapshot(package['snapshot']),'pinned_diagnostics':pinned_diagnostics(package),
                'original':original,'audio_augmented':augmented,'paired_audio_refresh':contrasts,
                'audio_comparison':audio_comparison(original,augmented,package)}
        save_json(output/'results.json',report)
        save_json(output/'sampling-reference.json',sampling_reference(package))
        make_plots(report,output/'plots');write_report(report,output)
        _assert_source_unchanged()
        if any(sha256(input_dir/name)!=expected for name,expected in input_hashes.items()):
            raise ValueError('Frozen research inputs changed during analysis')
        manifest={str(p.relative_to(output)):sha256(p) for p in sorted(output.rglob('*')) if p.is_file()}
        save_json(output/'manifest.json',{'schema':'sortfm.private-research-manifest.v1','files':manifest})
        for p in output.rglob('*'): p.chmod(0o700 if p.is_dir() else 0o600)
        return output
    finally:
        os.umask(previous_umask)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--package',required=True,type=Path)
    parser.add_argument('--output',required=True,type=Path)
    parser.add_argument('--trusted-local-artifact',action='store_true',help='Explicitly allow loading a verified, operator-controlled local joblib. Never use uploaded artifacts.')
    parser.add_argument('--repeats',type=int,default=5)
    args=parser.parse_args()
    output=run(args.package,args.output,args.trusted_local_artifact,args.repeats)
    print(f'Private research report saved: {output / "report.md"}')


if __name__=='__main__': main()
