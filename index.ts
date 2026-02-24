import { Hono } from "hono";
import type { Context } from "hono";
import {
    initializeDatabase,
    createDeployment,
    updateDeploymentStatus,
    getDeployments,
    getDeploymentById,
    getCommandsByDeploymentId,
    type Deployment,
    type Command,
} from "./db";
import {
    loadEnvConfig,
    verifySignature,
    execCommand,
    gitPullWithAuth,
    type EnvConfig,
} from "./utils";
import { basename } from "node:path";

interface GiteaWebhookPayload {
    repository?: {
        name?: string;
        owner?: {
            login?: string;
        };
        full_name?: string;
    };
    ref?: string;
    commits?: Array<{
        id?: string;
        message?: string;
    }>;
}

// Deploy function signature
type DeployFunction = (
    branch?: string,
    commitHash?: string,
    existingDeploymentId?: number
) => Promise<{ success: boolean; message: string; deploymentId?: number }>;

// Repository configuration - maps repo to its deploy function
interface RepoEntry {
    repoName: string;
    organization: string;
    deploy: DeployFunction;
}

// Load environment configuration at startup
const env: EnvConfig = loadEnvConfig();

// Initialize database
initializeDatabase(process.env.DB_PATH);

// ============================================================================
// Repository Metadata Resolution
// ============================================================================

interface RepoMetadata {
    repoPath: string;
    organization: string;
    repoName: string;
}

function resolveRepoMetadata(localPath: string, label: string): RepoMetadata {
    const proc = Bun.spawnSync(["git", "config", "--get", "remote.origin.url"], {
        cwd: localPath,
        stdout: "pipe",
        stderr: "pipe",
    });
    const decoder = new TextDecoder();
    const remoteUrl = decoder.decode(proc.stdout).trim();

    if (proc.exitCode !== 0 || !remoteUrl) {
        console.error(`❌ Unable to resolve remote.origin.url for ${label} at ${localPath}`);
        console.error(decoder.decode(proc.stderr).trim() || "No git remote configured");
        process.exit(1);
    }

    const repoPath = normalizeRepoPath(remoteUrl);
    const { organization, repoName } = extractOrganizationAndRepo(repoPath, localPath);

    return { repoPath, organization, repoName };
}

function normalizeRepoPath(remoteUrl: string): string {
    if (remoteUrl.startsWith("http://") || remoteUrl.startsWith("https://")) {
        const url = new URL(remoteUrl);
        return `${url.host}${url.pathname}`.replace(/^\/+/, "");
    }

    const sshMatch = remoteUrl.match(/^(?:.+@)?([^:]+):(.+)$/);
    if (sshMatch) {
        return `${sshMatch[1]}/${sshMatch[2]}`.replace(/^\/+/, "");
    }

    return remoteUrl.replace(/^\/+/, "");
}

function extractOrganizationAndRepo(repoPath: string, localPath: string): { organization: string; repoName: string } {
    const cleaned = repoPath.replace(/\.git$/, "");
    const parts = cleaned.split("/").filter(Boolean);
    const organization = parts.at(-2);
    const repoName = parts.at(-1);
    if (organization && repoName) {
        return { organization, repoName };
    }

    return { organization: "", repoName: basename(localPath) };
}

const adminRepo = resolveRepoMetadata(env.yimaruAdminPath, "Yimaru Admin");
const backendRepo = resolveRepoMetadata(env.yimaruBackendPath, "Yimaru Backend");

// ============================================================================
// Deploy Functions for Each Repository
// ============================================================================

