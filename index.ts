import { Hono, type Context } from "hono";
import { initializeDatabase, createDeployment, updateDeploymentStatus, getDeployments,
    getDeploymentById, getCommandsByDeploymentId, getDb, insertCommand } from "./db";
export type { Deployment, Command } from "./db";
import { loadEnvConfig, verifySignature, evaluateGiteaWebhook, repositoryIdentityMatches,
    gitSyncFromOrigin } from "./utils";
import { join } from "node:path";

const env = loadEnvConfig();
initializeDatabase(process.env.DB_PATH);
getDb().exec("CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, deployment_id INTEGER NOT NULL)");
// A process restart interrupts pending builds; do not present them as still running.
getDb().exec("UPDATE deployments SET status = 'interrupted' WHERE status IN ('pending', 'in_progress')");
const REPO_CONFIGS = [
    { app: "admin", repoName: "RezinaLMS-Admin", organization: "RezinaLMS", path: env.adminPath },
    { app: "backend", repoName: "RezinaLMS-BackEnd", organization: "RezinaLMS", path: env.backendPath },
    { app: "customer", repoName: "RezinaLMS-CustomerEnd", organization: "RezinaLMS", path: env.customerPath },
];
// Serialize builds to bound resource use and prevent overlapping publication.
let queue: Promise<unknown> = Promise.resolve();
async function deploy(entry: typeof REPO_CONFIGS[number], sha: string, id: number) {
    updateDeploymentStatus(id, "in_progress");
    try {
        const sync = await gitSyncFromOrigin(entry.path, id, env.productionBranch, sha);
        if (!sync.success) throw new Error(sync.error);
        const command = ["bash", join(process.cwd(), "deploy/deploy-app.sh"), entry.app, entry.path];
        const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
        const [out, err, code] = await Promise.all([
            new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
        ]);
        insertCommand(id, `deploy ${entry.app} ${sha}`, out, err || null, code, code === 0);
        if (code !== 0) throw new Error(`Deployment failed with exit code ${code}`);
        updateDeploymentStatus(id, "success");
    } catch (error) {
        insertCommand(id, "deployment error", "", String(error), 1, false);
        updateDeploymentStatus(id, "failed");
        console.error(`Deployment ${id}:`, error);
    }
}
async function handleWebhook(c: Context): Promise<Response> {
    const payload = await c.req.text();
    if (!verifySignature(payload, c.req.header("X-Gitea-Signature") || "", env.webhookSecret)) {
        return c.json({ error: "Invalid signature" }, 401);
    }
    const decision = evaluateGiteaWebhook(c.req.header("X-Gitea-Event") || "", payload, env.productionBranch);
    if (decision.kind === "invalid") return c.json({ error: decision.error }, 400);
    if (decision.kind === "ignore") return c.json({ message: decision.message });
    const entry = REPO_CONFIGS.find(e => repositoryIdentityMatches(e.repoName, e.organization, decision.repoName, decision.organization));
    if (!entry) return c.json({ message: "Repository not configured" });
    const delivery = c.req.header("X-Gitea-Delivery");
    if (!delivery) return c.json({ error: "Missing delivery ID" }, 400);
    const previous = getDb().query("SELECT deployment_id FROM deliveries WHERE id = ?").get(delivery);
    if (previous) return c.json({ message: "Delivery already accepted", ...previous });
    const id = createDeployment(`${entry.organization}/${entry.repoName}`, decision.branch, decision.commitHash, "pending");
    getDb().query("INSERT INTO deliveries (id, deployment_id) VALUES (?, ?)").run(delivery, id);
    queue = queue.then(() => deploy(entry, decision.commitHash, id));
    return c.json({ message: "Deployment queued", deploymentId: id }, 202);
}

function handleHealthCheck(c: Context): Response {
    return c.json({
        status: "ok",
        timestamp: new Date().toISOString(),
        repositories: REPO_CONFIGS.map((entry) => ({
            repo: `${entry.organization}/${entry.repoName}`,
        })),
    });
}

function handleGetDeployments(c: Context): Response {
    const limit = parseInt(c.req.query("limit") || "50", 10);
    const repository = c.req.query("repository");
    const deployments = getDeployments(limit, repository);
    return c.json({ deployments });
}

function handleGetDeployment(c: Context): Response {
    const deploymentId = parseInt(c.req.param("id"), 10);

    if (isNaN(deploymentId)) {
        return c.json({ error: "Invalid deployment ID" }, 400);
    }

    const deployment = getDeploymentById(deploymentId);
    if (!deployment) {
        return c.json({ error: "Deployment not found" }, 404);
    }

    const commands = getCommandsByDeploymentId(deploymentId);
    return c.json({ deployment, commands });
}

// ============================================================================
// Hono App Setup
// ============================================================================

const app = new Hono();

// HTML Pages
app.get("/", async (c: Context) => {
    const limit = parseInt(c.req.query("limit") || "50", 10);
    const repository = c.req.query("repository");
    const deployments = getDeployments(limit, repository);

    const { DeploymentsList } = await import("./pages/DeploymentsList");
    const html = DeploymentsList({ deployments });
    return c.html(html);
});

app.get("/deployments/:id", async (c: Context) => {
    const deploymentId = parseInt(c.req.param("id"), 10);

    if (isNaN(deploymentId)) {
        return c.html("<html><body><h1>Invalid deployment ID</h1></body></html>", 400);
    }

    const deployment = getDeploymentById(deploymentId);
    if (!deployment) {
        return c.html("<html><body><h1>Deployment not found</h1></body></html>", 404);
    }

    const commands = getCommandsByDeploymentId(deploymentId);

    const { DeploymentDetail } = await import("./pages/DeploymentDetail");
    const html = DeploymentDetail({ deployment, commands });
    return c.html(html);
});

// Health check endpoint
app.get("/health", handleHealthCheck);

// API endpoints (JSON)
app.get("/api/deployments", handleGetDeployments);
app.get("/api/deployments/:id", handleGetDeployment);

// Webhook endpoints
app.post("/webhook", handleWebhook);
app.post("/webhook/gitea", handleWebhook);

// 404 handler
app.notFound((c: Context) => {
    return c.json({ error: "Not found" }, 404);
});

// Start server
const server = Bun.serve({
    hostname: "127.0.0.1",
    port: env.port,
    maxRequestBodySize: 2 * 1024 * 1024,
    fetch: app.fetch,
});

console.log(`🚀 Gitea Webhook CD Server running on http://localhost:${server.port}`);
console.log(`📡 Gitea webhook endpoint: http://localhost:${server.port}/webhook/gitea`);
console.log(`❤️  Health check: http://localhost:${server.port}/health`);
console.log(`📊 Deployments API: http://localhost:${server.port}/deployments`);
console.log(`💾 Database: ${process.env.DB_PATH || "deployments.db"}`);
