# Rezina CI/CD

Gitea push deployments for Rezina on `fortune@fortune_serv` (`185.170.58.10`). The runner accepts signed `push` deliveries for `main` from exactly these repositories:

| Repository | Deployment | Public hostname |
| --- | --- | --- |
| RezinaLMS/RezinaLMS-Admin | Vite static build, served by Nginx | admin.rezina.yaltopia.com |
| RezinaLMS/RezinaLMS-BackEnd | Go 1.25 binary, rezina-backend.service | api.rezina.yaltopia.com |
| RezinaLMS/RezinaLMS-CustomerEnd | Next.js export, rezina-customer.service | rezina.yaltopia.com |

The customer repository currently exports a static site, so the customer service serves `apps/demo/out`; it does not run `next start`. `/waitlist` resolves to the existing standalone `waitlist/index.html`. This deploys the existing customer application; it does not add backend integration to its current local-data implementation.

## Server layout and isolation

Everything Rezina owns lives under `/srv/rezina`: `repos/{admin,backend,customer}`, immutable build outputs in `releases`, atomic publication links in `current`, configuration in `config`, runtime data in `shared`, and private tools in `tools`. Existing global Node, Go, databases, PM2 applications, CI/CD services, Nginx files, and Docker projects are not replaced.

| Component | Port | Service/container |
| --- | --- | --- |
| Webhook runner | 127.0.0.1:18180 | rezina-cicd.service |
| Backend | 18181 | rezina-backend.service |
| Customer | 127.0.0.1:18182 | rezina-customer.service |
| PostgreSQL | 127.0.0.1:15432 | rezina-postgres |
| MongoDB | 127.0.0.1:17017 | rezina-mongo |

The existing Go application binds its configured port on all interfaces. Nginx proxies it through localhost. The other two HTTP services bind only localhost. The runner serializes builds and has a 150% CPU and 4 GiB memory limit. The app services and databases also have independent resource limits. The deployment scripts only restart Rezina services. Static admin publication requires no Nginx restart or reload.

## Webhooks

Configure Gitea webhooks with:

- Type: Gitea, method POST, content type application/json.
- URL: `https://cicd.rezina.yaltopia.com/webhook/gitea`.
- Events: push only; branch filter: `main`; SSL verification enabled.
- Secret: `GITEA_WEBHOOK_SECRET` in `/srv/rezina/config/cicd.env`.

The receiver verifies the raw body's HMAC-SHA256 against the bare hexadecimal `X-Gitea-Signature`, requires a delivery ID, and deduplicates retries persistently. It checks the organization, repository, branch, and commit SHA before queuing. Each build checks out the delivered commit after verifying it belongs to `origin/main`. Dirty tracked files cause a failure rather than being overwritten. Pending builds interrupted by a service restart are marked interrupted; redeliver with a new Gitea delivery ID to retry.

`deploy/configure-webhooks.py` accepts a JSON object with Gitea `username` and `password` on stdin and creates missing hooks **inactive** until public HTTPS works. It never edits an existing hook. The three hooks were created with IDs 4 (admin), 5 (backend), and 6 (customer).

The dashboard and deployment logs require HTTP Basic authentication through Nginx. Credentials are in `/srv/rezina/config/dashboard-login.txt`; webhook authentication uses its own signature. Retrieve credentials over SSH rather than putting them in Git or chat.

## Updating the runner

Locally, run `bun install --frozen-lockfile`, `bun test`, `bun run build`, and `bun x tsc --noEmit`. `./deploy-service.sh` transfers the code, installs only the three Rezina unit files, and restarts only the Rezina runner. Run it when no deployments are active, because stopping the runner also stops its build children. It assumes the private runtime, config, and repositories have already been provisioned.

The inherited local Git `origin` still points to the previous project's GitHub repository. Choose a Rezina CI/CD repository before pushing this adapted code; the deployment script transfers files directly and does not push to that remote.

To deploy existing repository heads manually through the signed localhost webhook:

```bash
ssh fortune@fortune_serv 'python3 /srv/rezina/cicd/deploy/initial-deploy.py'
# Supply admin, backend, or customer as arguments to limit the deployment.
```

## Databases and migrations

`deploy/databases.compose.yml` owns only the `rezina` Docker project and its dedicated volumes. Credentials are generated in `/srv/rezina/config/databases.env`. `deploy/provision-config.py` creates missing configuration from a JSON object of app integration settings on stdin; it preserves existing files. Initial deployment reused the backend repository's existing Resend and AfroSMS settings. JWT and database secrets were generated independently. Optional payment, media, OAuth, and FCM credentials still need Rezina-specific configuration before those integrations can be used.

