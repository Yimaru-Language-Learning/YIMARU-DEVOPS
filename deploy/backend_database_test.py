import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('backend_database', Path(__file__).with_name('backend-database.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class DatabaseDeploymentTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / 'repo'
        self.migrations = self.repo / 'db/migrations'
        self.migrations.mkdir(parents=True)
        (self.migrations / '000003_changes.up.sql').write_text('SELECT 1;')
        self.binary = self.root / 'demo-seed'
        self.binary.touch()
        self.config = self.root / 'backend.env'
        self.url = 'postgresql://rezina:secret@127.0.0.1:15432/rezina?sslmode=disable'
        self.config.write_text('DB_URL=' + json.dumps(self.url) + '\nDEMO_SEED_PASSWORD="fixture-password"\n')
        self.backups = self.root / 'backups'

    def prepare(self):
        module.prepare_database(self.repo, self.binary, config=self.config, backups=self.backups)

    def test_backup_migrate_seed_order_and_environment(self):
        calls = []
        def run(args, **kwargs):
            calls.append((args, kwargs))
            if args[:2] == ['docker', 'run']:
                source = args[args.index('-v') + 1].split(':')[0]
                self.assertEqual((Path(source) / '000003_changes.up.sql').read_text(), 'SELECT 1;')
            return subprocess.CompletedProcess(args, 0, '', '')
        with patch.object(module.subprocess, 'run', side_effect=run):
            self.prepare()
        self.assertEqual(calls[0][0][:3], ['docker', 'exec', 'rezina-postgres'])
        self.assertEqual(calls[1][0][:2], ['docker', 'run'])
        self.assertNotIn(self.url, ' '.join(calls[1][0]))
        self.assertEqual(calls[1][1]['env']['DATABASE_URL'], self.url)
        self.assertEqual(calls[2][0], [str(self.binary), '-environment', 'development'])
        self.assertEqual(calls[2][1]['env']['DB_URL'], self.url)
        self.assertEqual(calls[2][1]['env']['DEMO_SEED_PASSWORD'], 'fixture-password')
        self.assertEqual(len(list(self.backups.glob('*.dump'))), 1)

    def test_migration_failure_never_runs_seed(self):
        def run(args, **kwargs):
            if args[:2] == ['docker', 'run']:
                raise subprocess.CalledProcessError(1, args)
            return subprocess.CompletedProcess(args, 0, '', '')
        with patch.object(module.subprocess, 'run', side_effect=run) as mocked:
            with self.assertRaises(subprocess.CalledProcessError): self.prepare()
            self.assertEqual(mocked.call_count, 2)

    def test_backup_failure_never_migrates_and_removes_partial_backup(self):
        with patch.object(module.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, ['pg_dump'])) as mocked:
            with self.assertRaises(subprocess.CalledProcessError): self.prepare()
            self.assertEqual(mocked.call_count, 1)
        self.assertEqual(list(self.backups.glob('*.dump')), [])

    def test_production_guard_and_wrong_database_fail_before_backup(self):
        with patch.object(module.subprocess, 'run') as mocked:
            with patch.dict(module.os.environ, {'APP_ENV': 'production'}):
                with self.assertRaisesRegex(RuntimeError, 'disabled'): self.prepare()
            self.config.write_text('DB_URL="postgres://other:secret@127.0.0.1:5433/other"\n')
            with self.assertRaisesRegex(RuntimeError, 'dedicated'): self.prepare()
            mocked.assert_not_called()

    def test_seed_failure_aborts_database_step(self):
        def run(args, **kwargs):
            if args[0] == str(self.binary): raise subprocess.CalledProcessError(2, args)
            return subprocess.CompletedProcess(args, 0, '', '')
        with patch.object(module.subprocess, 'run', side_effect=run):
            with self.assertRaises(subprocess.CalledProcessError): self.prepare()

    def test_snapshot_removes_stale_migrations(self):
        stage = module.runpy.run_path(str(Path(__file__).with_name('prepare-migrations.py')))['prepare_migrations']
        target = self.root / 'snapshot'
        target.mkdir()
        (target / '000999_future.up.sql').write_text('must not apply')
        stage(self.migrations, target)
        self.assertEqual([p.name for p in target.iterdir()], ['000003_changes.up.sql'])


if __name__ == '__main__': unittest.main()
