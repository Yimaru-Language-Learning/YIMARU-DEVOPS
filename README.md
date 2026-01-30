# yimaru-cicd

Gitea webhook CD server for:
- Yimaru admin repository (git pull)
- Yimaru backend repository (git pull)

## Setup

Install dependencies:

```bash
bun install
```

Create a `.env` with at least:

```
PORT=3000
PRODUCTION_BRANCH=main
GITEA_WEBHOOK_SECRET=...
GITEA_WEBHOOK_AUTH_HEADER=...
GITEA_USERNAME=...
GITEA_PASSWORD=...

YIMARU_ADMIN_PATH=/srv/apps/yimaru_admin
YIMARU_BACKEND_PATH=/srv/apps/Yimaru-BackEnd
```

Run locally:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.3.2. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
