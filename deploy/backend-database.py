#!/usr/bin/env python3
"""Back up, migrate and seed the dedicated Rezina database before publishing a backend."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit

CONFIG = Path('/srv/rezina/config/backend.env')
BACKUPS = Path('/srv/rezina/shared/backups')


def load_environment(path):
    values = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        key, value = line.split('=', 1)
        value = value.strip()
        if value.startswith('"'):
            value = json.loads(value)
        elif value.startswith("'") and value.endswith("'"):
            value = value[1:-1]
        values[key.strip()] = value
    return {**os.environ, **values}


def prepare_database(repo, seed_binary=None, *, config=CONFIG, backups=BACKUPS):
    env = load_environment(config)
    url = env.get('DB_URL', '')
    target = urlsplit(url)
    if (target.scheme not in ('postgres', 'postgresql') or target.hostname != '127.0.0.1'
            or target.port != 15432 or target.path != '/rezina' or target.username != 'rezina'):
        raise RuntimeError('DB_URL must target the dedicated local Rezina PostgreSQL database')
    if seed_binary:
        for key in ('APP_ENV', 'ENVIRONMENT', 'GO_ENV'):
            if env.get(key, '').strip().lower() in ('prod', 'production'):
                raise RuntimeError('Demo seeding is disabled by ' + key)
        if not seed_binary.is_file():
            raise RuntimeError('Build cmd/demo-seed before applying migrations')
    backups.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Serialize manual migrations with webhook migrations/seeding.
    with (backups / '.database-deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        with tempfile.TemporaryDirectory(prefix='migrations-', dir=backups.parent) as directory:
            stage = runpy.run_path(str(Path(__file__).with_name('prepare-migrations.py')))['prepare_migrations']
            stage(repo / 'db/migrations', Path(directory))
            fd, filename = tempfile.mkstemp(prefix='backend-', suffix='.dump', dir=backups)
            print('Backing up Rezina database to ' + filename, flush=True)
            try:
                with os.fdopen(fd, 'wb') as output:
                    subprocess.run(['docker', 'exec', 'rezina-postgres', 'pg_dump', '-U', 'rezina', '-d', 'rezina', '-Fc'], stdout=output, check=True)
            except Exception:
                Path(filename).unlink(missing_ok=True)
                raise
            print('Applying pending backend migrations (up to date is a no-op)', flush=True)
            # Credentials travel in the environment, not deployment command logs.
            try:
                result = subprocess.run(['docker', 'run', '--rm', '--network', 'host', '--cpus=0.5', '--memory=256m',
                            '-v', directory + ':/migrations:ro', '-e', 'DATABASE_URL', '--entrypoint', '/bin/sh',
                            'migrate/migrate:latest', '-c', 'exec migrate -path /migrations -database "$DATABASE_URL" up'],
                           env={**env, 'DATABASE_URL': url}, check=True, capture_output=True, text=True)
                print(result.stdout or '', end='', flush=True)
                print(result.stderr or '', end='', file=sys.stderr, flush=True)
            except subprocess.CalledProcessError as error:
                message = (error.stdout or '') + (error.stderr or '')
                message = message.replace(url, '[database URL]')
                if target.password:
                    message = message.replace(target.password, '[redacted]')
                print(message, file=sys.stderr, flush=True)
                raise
            if seed_binary:
                print('Running cmd/demo-seed -environment development', flush=True)
                subprocess.run([str(seed_binary), '-environment', 'development'], cwd=repo, env=env, check=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path('/srv/rezina/repos/backend'))
    parser.add_argument('--seed-binary', type=Path)
    args = parser.parse_args()
    try:
        prepare_database(args.repo, args.seed_binary)
    except subprocess.CalledProcessError as error:
        # migrate may include the database URL in its error output; never print env/argv here.
        raise SystemExit('Database preparation failed (exit ' + str(error.returncode) + '); release was not published')