async function deployYimaruAdmin(
    branch?: string,
    commitHash?: string,
    existingDeploymentId?: number
): Promise<{ success: boolean; message: string; deploymentId?: number }> {
    const repository = `${adminRepo.organization}/${adminRepo.repoName}`;
    const repoPath = env.yimaruAdminPath;
    const targetPath = "/var/www/html/yimaru_admin";

    const deploymentId = existingDeploymentId ?? createDeployment(repository, branch, commitHash, "in_progress");
    if (existingDeploymentId) updateDeploymentStatus(deploymentId, "in_progress");

    console.log(`Starting deployment for Yimaru Admin (Deployment ID: ${deploymentId})...`);

    try {
        const gitResult = await gitPullWithAuth(
            adminRepo.repoPath,
            repoPath,
            deploymentId,
            env.productionBranch,
            env.giteaUsername,
            env.giteaPassword
        );
        if (!gitResult.success) {
            updateDeploymentStatus(deploymentId, "failed");
            return { success: false, message: gitResult.error!, deploymentId };
        }

        console.log(`Installing dependencies...`);
        const installResult = await execCommand("bun install", repoPath, deploymentId);
        if (!installResult.success) {
            updateDeploymentStatus(deploymentId, "failed");
            return { success: false, message: `bun install failed: ${installResult.error || installResult.output}`, deploymentId };
        }

        console.log(`Building project...`);
        const buildResult = await execCommand("bun run build", repoPath, deploymentId);
        if (!buildResult.success) {
            updateDeploymentStatus(deploymentId, "failed");
            return { success: false, message: `bun run build failed: ${buildResult.error || buildResult.output}`, deploymentId };
        }

        console.log(`Removing existing ${targetPath}...`);
        const deleteResult = await execCommand(`sudo rm -rf "${targetPath}"`, undefined, deploymentId);
        if (!deleteResult.success) {
            updateDeploymentStatus(deploymentId, "failed");
            return { success: false, message: `Failed to delete ${targetPath}: ${deleteResult.error || deleteResult.output}`, deploymentId };
        }

        console.log(`Moving dist to ${targetPath}...`);
        const moveResult = await execCommand(`sudo mv "${repoPath}/dist" "${targetPath}"`, undefined, deploymentId);
        if (!moveResult.success) {
            updateDeploymentStatus(deploymentId, "failed");
            return { success: false, message: `Failed to move dist: ${moveResult.error || moveResult.output}`, deploymentId };
        }

        console.log(`Restarting nginx...`);
        const nginxResult = await execCommand("sudo systemctl restart nginx", undefined, deploymentId);
        if (!nginxResult.success) {
            updateDeploymentStatus(deploymentId, "failed");
            return { success: false, message: `Failed to restart nginx: ${nginxResult.error || nginxResult.output}`, deploymentId };
        }

        console.log(`✅ Deployment successful`);
        updateDeploymentStatus(deploymentId, "success");
        return { success: true, message: "Successfully deployed Yimaru Admin", deploymentId };
    } catch (error) {
        updateDeploymentStatus(deploymentId, "failed");
        return { success: false, message: `Deployment failed: ${error instanceof Error ? error.message : String(error)}`, deploymentId };
    }
}

