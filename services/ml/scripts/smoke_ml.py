"""Real loopback HTTP train/score/observe/restart smoke; uses synthetic data only."""
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
from tempfile import TemporaryDirectory
import time
from uuid import uuid4

import httpx

from sortfm_ml.cli import generate_synthetic
from sortfm_ml.schemas import FitResponse, ScoreResponse, ObserveResponse, ExplainResponse


def main():
    with TemporaryDirectory(prefix='sortfm-smoke-') as directory:
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        secret = secrets.token_urlsafe(32)
        environment = dict(os.environ, ML_SERVICE_SHARED_SECRET=secret, ML_ARTIFACT_DIR=directory)
        base = f'http://127.0.0.1:{port}'
        headers = {'Authorization':f'Bearer {secret}'}
        process = None
        with httpx.Client(base_url=base, timeout=30) as client:
            def start():
                server = subprocess.Popen([sys.executable,'-m','uvicorn','sortfm_ml.app:app',
                    '--host','127.0.0.1','--port',str(port),'--log-level','warning'],
                    env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    if server.poll() is not None:
                        raise RuntimeError('Smoke server exited before readiness')
                    try:
                        if client.get('/health').status_code == 200:
                            return server
                    except httpx.TransportError:
                        pass
                    time.sleep(.05)
                server.terminate(); server.wait(timeout=5)
                raise RuntimeError('Smoke server failed to start')

            try:
                process = start()
                assert client.get('/health').json()['capabilities']['scoring'] is True
                assert client.post('/fit',json={}).status_code == 401
                payload = generate_synthetic(seed=42,size=160)
                fit = client.post('/fit',json=payload,headers=headers)
                assert fit.status_code == 200, fit.text
                fitted = FitResponse.model_validate(fit.json())
                example = payload['examples'][0]
                candidate = {key:example[key] for key in ('trackId','features')}
                candidate['exposureId'] = str(uuid4())
                request = {'userId':payload['userId'],'featureVersion':payload['featureVersion'],
                    'candidates':[candidate],'modelVersion':None}
                response = client.post('/score',json=request,headers=headers)
                assert response.status_code == 200, response.text
                scored = ScoreResponse.model_validate(response.json())
                original = response.json()
                observed = {'userId':payload['userId'],'eventId':str(uuid4()),
                    'decisionId':example['decisionId'],'exposureId':candidate['exposureId'],
                    'trackId':example['trackId'],'feedbackRevision':161,'operation':'revoke',
                    'label':None,'features':example['features'],'occurredAt':'2026-11-07T15:00:00Z'}
                response = client.post('/observe',json=observed,headers=headers)
                assert response.status_code == 200, response.text
                ObserveResponse.model_validate(response.json())
                assert client.post('/observe',json=observed,headers=headers).json()==response.json()
                assert client.post('/score',json=request,headers=headers).json()==original
                process.terminate(); process.wait(timeout=5); process = start()
                assert client.post('/score',json=request,headers=headers).json()==original
                explained = client.get('/explain',params={'userId':payload['userId'],
                    'exposureId':candidate['exposureId']},headers=headers)
                assert explained.status_code==200
                assert ExplainResponse.model_validate(explained.json()).prediction==scored.predictions[0].prediction
                print(f'PASS real HTTP: auth, fit ({fitted.trainedExamples} train), score, revoke, replay, restart, immutable explain; evaluation={fitted.metrics.status}; synthetic only')
            finally:
                if process is not None and process.poll() is None:
                    process.terminate(); process.wait(timeout=5)


if __name__=='__main__':
    main()
