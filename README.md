# Yimaru CI/CD

GitHub webhook deployment server for the Yimaru admin and backend repositories.
Pushes to the configured production branch trigger the existing build and service deployment workflows on the VPS.

## Application setup

Install dependencies and build the service:

```bash
bun install
bun run test
bun run build
```

Copy `.env.example` to `.env` and set a high-entropy webhook secret. The same secret must be entered in the GitHub organization webhook.

```dotenv
GITHUB_WEBHOOK_SECRET=...
PORT=3000
PRODUCTION_BRANCH=production
YIMARU_ADMIN_PATH=/home/yimaru/yimaru_admin
YIMARU_BACKEND_PATH=/home/yimaru/Yimaru-BackEnd
```

The old `GITEA_WEBHOOK_SECRET`, `GITEA_WEBHOOK_AUTH_HEADER`, `GITEA_USERNAME`, and `GITEA_PASSWORD` variables are no longer used.

Run locally with:

```bash
bun run index.ts
```

## VPS GitHub access

The service pulls from each checkout's `origin` remote. For private repositories, create a different read-only GitHub deploy key for each repository as the `yimaru` service user:

```bash
sudo -u yimaru mkdir -p /home/yimaru/.ssh
sudo -u yimaru ssh-keygen -t ed25519 -N "" -f /home/yimaru/.ssh/github-yimaru-admin -C "yimaru-admin deploy key"
sudo -u yimaru ssh-keygen -t ed25519 -N "" -f /home/yimaru/.ssh/github-yimaru-backend -C "yimaru-backend deploy key"
```

Add each `.pub` key to its matching GitHub repository under **Settings → Deploy keys** without write access. Configure aliases in `/home/yimaru/.ssh/config` so Git can select the correct key:

```sshconfig
Host github-yimaru-admin
    HostName github.com
    User git
    IdentityFile /home/yimaru/.ssh/github-yimaru-admin
    IdentitiesOnly yes

Host github-yimaru-backend
    HostName github.com
    User git
    IdentityFile /home/yimaru/.ssh/github-yimaru-backend
    IdentitiesOnly yes
```

Restrict the SSH files and point each existing checkout to its GitHub repository:

```bash
sudo chmod 700 /home/yimaru/.ssh
sudo chmod 600 /home/yimaru/.ssh/config /home/yimaru/.ssh/github-yimaru-admin /home/yimaru/.ssh/github-yimaru-backend
sudo chown -R yimaru:yimaru /home/yimaru/.ssh

sudo -u yimaru git -C /home/yimaru/yimaru_admin remote set-url origin git@github-yimaru-admin:Yimaru-Language-Learning/YIMARU-LANGUAGE-APP-ADMIN.git
sudo -u yimaru git -C /home/yimaru/Yimaru-BackEnd remote set-url origin git@github-yimaru-backend:Yimaru-Language-Learning/YIMARU-BACKEND.git

sudo -u yimaru git -C /home/yimaru/yimaru_admin fetch origin
sudo -u yimaru git -C /home/yimaru/Yimaru-BackEnd fetch origin
```

If this runner checkout is also migrated, make its GitHub remote the canonical `origin` before updating the service.

## GitHub organization webhook

As an organization owner, create one webhook under **Yimaru-Language-Learning → Settings → Webhooks**:

- Payload URL: `https://cicd.yimaruacademy.com/webhook/github`
- Content type: `application/json`
- Secret: the value of `GITHUB_WEBHOOK_SECRET`
- Events: push events only
- SSL verification: enabled

The organization webhook receives pushes from all organization repositories, but the runner deploys only the configured admin and backend repositories. The previous `/webhook` URL remains available as a legacy-compatible alias. Requests are authenticated with GitHub's `X-Hub-Signature-256`; no additional authorization header is required.

After updating `.env`, rebuild and restart the service:

```bash
bun run build
sudo systemctl restart yimaru-cd
sudo systemctl status yimaru-cd --no-pager -l
```

Confirm `/health`, send a GitHub test delivery, and verify that the webhook returns `202` and creates a successful deployment before disabling the old Gitea webhooks.