async function deployYimaruBackend(
    branch?: string,
    commitHash?: string,
    existingDeploymentId?: number
): Promise<{ success: boolean; message: string; deploymentId?: number }> {
    const repository = `${backendRepo.organization}/${backendRepo.repoName}`;
    const repoPath = env.yimaruBackendPath;
    const home = "/home/yimaru";
    const goEnv = `export GOPATH=${home}/go GOROOT=/usr/local/go PATH=/usr/local/go/bin:${home}/go/bin:$PATH`;

    const deploymentId = existingDeploymentId ?? createDeployment(repository, branch, commitHash, "in_progress");
    if (existingDeploymentId) updateDeploymentStatus(deploymentId, "in_progress");

    console.log(`Starting deployment for Yimaru Backend (Deployment ID: ${deploymentId})...`);

    try {
        // Git pull
        const gitResult = await gitPullWithAuth(
            backendRepo.repoPath,
            repoPath,
            deploymentId,
            env.productionBranch,
            env.giteaUsername,
            env.giteaPassword
        );
        if (!gitResult.success) {
            updateDeploymentStatus(deploymentId, "failed");
            return { success: false, message: gitResult.error!, deploymentId };
        }

        // Go mod tidy
        console.log(`Tidying Go modules...`);
        const tidyResult = await execCommand(`${goEnv} && go mod tidy`, repoPath, deploymentId);
        if (!tidyResult.success) {
            updateDeploymentStatus(deploymentId, "failed");
            return { success: false, message: `go mod tidy failed: ${tidyResult.error || tidyResult.output}`, deploymentId };
        }

        // Stop service before DB operations
        console.log(`Stopping Yimaru Backend service...`);
        await execCommand("sudo systemctl stop yimaru-backend.service", undefined, deploymentId);

        // Database backup → migrate → restore → seed
        console.log(`Backing up database...`);
        const backupResult = await execCommand("make backup", repoPath, deploymentId);
        if (!backupResult.success) {
            updateDeploymentStatus(deploymentId, "failed");
            return { success: false, message: `make backup failed: ${backupResult.error || backupResult.output}`, deploymentId };
        }

        console.log(`Running db-down...`);
        const dbDownResult = await execCommand("make db-down", repoPath, deploymentId);
        if (!dbDownResult.success) {
            updateDeploymentStatus(deploymentId, "failed");
            return { success: false, message: `make db-down failed: ${dbDownResult.error || dbDownResult.output}`, deploymentId };
        }

        console.log(`Running db-up...`);
        const dbUpResult = await execCommand("make db-up", repoPath, deploymentId);
        if (!dbUpResult.success) {
            updateDeploymentStatus(deploymentId, "failed");
            return { success: false, message: `make db-up failed: ${dbUpResult.error || dbUpResult.output}`, deploymentId };
        }

        // Wait for DB to be ready before restore
        await execCommand("sleep 5", repoPath, deploymentId);

        console.log(`Restoring database...`);
        const restoreResult = await execCommand("make restore", repoPath, deploymentId);
        if (!restoreResult.success) {
            updateDeploymentStatus(deploymentId, "failed");
            return { success: false, message: `make restore failed: ${restoreResult.error || restoreResult.output}`, deploymentId };
        }

        await execCommand("sleep 2", repoPath, deploymentId);

        console.log(`Seeding data...`);
        const seedResult = await execCommand("make seed_data", repoPath, deploymentId);
        if (!seedResult.success) {
            updateDeploymentStatus(deploymentId, "failed");
            return { success: false, message: `make seed_data failed: ${seedResult.error || seedResult.output}`, deploymentId };
        }

        // Build Go binary
        console.log(`Building Go binary...`);
        const buildResult = await execCommand(
            `${goEnv} && go build -ldflags='-s' -o ./bin/web ./cmd/main.go`,
            repoPath,
            deploymentId
        );
        if (!buildResult.success) {
            updateDeploymentStatus(deploymentId, "failed");
            return { success: false, message: `go build failed: ${buildResult.error || buildResult.output}`, deploymentId };
        }

        // Restart service
        console.log(`Restarting Yimaru Backend service...`);
        const restartResult = await execCommand("sudo systemctl restart yimaru-backend.service", undefined, deploymentId);
        if (!restartResult.success) {
            updateDeploymentStatus(deploymentId, "failed");
            return { success: false, message: `Failed to restart service: ${restartResult.error || restartResult.output}`, deploymentId };
        }

        console.log(`✅ Deployment successful`);
        updateDeploymentStatus(deploymentId, "success");
        return { success: true, message: "Successfully deployed Yimaru Backend", deploymentId };
    } catch (error) {
        updateDeploymentStatus(deploymentId, "failed");
        return { success: false, message: `Deployment failed: ${error instanceof Error ? error.message : String(error)}`, deploymentId };
    }
}

// ============================================================================
// Repository Configuration
// ============================================================================

const REPO_CONFIGS: RepoEntry[] = [
    {
        repoName: adminRepo.repoName,
        organization: adminRepo.organization,
        deploy: deployYimaruAdmin,
    },
    {
        repoName: backendRepo.repoName,
        organization: backendRepo.organization,
        deploy: deployYimaruBackend,
    },
];

