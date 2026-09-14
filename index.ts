import { Hono } from "hono";
import type { Context } from "hono";
import {
    initializeDatabase,
    createDeployment,
    updateDeploymentStatus,
    getDeployments,
    getDeploymentById,
    getCommandsByDeploymentId,
    insertCommand,
} from "./db";
export type { Deployment, Command } from "./db";
import { readdir } from "node:fs/promises";
import {
    loadEnvConfig,
    verifySignature,
    evaluateGitHubWebhook,
    repositoryIdentityMatches,
    execCommand,
    gitSyncFromOrigin,
    type EnvConfig,
} from "./utils";
import { basename, join } from "node:path";

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

    return { organization, repoName };
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

async function seedBackendSqlFiles(repoPath: string, deploymentId: number): Promise<{ success: boolean; error?: string }> {
    const seedDir = join(repoPath, "db", "data");
    const commandLabel = "seed backend sql files";

    try {
        const fileNames = (await readdir(seedDir))
            .filter((fileName) => fileName.endsWith(".sql"))
            .sort((left, right) => left.localeCompare(right));

        const stdoutLines: string[] = [];
        const stderrLines: string[] = [];

        for (const fileName of fileNames) {
            const filePath = join(seedDir, fileName);

            if (fileName === "007_course_management_seed.sql") {
                stdoutLines.push(`Skipping ${filePath} (course management seed disabled)`);
                continue;
            }

            stdoutLines.push(`Seeding ${filePath}...`);
            const sqlContent = await Bun.file(filePath).text();
            const proc = Bun.spawn(
                ["sudo", "psql", "-U", "root", "-d", "gh"],
                {
                    stdin: Buffer.from(sqlContent),
                    stdout: "pipe",
                    stderr: "pipe",
                }
            );

            const output = await new Response(proc.stdout).text();
            const error = await new Response(proc.stderr).text();
            await proc.exited;

            if (output.trim().length > 0) {
                stdoutLines.push(output.trimEnd());
            }

            if (error.trim().length > 0) {
                stderrLines.push(`${filePath}:\n${error.trimEnd()}`);
            }

            if (proc.exitCode !== 0) {
                insertCommand(
                    deploymentId,
                    commandLabel,
                    stdoutLines.join("\n"),
                    stderrLines.join("\n") || null,
                    proc.exitCode ?? 1,
                    false
                );
                return { success: false, error: `Failed seeding ${fileName}: ${error || output}` };
            }
        }

        insertCommand(
            deploymentId,
            commandLabel,
            stdoutLines.join("\n"),
            stderrLines.join("\n") || null,
            0,
            true
        );
        return { success: true };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        insertCommand(deploymentId, commandLabel, "", errorMessage, -1, false);
        return { success: false, error: errorMessage };
    }
}

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
        const gitResult = await gitSyncFromOrigin(
            repoPath,
            deploymentId,
            env.productionBranch
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
    const goEnv = `export GOPATH=${home}/go GOROOT=/usr/lib/go-1.24 PATH=/usr/bin:${home}/go/bin:$PATH`;

    const deploymentId = existingDeploymentId ?? createDeployment(repository, branch, commitHash, "in_progress");
    if (existingDeploymentId) updateDeploymentStatus(deploymentId, "in_progress");

    console.log(`Starting deployment for Yimaru Backend (Deployment ID: ${deploymentId})...`);

    try {
        // Git pull
        const gitResult = await gitSyncFromOrigin(
            repoPath,
            deploymentId,
            env.productionBranch
        );
        if (!gitResult.success) {
            updateDeploymentStatus(deploymentId, "failed");
            return { success: false, message: gitResult.error!, deploymentId };
        }

        console.log(`Applying docker-compose patch...`);
        const patchResult = await execCommand("git apply docker-compose.patch", repoPath, deploymentId);
        if (!patchResult.success) {
            updateDeploymentStatus(deploymentId, "failed");
            return { success: false, message: `git apply docker-compose.patch failed: ${patchResult.error || patchResult.output}`, deploymentId };
        }

        // Go mod tidy
        console.log(`Tidying Go modules...`);
        const tidyResult = await execCommand(`${goEnv} && go mod tidy`, repoPath, deploymentId);
        if (!tidyResult.success) {
            updateDeploymentStatus(deploymentId, "failed");
            return { success: false, message: `go mod tidy failed: ${tidyResult.error || tidyResult.output}`, deploymentId };
        }

        // Stop service before rebuilding the binary
        console.log(`Stopping Yimaru Backend service...`);
        const stopResult = await execCommand("sudo systemctl stop yimaru_backend.service", undefined, deploymentId);
        if (!stopResult.success) {
            updateDeploymentStatus(deploymentId, "failed");
            return { success: false, message: `Failed to stop service: ${stopResult.error || stopResult.output}`, deploymentId };
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

        console.log(`Seeding database SQL files...`);
        const seedResult = await seedBackendSqlFiles(repoPath, deploymentId);
        if (!seedResult.success) {
            updateDeploymentStatus(deploymentId, "failed");
            // return { success: false, message: `Seed step failed: ${seedResult.error}`, deploymentId };
        }

        // Restart service
        console.log(`Restarting Yimaru Backend service...`);
        const restartResult = await execCommand("sudo systemctl restart yimaru_backend.service", undefined, deploymentId);
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
        (entry) => repositoryIdentityMatches(
            entry.repoName,
            entry.organization,
            repoName,
            organization
        )
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
        const signature = c.req.header("X-Hub-Signature-256") || "";
        const eventName = c.req.header("X-GitHub-Event") || "";
        const payload = await c.req.text();

        if (!verifySignature(payload, signature, env.webhookSecret)) {
            console.error("Invalid webhook signature");
            return c.json({ error: "Invalid signature" }, 401);
        }

        const decision = evaluateGitHubWebhook(eventName, payload, env.productionBranch);
        if (decision.kind === "invalid") {
            return c.json({ error: decision.error }, 400);
        }
        if (decision.kind === "ignore") {
            console.log(`⚠️  ${decision.message}`);
            return c.json({ message: decision.message }, 200);
        }

        const { repoName, organization, branch, commitHash } = decision;
        console.log(`Received GitHub webhook for ${organization}/${repoName} on ${branch} (commit: ${commitHash})`);

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
app.post("/webhook/github", handleWebhook);

// 404 handler
app.notFound((c: Context) => {
    return c.json({ error: "Not found" }, 404);
});

// Start server
const server = Bun.serve({
    port: env.port,
    fetch: app.fetch,
});

console.log(`🚀 GitHub Webhook CD Server running on http://localhost:${server.port}`);
console.log(`📡 GitHub webhook endpoint: http://localhost:${server.port}/webhook/github`);
console.log(`❤️  Health check: http://localhost:${server.port}/health`);
console.log(`📊 Deployments API: http://localhost:${server.port}/deployments`);
console.log(`💾 Database: ${process.env.DB_PATH || "deployments.db"}`);
