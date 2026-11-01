#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
bun install --frozen-lockfile
bun run test
bun run build
ssh -o BatchMode=yes fortune@fortune_serv 'mkdir -p /srv/rezina/cicd'
# Exclude all local secrets, dependency trees, and repository metadata.
rsync -az --exclude='.git/' --exclude='node_modules/' --exclude='.env*' --exclude='*.db*' --exclude='.runtime/' \
  ./ fortune@fortune_serv:/srv/rezina/cicd/
ssh -o BatchMode=yes fortune@fortune_serv 'set -e
for unit in rezina-cicd rezina-backend rezina-customer; do
  sudo install -m 644 /srv/rezina/cicd/deploy/systemd/$unit.service /etc/systemd/system/$unit.service
done
sudo systemctl daemon-reload
sudo systemctl enable rezina-cicd rezina-backend rezina-customer
sudo systemctl restart rezina-cicd
curl --fail --silent http://127.0.0.1:18180/health'