Every backend webhook deployment now builds the API and `cmd/demo-seed`, saves a PostgreSQL custom-format backup under `/srv/rezina/shared/backups/`, checks/applies pending migrations, and runs the compiled equivalent of `go run ./cmd/demo-seed -environment development`. `migrate up` applies only migrations not yet recorded in `schema_migrations`; an unchanged schema is a no-op. A unique migration snapshot prevents stale files from another checkout being applied. Database preparation is serialized with manual migration runs.

The seed uses `/srv/rezina/config/backend.env`, including `DB_URL` and optional `DEMO_SEED_PASSWORD` / `DEMO_VIDEO_URL`. Its existing production guards (`APP_ENV`, `ENVIRONMENT`, `GO_ENV`) are preserved. It creates the requested development fixtures, refreshes demo account credentials and their demo subscription, and preserves authored content. Use `DEMO_SEED_PASSWORD` to set the demo password; otherwise the seed's documented default applies. Demo assets are copied to the backend's shared static directory. The runner's deployment logs include the migration and seed output.

A build, backup, migration or seed failure aborts publication and leaves the running backend release in place. Database changes already applied are not automatically rolled back if a later step fails; use backward-compatible migrations and the saved backup for deliberate recovery. App-only rollback cannot reverse schema changes. Manual migration-only runs still use `bash /srv/rezina/cicd/deploy/migrate.sh` (no demo seed).

The consolidated baseline references a nonexistent legacy `modules.thumbnail` column. `prepare-migrations.py` stages a corrected copy that supplies `NULL::text` for the nullable destination thumbnail without modifying the server checkout. The same one-line correction is present in the local backend migration, ready to merge upstream. This compatibility substitution has no effect after upstream corrects the reference. The first install recovered only the failed transactional section of the new Rezina baseline, then applied migration 2; no existing application database was changed.

On 2026-11-01, live database preparation also revealed older subscription baseline drift: the database lacked `is_free` and still rejected the `EDUCATION` category. After separate backups, the existing baseline sections 000111 and 000115 were applied transactionally to align it with the current backend. Migration version 3 is clean; deployment 13 completed the development seed.

Backend and customer builds finish before publication. Publication uses an atomic symlink swap. A failed service restart or health check restores the previous release when one exists. Releases are retained for manual rollback; there is no automatic deletion of prior builds.

## Public Nginx status

All four Rezina virtual hosts are enabled in shared Nginx. Admin, backend, and customer return HTTPS 200. The CI/CD dashboard returns 401 without credentials and 200 with the credentials in `/srv/rezina/config/dashboard-login.txt`. Certificates for all four names are under `/srv/rezina/tls/live/rezina/`. `rezina-tls-renew.timer` checks renewal twice daily using the isolated Certbot directories and the `/srv/rezina/acme` webroot. A Certbot dry run successfully renewed all four domain names in simulation.

The original shared Nginx startup failure was repaired with the user's authorization. Only the TradingStage proxy location in `/etc/nginx/sites-available/default` changed: it now resolves `fortune-tradeart-api.tradingstage.io` through `127.0.0.53` at request time, with a 30-second DNS cache and a 5-second resolver timeout. Its destination, forwarded headers, TLS SNI, WebSocket configuration, and request URI handling remain unchanged. The original file is backed up at `/srv/rezina/config/nginx-default.before-repair`. The TradingStage hostname still points to an unresolvable AWS load balancer; that proxy returns 502 while its external upstream is unavailable, without preventing Nginx or the other sites from serving requests.

The 17 existing virtual hosts returned the same status codes before and after adding Rezina. Existing application services were not restarted. Baseline results are saved in `/srv/rezina/config/existing-http-before.json`. The original Nginx checksums and running-service list are `/srv/rezina/config/nginx-before.sha256` and `/srv/rezina/config/services-before.txt`; the default site's checksum changes because of the authorized repair.

`deploy/enable-nginx.sh` validates a running shared Nginx, refuses to overwrite existing virtual hosts, and performs a graceful reload after installing the Rezina virtual hosts. It has already been run; do not run it again against the installed files. Edit the dedicated Rezina configurations, run `sudo nginx -t`, and gracefully reload Nginx for future routing changes.

Gitea hooks 4, 5, and 6 are active for push events on `main`. Test deliveries completed successful deployments for admin (deployment 5), backend (deployment 6), and customer (deployment 7). Future pushes to `main` automatically deploy the corresponding application.
