#!/usr/bin/env python3
"""Read Gitea credentials as JSON on stdin; configure only the three Rezina repositories."""
import base64,json,pathlib,sys,urllib.request
credentials=json.load(sys.stdin)
config=dict(line.split('=',1) for line in pathlib.Path('/srv/rezina/config/cicd.env').read_text().splitlines())
secret=json.loads(config['GITEA_WEBHOOK_SECRET'])
headers={'Authorization':'Basic '+base64.b64encode((credentials['username']+':'+credentials['password']).encode()).decode(),'Content-Type':'application/json'}
base='https://gitea.yaltopia.com/api/v1'
def api(path,method='GET',data=None):
 req=urllib.request.Request(base+path,headers=headers,method=method,data=json.dumps(data).encode() if data is not None else None)
 with urllib.request.urlopen(req,timeout=30) as response: return json.load(response)
print('Authenticated Gitea user:',api('/user')['login'])
for repo in ['RezinaLMS-Admin','RezinaLMS-BackEnd','RezinaLMS-CustomerEnd']:
 path=f'/repos/RezinaLMS/{repo}/hooks'
 url='https://cicd.rezina.yaltopia.com/webhook/gitea'
 hooks=api(path)
 hook=next((h for h in hooks if h.get('config',{}).get('url')==url),None)
 if hook:
  print(repo,'existing hook',hook['id'],'active:',hook.get('active')); continue
 body={'type':'gitea','active':False,'events':['push'],'branch_filter':'main',
       'config':{'url':url,'content_type':'json','secret':secret,'http_method':'POST'}}
 created=api(path,'POST',body)
 print(repo,'created hook',created['id'],'inactive pending public HTTPS availability')
