import { createHmac, timingSafeEqual } from "node:crypto";
import { insertCommand } from "./db";

export interface EnvConfig {
    webhookSecret: string;
    adminPath: string;
    backendPath: string;
    customerPath: string;
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
        "GITEA_WEBHOOK_SECRET",
        "REZINA_ADMIN_PATH",
        "REZINA_BACKEND_PATH",
        "REZINA_CUSTOMER_PATH",
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
        webhookSecret: process.env.GITEA_WEBHOOK_SECRET!,
        adminPath: process.env.REZINA_ADMIN_PATH!,
        backendPath: process.env.REZINA_BACKEND_PATH!,
        customerPath: process.env.REZINA_CUSTOMER_PATH!,
        port,
        productionBranch,
    };
}

/**
 * Verify a Gitea X-Gitea-Signature webhook signature.
 */
export function verifySignature(payload: string, signature: string, webhookSecret: string): boolean {
    if (!/^[a-f0-9]{64}$/.test(signature)) {
        return false;
    }

    const hmac = createHmac("sha256", webhookSecret);
    hmac.update(payload);
    const expectedHex = hmac.digest("hex");
    const expectedSignature = expectedHex;

    // Ensure both buffers have the same length before comparing
    const signatureBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSignature);

    if (signatureBuffer.length !== expectedBuffer.length) {
        console.error(`Signature length mismatch: received ${signatureBuffer.length}, expected ${expectedBuffer.length}`);
        return false;
    }

    return timingSafeEqual(signatureBuffer, expectedBuffer);
}

interface GiteaWebhookPayload {
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

export type GiteaWebhookDecision =
    | { kind: "deploy"; repoName: string; organization: string; branch: string; commitHash: string }
    | { kind: "ignore"; message: string }
    | { kind: "invalid"; error: string };

/**
 * Parse the Gitea event and reduce it to the information needed by the deployer.
 */
export function evaluateGiteaWebhook(
    eventName: string,
    payload: string,
    productionBranch: string
): GiteaWebhookDecision {
    if (eventName !== "push") {
        return { kind: "ignore", message: `Ignoring Gitea event: ${eventName || "unknown"}` };
    }

    let data: GiteaWebhookPayload;
    try {
        data = JSON.parse(payload) as GiteaWebhookPayload;
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

    if (data.deleted || data.after === "0".repeat(40)) {
        return { kind: "ignore", message: `Ignoring deletion of ${data.ref || "an unknown ref"}` };
    }

    const expectedRef = `refs/heads/${productionBranch}`;
    if (data.ref !== expectedRef) {
        return {
            kind: "ignore",
            message: `Ignoring push to ${data.ref || "an unknown ref"}. Only the production branch (${productionBranch}) triggers deployments.`,
        };
    }

    if (!data.after || !/^[a-f0-9]{40}$/.test(data.after)) {
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
    return configuredOrganization.length > 0 && configuredRepoName.toLowerCase() === receivedRepoName.toLowerCase()
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

        const [output, error] = await Promise.all([
            new Response(proc.stdout).text(), new Response(proc.stderr).text(),
        ]);

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
        const [output, error] = await Promise.all([
            new Response(proc.stdout).text(), new Response(proc.stderr).text(),
        ]);
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
    productionBranch: string,
    commitHash?: string
): Promise<{ success: boolean; error?: string }> {
    // Dedicated deployment checkouts must be clean; never stash an operator's edits.
    const status = await execGitCommand(["status", "--porcelain", "--untracked-files=no"], localPath, deploymentId);
    if (!status.success || status.output.trim()) {
        return { success: false, error: "Deployment checkout has local changes; resolve them before deploying" };
    }
    const fetch = await execGitCommand(["fetch", "origin", productionBranch], localPath, deploymentId);
    if (!fetch.success) return { success: false, error: fetch.error };
    const target = commitHash || `origin/${productionBranch}`;
    if (commitHash && !/^[a-f0-9]{40}$/.test(commitHash)) {
        return { success: false, error: "Invalid commit SHA" };
    }
    const ancestor = await execGitCommand(["merge-base", "--is-ancestor", target, `origin/${productionBranch}`], localPath, deploymentId);
    if (!ancestor.success) return { success: false, error: "Commit does not belong to the deployment branch" };
    const sync = await execGitCommand(["checkout", "--detach", target], localPath, deploymentId);
    return { success: sync.success, error: sync.error };
}
