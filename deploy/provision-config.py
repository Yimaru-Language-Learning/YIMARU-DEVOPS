#!/usr/bin/env python3
"""Run as fortune on the server; stdin is a JSON object of existing app integration settings."""
import json, pathlib, secrets, sys
root = pathlib.Path('/srv/rezina/config')
root.mkdir(mode=0o700, exist_ok=True)
integrations = json.load(sys.stdin)
def write_env(name, values):
    path = root / name
    if path.exists():
        print(f'Keeping existing {name}')
        return
    # Values are JSON quoted for dotenv/systemd; generated secrets are hex.
    with path.open('x') as f:
        f.write(''.join(f'{key}={json.dumps(str(value))}\n' for key, value in values.items()))
    path.chmod(0o600)
pg, mongo = secrets.token_hex(32), secrets.token_hex(32)
if (root / 'databases.env').exists():
    existing = dict(line.strip().split('=', 1) for line in (root / 'databases.env').read_text().splitlines())
    pg, mongo = json.loads(existing['POSTGRES_PASSWORD']), json.loads(existing['MONGO_PASSWORD'])
write_env('databases.env', {'POSTGRES_PASSWORD': pg, 'MONGO_PASSWORD': mongo})
write_env('cicd.env', {
    'GITEA_WEBHOOK_SECRET': secrets.token_hex(32), 'PORT':18180, 'PRODUCTION_BRANCH':'main',
    'REZINA_ADMIN_PATH':'/srv/rezina/repos/admin', 'REZINA_BACKEND_PATH':'/srv/rezina/repos/backend',
    'REZINA_CUSTOMER_PATH':'/srv/rezina/repos/customer', 'DB_PATH':'/srv/rezina/shared/deployments.db',
})
write_env('backend.env', {
    **integrations, 'ENV':'production', 'PORT':18181, 'APP_VERSION':'1.0.1',
    'REPORT_EXPORT_PATH':'/srv/rezina/shared/reports',
    'DB_URL':f'postgresql://rezina:{pg}@127.0.0.1:15432/rezina?sslmode=disable',
    'MONGODB_URL':f'mongodb://rezina:{mongo}@127.0.0.1:17017/?authSource=admin',
    'JWT_KEY':secrets.token_hex(48), 'ACCESS_EXPIRY':15, 'REFRESH_EXPIRY':43200, 'LOG_LEVEL':'info',
    'TEAM_INVITE_BASE_URL':'https://admin.rezina.yaltopia.com',
    'TEAM_PASSWORD_RESET_BASE_URL':'https://admin.rezina.yaltopia.com',
    'LEARNER_APP_BASE_URL':'https://rezina.yaltopia.com',
    'LEARNER_WEB_CHECKOUT_BASE_URL':'https://rezina.yaltopia.com',
    'PASSWORD_RESET_BASE_URL':'https://rezina.yaltopia.com',
})
