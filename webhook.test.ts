import { test, expect } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("HTTP webhook authenticates the raw body, filters branches/repos, and deduplicates deliveries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rezina-webhook-"));
    const socket = Bun.serve({ port: 0, fetch: () => new Response() });
    const port = socket.port!;
    socket.stop(true);
    const secret = "test-webhook-secret";
    const proc = Bun.spawn([process.execPath, "index.ts"], { cwd: import.meta.dir,
        env: { ...process.env, PORT: String(port), GITEA_WEBHOOK_SECRET: secret, PRODUCTION_BRANCH: "main",
            REZINA_ADMIN_PATH: directory, REZINA_BACKEND_PATH: directory, REZINA_CUSTOMER_PATH: directory,
            DB_PATH: join(directory, "deployments.db") }, stdout: "ignore", stderr: "ignore",
    });
    const base = `http://127.0.0.1:${port}`;
    try {
        let ready = false;
        for (let attempt = 0; attempt < 100; attempt++) {
            try { if ((await fetch(base + "/health")).ok) { ready = true; break; } } catch {}
            await Bun.sleep(20);
        }
        expect(ready).toBe(true);
        const payload = { repository: { name: "RezinaLMS-Admin", owner: { login: "RezinaLMS" } },
            ref: "refs/heads/main", after: "a".repeat(40) };
        const send = (body: string, signature?: string, delivery = "test-delivery") => fetch(base + "/webhook/gitea", {
            method: "POST", headers: { "X-Gitea-Event": "push", "X-Gitea-Delivery": delivery,
                "X-Gitea-Signature": signature ?? createHmac("sha256", secret).update(body).digest("hex") }, body,
        });
        expect((await send(JSON.stringify(payload), "0".repeat(64))).status).toBe(401);
        expect((await send("not json")).status).toBe(400);
        expect((await send(JSON.stringify({ ...payload, ref: "refs/heads/feature" }))).status).toBe(200);
        expect((await send(JSON.stringify({ ...payload, repository: { name: "RezinaLMS-Admin", owner: { login: "other" } } }))).status).toBe(200);
        expect((await send(JSON.stringify(payload))).status).toBe(202);
        const duplicate = await send(JSON.stringify(payload));
        expect(duplicate.status).toBe(200);
        expect((await duplicate.json() as { message: string }).message).toBe("Delivery already accepted");
        expect((await (await fetch(base + "/api/deployments")).json() as { deployments: unknown[] }).deployments.length).toBe(1);
    } finally { proc.kill(); await proc.exited; await rm(directory, { recursive: true, force: true }); }
}, 10000);
