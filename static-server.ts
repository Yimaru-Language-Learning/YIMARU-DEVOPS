import { resolve, sep } from "node:path";

export async function serveStatic(request: Request, directory: string): Promise<Response> {
    if (!["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 405 });
    let pathname: string;
    try { pathname = decodeURIComponent(new URL(request.url).pathname); }
    catch { return new Response(null, { status: 400 }); }
    if (pathname.includes("\0")) return new Response(null, { status: 400 });
    const root = resolve(directory);
    const target = resolve(root, `.${pathname}`);
    if (target !== root && !target.startsWith(root + sep)) return new Response(null, { status: 403 });
    for (const candidate of [target, `${target}.html`, resolve(target, "index.html")]) {
        const file = Bun.file(candidate);
        if (await file.exists() && !(await file.stat()).isDirectory()) {
            return new Response(request.method === "HEAD" ? null : file, {
                headers: { "Content-Type": file.type, "X-Content-Type-Options": "nosniff" },
            });
        }
    }
    const page = Bun.file(resolve(root, "404.html"));
    return new Response(request.method === "HEAD" ? null : await page.exists() ? page : "Not found", { status: 404 });
}
if (import.meta.main) {
    Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT || 18182),
        fetch: request => serveStatic(request, process.env.STATIC_ROOT || "/srv/rezina/current/customer"),
    });
}
