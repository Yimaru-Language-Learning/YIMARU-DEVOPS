#!/usr/bin/env bash
set -euo pipefail
export PATH="/srv/rezina/tools/bin:/srv/rezina/tools/go/bin:/usr/local/bin:/usr/bin:/bin"
export HOME=/srv/rezina
export GOMAXPROCS=2 NEXT_TELEMETRY_DISABLED=1
export GOCACHE=/srv/rezina/tools/go-cache GOPATH=/srv/rezina/tools/gopath
app=${1:?app required}
repo=${2:?checkout required}
case "$app" in admin|backend|customer) ;; *) exit 2 ;; esac
[[ "$repo" == "/srv/rezina/repos/$app" ]] || { echo 'Unexpected checkout path'; exit 2; }
cd "$repo"
release="/srv/rezina/releases/$app/$(date -u +%Y%m%dT%H%M%S)-$(git rev-parse --short HEAD)-$$"
mkdir -p "$release" /srv/rezina/current
case "$app" in
  admin)
    npm ci --include=dev --no-audit --no-fund
    VITE_API_BASE_URL=https://api.rezina.yaltopia.com/api/v1 npm run build
    test -s dist/index.html
    cp -a dist/. "$release/"
    ;;
  backend)
    go build -p 2 -trimpath -ldflags='-s -w' -o "$release/web" ./cmd/main.go
    go build -p 2 -trimpath -ldflags='-s -w' -o "$release/demo-seed" ./cmd/demo-seed
    # A failed build, migration or seed must never publish the new binary.
    python3 /srv/rezina/cicd/deploy/backend-database.py --repo "$repo" --seed-binary "$release/demo-seed"
    mkdir -p /srv/rezina/shared/static/demo
    cp -a static/demo/. /srv/rezina/shared/static/demo/
    ln -s /srv/rezina/shared/static "$release/static"
    ln -s /srv/rezina/shared/logs "$release/logs"
    ;;
  customer)
    pnpm install --frozen-lockfile --prod=false
    pnpm --filter demo build
    test -s apps/demo/out/index.html
    cp -a apps/demo/out/. "$release/"
    ;;
esac
previous=$(readlink "/srv/rezina/current/$app" || true)
publish() {
    ln -s "$1" "/srv/rezina/current/.$app-$$"
    mv -Tf "/srv/rezina/current/.$app-$$" "/srv/rezina/current/$app"
}
publish "$release"
if [[ "$app" == admin ]]; then exit 0; fi
service="rezina-$app.service"
url=http://127.0.0.1:18181/
[[ "$app" == customer ]] && url=http://127.0.0.1:18182/
healthy=false
if sudo -n systemctl restart "$service"; then
    for attempt in {1..30}; do
        if curl --fail --silent --max-time 2 "$url" >/dev/null; then healthy=true; break; fi
        sleep 1
    done
fi
if [[ "$healthy" != true ]]; then
    echo "Health check failed for $service; restoring previous release" >&2
    if [[ -n "$previous" ]]; then
        publish "$previous"
        sudo -n systemctl restart "$service"
    else
        sudo -n systemctl stop "$service"
        rm "/srv/rezina/current/$app"
    fi
    exit 1
fi