/**
 * Find repository entry by name
 */
function findRepoEntry(repoName: string, organization: string): RepoEntry | undefined {
    return REPO_CONFIGS.find(
        (entry) =>
            entry.repoName === repoName &&
            (entry.organization.length === 0 || entry.organization === organization)
    );
}

// ============================================================================
// HTTP Handlers
// ============================================================================

/**
 * Handle webhook request
 */
async function handleWebhook(c: Context): Promise<Response> {
    try {
        // Get signature and auth header from headers
        const signature = c.req.header("X-Gitea-Signature") || "";
        const authHeader = c.req.header("Authorization") || c.req.header("X-Gitea-Auth") || "";
        const payload = await c.req.text();

        // Verify auth header
        if (authHeader !== env.webhookAuthHeader) {
            console.error("Invalid webhook auth header");
            return c.json({ error: "Invalid authorization" }, 401);
        }

        // Verify signature
        if (!verifySignature(payload, signature, env.webhookSecret)) {
            console.error("Invalid webhook signature");
            return c.json({ error: "Invalid signature" }, 401);
        }

        // Parse payload
        const data: GiteaWebhookPayload = JSON.parse(payload);

        // Extract repository information
        const repoName = data.repository?.name;
        const organization = data.repository?.owner?.login || data.repository?.full_name?.split("/")[0];
        const ref = data.ref || "";
        const commitHash = data.commits?.[0]?.id || "";

        if (!repoName || !organization) {
            return c.json({ error: "Invalid webhook payload: missing repository information" }, 400);
        }

        // Extract branch name from ref (e.g., "refs/heads/main" -> "main")
        const branch = ref.replace("refs/heads/", "") || undefined;

        // Only process pushes to the production branch
        if (ref !== `refs/heads/${env.productionBranch}`) {
            console.log(`⚠️  Ignoring push to non-production branch: ${ref}`);
            return c.json({
                message: `Ignoring push to ${ref}. Only the production branch (${env.productionBranch}) triggers deployments.`,
            }, 200);
        }

        console.log(`Received webhook for ${organization}/${repoName} on ${ref} (commit: ${commitHash})`);

        // Find repository entry
        const entry = findRepoEntry(repoName, organization);

        if (!entry) {
            console.warn(`No configuration found for ${organization}/${repoName}`);
            return c.json({ message: `Repository ${organization}/${repoName} not configured` }, 200);
        }

        // Create deployment record immediately
        const deploymentId = createDeployment(
            `${entry.organization}/${entry.repoName}`,
            branch,
            commitHash,
            "pending"
        );

        // Run deployment in background (don't await)
        entry.deploy(branch, commitHash, deploymentId)
            .then((result) => {
                if (result.success) {
                    console.log(`✅ Deployment ${deploymentId} completed: ${result.message}`);
                } else {
                    console.error(`❌ Deployment ${deploymentId} failed: ${result.message}`);
                }
            })
            .catch((error) => {
                console.error(`❌ Deployment ${deploymentId} error:`, error);
                updateDeploymentStatus(deploymentId, "failed");
            });

        // Immediately respond to webhook
        return c.json({
            message: "Deployment started",
            deploymentId,
            repository: `${entry.organization}/${entry.repoName}`,
            branch,
        }, 202);
    } catch (error) {
        console.error("Error processing webhook:", error);
        return c.json({
            error: "Internal server error",
            message: error instanceof Error ? error.message : String(error),
        }, 500);
    }
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
    port: env.port,
    fetch: app.fetch,
});

console.log(`🚀 Gitea Webhook CD Server running on http://localhost:${server.port}`);
console.log(`📡 Webhook endpoint: http://localhost:${server.port}/webhook`);
console.log(`❤️  Health check: http://localhost:${server.port}/health`);
console.log(`📊 Deployments API: http://localhost:${server.port}/deployments`);
console.log(`💾 Database: ${process.env.DB_PATH || "deployments.db"}`);
