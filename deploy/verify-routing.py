#!/usr/bin/env python3
"""Verify only Rezina vhosts on temporary loopback ports; never load shared nginx.conf."""
from pathlib import Path
import tempfile,subprocess,json,hmac,hashlib
root=Path(tempfile.mkdtemp(prefix='routing-test-',dir='/srv/rezina/nginx'))
for source in Path('/srv/rezina/cicd/deploy/nginx').glob('*.conf'):
    text=source.read_text().replace('listen 80;', 'listen 127.0.0.1:19480;').replace('listen 443 ssl http2;', 'listen 127.0.0.1:19443 ssl http2;')
    (root/source.name).write_text(text)
config=root/'nginx.conf'
config.write_text(f'user www-data;\npid {root}/nginx.pid;\nerror_log {root}/error.log;\nevents {{}}\nhttp {{ include /etc/nginx/mime.types; include {root}/*.com.conf; }}\n')
command=['sudo','-n','nginx','-p',str(root)+'/', '-c',str(config)]
subprocess.run(command+['-t'],check=True)
subprocess.run(command,check=True)
def request(host,path='/',extra=None):
    cmd=['curl','--silent','--show-error','--max-time','15','--resolve',f'{host}:19443:127.0.0.1','-o','/dev/null','-w','%{http_code}',f'https://{host}:19443{path}']
    return subprocess.check_output(cmd+(extra or []),text=True).strip()
try:
    for host in ['admin.rezina.yaltopia.com','api.rezina.yaltopia.com','rezina.yaltopia.com']:
        code=request(host)
        print(host,code)
        assert code=='200'
    assert request('admin.rezina.yaltopia.com','/courses/test')=='200'
    assert request('rezina.yaltopia.com','/waitlist')=='200'
    assert request('rezina.yaltopia.com','/definitely-missing')=='404'
    assert request('cicd.rezina.yaltopia.com')=='401'
    assert request('cicd.rezina.yaltopia.com','/webhook/gitea',['-X','POST','--data','{}'])=='401'
    env=dict(line.split('=',1) for line in Path('/srv/rezina/config/cicd.env').read_text().splitlines())
    secret=json.loads(env['GITEA_WEBHOOK_SECRET'])
    signature=hmac.new(secret.encode(),b'{}',hashlib.sha256).hexdigest()
    assert request('cicd.rezina.yaltopia.com','/webhook/gitea',['-X','POST','--data','{}','-H','X-Gitea-Event: ping','-H','X-Gitea-Signature: '+signature])=='200'
    print('TLS, admin SPA fallback, customer waitlist/404, dashboard auth, and signed webhook routing passed')
finally:
    subprocess.run(command+['-s','quit'],check=True)
