import { createHmac, timingSafeEqual } from "node:crypto";
import { insertCommand } from "./db";

export interface EnvConfig {
    webhookSecret: string;
    yimaruAdminPath: string;
    yimaruBackendPath: string;
    port: number;
    dbPath?: string;
    productionBranch: string;
}

/**
 * Load and validate environment variables
 * Exits the process if any required variable is missing
 */
export function loadEnvConfig(): EnvConfig {
    const requiredVars = [
        "GITHUB_WEBHOOK_SECRET",
        "YIMARU_ADMIN_PATH",
        "YIMARU_BACKEND_PATH",
    ];

    const missing: string[] = [];

    for (const varName of requiredVars) {
        if (!process.env[varName]) {
            missing.push(varName);
        }
    }

    if (missing.length > 0) {
        console.error("❌ Missing required environment variables:");
        missing.forEach((varName) => console.error(`   - ${varName}`));
        console.error("\nPlease set all required environment variables in your .env file.");
        process.exit(1);
    }

    const port = parseInt(process.env.PORT || "", 10);
    if (isNaN(port) || port < 1 || port > 65535) {
        console.error(`❌ Invalid PORT value: ${process.env.PORT}`);
        process.exit(1);
    }

    // Parse production branch from environment variable
    const productionBranchRaw = process.env.PRODUCTION_BRANCH;
    const productionBranch = typeof productionBranchRaw === "string" ? productionBranchRaw.trim() : "";

    if (!productionBranch || productionBranch.length === 0) {
        console.error("❌ PRODUCTION_BRANCH must contain a valid branch name");
        process.exit(1);
    }

    console.log(`✅ Production branch configured: ${productionBranch}`);

    return {
        webhookSecret: process.env.GITHUB_WEBHOOK_SECRET!,
        yimaruAdminPath: process.env.YIMARU_ADMIN_PATH!,
        yimaruBackendPath: process.env.YIMARU_BACKEND_PATH!,
        port,
        productionBranch,
    };
}

/**
 * Verify a GitHub X-Hub-Signature-256 webhook signature.
 */
export function verifySignature(payload: string, signature: string, webhookSecret: string): boolean {
    if (!signature.startsWith("sha256=")) {
        return false;
    }

    const hmac = createHmac("sha256", webhookSecret);
    hmac.update(payload);
    const expectedHex = hmac.digest("hex");
    const expectedSignature = `sha256=${expectedHex}`;

    // Ensure both buffers have the same length before comparing
    const signatureBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSignature);

    if (signatureBuffer.length !== expectedBuffer.length) {
        console.error(`Signature length mismatch: received ${signatureBuffer.length}, expected ${expectedBuffer.length}`);
        return false;
    }

    return timingSafeEqual(signatureBuffer, expectedBuffer);
}

interface GitHubWebhookPayload {
    repository?: {
        name?: string;
        owner?: {
            login?: string;
        };
        full_name?: string;
    };
    ref?: string;
    after?: string;
    deleted?: boolean;
}

export type GitHubWebhookDecision =
    | { kind: "deploy"; repoName: string; organization: string; branch: string; commitHash: string }
    | { kind: "ignore"; message: string }
    | { kind: "invalid"; error: string };

/**
 * Parse the GitHub event and reduce it to the information needed by the deployer.
 */
export function evaluateGitHubWebhook(
    eventName: string,
    payload: string,
    productionBranch: string
): GitHubWebhookDecision {
    if (eventName !== "push") {
        return { kind: "ignore", message: `Ignoring GitHub event: ${eventName || "unknown"}` };
    }

    let data: GitHubWebhookPayload;
    try {
        data = JSON.parse(payload) as GitHubWebhookPayload;
    } catch {
        return { kind: "invalid", error: "Invalid webhook payload: malformed JSON" };
    }

    if (!data || typeof data !== "object") {
        return { kind: "invalid", error: "Invalid webhook payload: expected a JSON object" };
    }

    const repoName = data.repository?.name;
    const organization = data.repository?.owner?.login || data.repository?.full_name?.split("/")[0];
    if (!repoName || !organization) {
        return { kind: "invalid", error: "Invalid webhook payload: missing repository information" };
    }

    if (data.deleted) {
        return { kind: "ignore", message: `Ignoring deletion of ${data.ref || "an unknown ref"}` };
    }

    const expectedRef = `refs/heads/${productionBranch}`;
    if (data.ref !== expectedRef) {
        return {
            kind: "ignore",
            message: `Ignoring push to ${data.ref || "an unknown ref"}. Only the production branch (${productionBranch}) triggers deployments.`,
        };
    }

    if (!data.after) {
        return { kind: "invalid", error: "Invalid webhook payload: missing after commit SHA" };
    }

    return {
        kind: "deploy",
        repoName,
        organization,
        branch: productionBranch,
        commitHash: data.after,
    };
}

