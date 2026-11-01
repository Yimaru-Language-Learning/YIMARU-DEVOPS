#!/usr/bin/env bash
# Manual migration entry point; also used automatically by backend deployments.
set -euo pipefail
exec python3 /srv/rezina/cicd/deploy/backend-database.py
