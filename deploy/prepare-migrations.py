#!/usr/bin/env python3
"""Stage an exact migration snapshot, bridging a known consolidated-baseline typo."""
from pathlib import Path


def prepare_migrations(source, target):
    paths = list(source.glob('*.sql'))
    if not any(p.name.endswith('.up.sql') for p in paths):
        raise RuntimeError('No backend up migrations found')
    target.mkdir(parents=True, exist_ok=True)
    for stale in target.glob('*.sql'):
        stale.unlink()
    for path in paths:
        text = path.read_text()
        if path.name == '000001_Rezina.up.sql':
            # Legacy modules have icon but no thumbnail; the destination is nullable.
            text = text.replace('m.name, m.description, m.thumbnail, m.icon,',
                                'm.name, m.description, NULL::text, m.icon,')
        (target / path.name).write_text(text)


if __name__ == '__main__':
    prepare_migrations(Path('/srv/rezina/repos/backend/db/migrations'), Path('/srv/rezina/migrations'))