export function repositoryIdentityMatches(
    configuredRepoName: string,
    configuredOrganization: string,
    receivedRepoName: string,
    receivedOrganization: string
): boolean {
    return configuredRepoName.toLowerCase() === receivedRepoName.toLowerCase()
        && (configuredOrganization.length === 0
            || configuredOrganization.toLowerCase() === receivedOrganization.toLowerCase());
}

/**
 * Execute shell command and return result
 */
export async function execCommand(
    command: string,
    cwd?: string,
    deploymentId?: number
): Promise<{ success: boolean; output: string; error?: string; exitCode?: number }> {
    try {
        // Build PATH that includes node_modules/.bin for local binaries (like tsc)
        const currentPath = process.env.PATH || "/usr/local/bin:/usr/bin:/bin";
        const nodeModulesBin = cwd ? `${cwd}/node_modules/.bin` : "";
        const enhancedPath = nodeModulesBin ? `${nodeModulesBin}:${currentPath}` : currentPath;

        // Use shell to properly handle quoted arguments and special characters
        const proc = Bun.spawn(["/bin/sh", "-c", command], {
            cwd,
            stdout: "pipe",
            stderr: "pipe",
            env: {
                ...process.env,
                PATH: enhancedPath,
            },
        });

        const output = await new Response(proc.stdout).text();
        const error = await new Response(proc.stderr).text();

        await proc.exited;

        const exitCode = proc.exitCode || 0;
        const success = exitCode === 0;

        // Store command in database if deploymentId is provided
        if (deploymentId !== undefined) {
            insertCommand(deploymentId, command, output, error || null, exitCode, success);
        }

        if (!success) {
            return {
                success: false,
                output,
                error: error || `Command failed with exit code ${exitCode}`,
                exitCode,
            };
        }

        return {
            success: true,
            output,
            exitCode,
        };
    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);

        // Store command in database even on exception
        if (deploymentId !== undefined) {
            insertCommand(deploymentId, command, "", errorMessage, -1, false);
        }

        return {
            success: false,
            output: "",
            error: errorMessage,
            exitCode: -1,
        };
    }
}

async function execGitCommand(
    args: string[],
    localPath: string,
    deploymentId: number,
): Promise<{ success: boolean; output: string; error?: string }> {
    const command = `git ${args.join(" ")}`;
    try {
        const proc = Bun.spawn(["git", ...args], {
            cwd: localPath,
            stdout: "pipe",
            stderr: "pipe",
        });
        const output = await new Response(proc.stdout).text();
        const error = await new Response(proc.stderr).text();
        await proc.exited;

        const exitCode = proc.exitCode ?? -1;
        const success = exitCode === 0;
        insertCommand(deploymentId, command, output, error || null, exitCode, success);

        return {
            success,
            output,
            error: success ? undefined : error || `Command failed with exit code ${exitCode}`,
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        insertCommand(deploymentId, command, "", errorMessage, -1, false);
        return { success: false, output: "", error: errorMessage };
    }
}

/**
 * Synchronize a checkout to the configured production branch on origin.
 * Authentication is supplied by the checkout's SSH remote/configuration.
 */
export async function gitSyncFromOrigin(
    localPath: string,
    deploymentId: number,
    productionBranch: string
): Promise<{ success: boolean; error?: string }> {
    // Stash local changes
    console.log(`Stashing local changes...`);
    const stashResult = await execGitCommand(
        ["stash", "push", "-m", `local changes ${new Date().toISOString()}`],
        localPath,
        deploymentId
    );
    if (!stashResult.success) {
        return { success: false, error: `Git stash failed: ${stashResult.error || stashResult.output}` };
    }

    // Reset to HEAD
    console.log(`Resetting to HEAD...`);
    const resetResult = await execGitCommand(["reset", "--hard", "HEAD"], localPath, deploymentId);
    if (!resetResult.success) {
        return { success: false, error: `Git reset failed: ${resetResult.error || resetResult.output}` };
    }

    // Fetch
    console.log(`Fetching from origin...`);
    const fetchResult = await execGitCommand(["fetch", "origin"], localPath, deploymentId);
    if (!fetchResult.success) {
        return { success: false, error: `Git fetch failed: ${fetchResult.error || fetchResult.output}` };
    }

    // Checkout branch
    const checkoutResult = await execGitCommand(["checkout", productionBranch], localPath, deploymentId);
    if (!checkoutResult.success) {
        return { success: false, error: `Git checkout failed: ${checkoutResult.error || checkoutResult.output}` };
    }

    // Match the deployed checkout exactly to the remote production branch.
    console.log(`Synchronizing to origin/${productionBranch}...`);
    const syncResult = await execGitCommand(
        ["reset", "--hard", `origin/${productionBranch}`],
        localPath,
        deploymentId
    );
    if (!syncResult.success) {
        return { success: false, error: `Git synchronization failed: ${syncResult.error || syncResult.output}` };
    }

    console.log(`Git synchronization successful`);
    return { success: true };
}
