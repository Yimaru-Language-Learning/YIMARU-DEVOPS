#!/usr/bin/env bash
set -euo pipefail
# Never attempt to repair unrelated configuration or start a failed shared Nginx.
if ! sudo -n systemctl is-active --quiet nginx; then
    echo 'Shared Nginx is not running. Resolve its existing failure before enabling Rezina.' >&2
    exit 1
fi
sudo -n nginx -t
files=(/srv/rezina/cicd/deploy/nginx/*.conf)
added=()
rollback() {
  for file in "${added[@]}"; do sudo -n rm -f "/etc/nginx/sites-enabled/$file" "/etc/nginx/sites-available/$file"; done
}
trap rollback ERR
for path in "${files[@]}"; do
  name=$(basename "$path")
  if [[ -e "/etc/nginx/sites-available/$name" || -L "/etc/nginx/sites-enabled/$name" ]]; then
    echo "Refusing to overwrite existing Nginx configuration: $name" >&2
    rollback
    exit 1
  fi
  added+=("$name")
  sudo -n install -m 644 "$path" "/etc/nginx/sites-available/$name"
  sudo -n ln -s "/etc/nginx/sites-available/$name" "/etc/nginx/sites-enabled/$name"
done
sudo -n nginx -t
sudo -n systemctl reload nginx
trap - ERR

for unit in rezina-tls-renew.service rezina-tls-renew.timer; do
  sudo -n install -m 644 "/srv/rezina/cicd/deploy/systemd/$unit" "/etc/systemd/system/$unit"
done
sudo -n systemctl daemon-reload
sudo -n systemctl enable --now rezina-tls-renew.timer
