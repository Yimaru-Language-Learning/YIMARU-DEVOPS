import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveStatic } from "./static-server";

test("serves Next export routes and the standalone waitlist with proper missing-page behavior", async () => {
    const root = await mkdtemp(join(tmpdir(), "rezina-static-"));
    try {
        await mkdir(join(root, "waitlist"));
        await writeFile(join(root, "index.html"), "home");
        await writeFile(join(root, "about.html"), "about");
        await writeFile(join(root, "waitlist/index.html"), "waitlist");
        await writeFile(join(root, "404.html"), "missing");
        for (const [path, body] of [["/", "home"], ["/about", "about"], ["/waitlist", "waitlist"]]) {
            const response = await serveStatic(new Request(`http://localhost${path}`), root);
            expect(response.status).toBe(200);
            expect(await response.text()).toBe(body!);
        }
        const missing = await serveStatic(new Request("http://localhost/unknown"), root);
        expect(missing.status).toBe(404);
        expect(await missing.text()).toBe("missing");
        expect((await serveStatic(new Request("http://localhost/%2e%2e%2fsecret"), root)).status).toBe(403);
        expect((await serveStatic(new Request("http://localhost/%00"), root)).status).toBe(400);
        expect((await serveStatic(new Request("http://localhost/", { method: "POST" }), root)).status).toBe(405);
        expect(await (await serveStatic(new Request("http://localhost/", { method: "HEAD" }), root)).text()).toBe("");
    } finally { await rm(root, { recursive: true, force: true }); }
});
