#!/usr/bin/env python3
"""Send authenticated localhost push deliveries for the three checked-out main heads."""
import hashlib, hmac, json, pathlib, subprocess, urllib.request, uuid, sys
config = dict(line.split('=', 1) for line in pathlib.Path('/srv/rezina/config/cicd.env').read_text().splitlines())
secret = json.loads(config['GITEA_WEBHOOK_SECRET'])
for app, repo in [('admin','RezinaLMS-Admin'), ('backend','RezinaLMS-BackEnd'), ('customer','RezinaLMS-CustomerEnd')]:
    if len(sys.argv) > 1 and app not in sys.argv[1:]: continue
    sha = subprocess.check_output(['git','-C',f'/srv/rezina/repos/{app}','rev-parse','origin/main'], text=True).strip()
    payload = json.dumps({'repository':{'name':repo,'owner':{'login':'RezinaLMS'}},'ref':'refs/heads/main','after':sha}).encode()
    req = urllib.request.Request('http://127.0.0.1:18180/webhook/gitea', data=payload, headers={
        'Content-Type':'application/json', 'X-Gitea-Event':'push', 'X-Gitea-Delivery':str(uuid.uuid4()),
        'X-Gitea-Signature':hmac.new(secret.encode(),payload,hashlib.sha256).hexdigest(),
    })
    print(urllib.request.urlopen(req,timeout=10).read().decode())
