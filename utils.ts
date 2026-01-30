import { createHmac, timingSafeEqual } from "node:crypto";
import { insertCommand } from "./db";

export interface EnvConfig {
    webhookSecret: string;
    webhookAuthHeader: string;
    giteaUsername: string;
    giteaPassword: string;
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
        "GITEA_WEBHOOK_SECRET",
        "GITEA_WEBHOOK_AUTH_HEADER",
        "GITEA_USERNAME",
        "GITEA_PASSWORD",
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
        webhookSecret: process.env.GITEA_WEBHOOK_SECRET!,
        webhookAuthHeader: process.env.GITEA_WEBHOOK_AUTH_HEADER!,
        giteaUsername: process.env.GITEA_USERNAME!,
        giteaPassword: process.env.GITEA_PASSWORD!,
        yimaruAdminPath: process.env.YIMARU_ADMIN_PATH!,
        yimaruBackendPath: process.env.YIMARU_BACKEND_PATH!,
        port,
        productionBranch,
    };
}

/**
 * Verify Gitea webhook signature
 */
export function verifySignature(payload: string, signature: string, webhookSecret: string): boolean {
    const hmac = createHmac("sha256", webhookSecret);
    hmac.update(payload);
    const expectedHex = hmac.digest("hex");
    const expectedSignature = `sha256=${expectedHex}`;

    // Normalize the signature - Gitea may send with or without "sha256=" prefix
    const normalizedSignature = signature.startsWith("sha256=")
        ? signature
        : `sha256=${signature}`;

    // Ensure both buffers have the same length before comparing
    const signatureBuffer = Buffer.from(normalizedSignature);
    const expectedBuffer = Buffer.from(expectedSignature);

    if (signatureBuffer.length !== expectedBuffer.length) {
        console.error(`Signature length mismatch: received ${signatureBuffer.length}, expected ${expectedBuffer.length}`);
        return false;
    }

    return timingSafeEqual(signatureBuffer, expectedBuffer);
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

/**
 * Build authenticated git URL
 */
export function buildAuthenticatedUrl(
    repoPath: string,
    username: string,
    password: string
): { url: string; redacted: string } {
    const escapedUsername = encodeURIComponent(username);
    const escapedPassword = encodeURIComponent(password);
    const url = `https://${escapedUsername}:${escapedPassword}@${repoPath}`;
    const redacted = `https://***:***@${repoPath}`;
    return { url, redacted };
}

/**
 * Git pull with authentication (for PM2 services with writable .git)
 */
export async function gitPullWithAuth(
    repoPath: string,
    localPath: string,
    deploymentId: number,
    productionBranch: string,
    username: string,
    password: string
): Promise<{ success: boolean; error?: string }> {
    const { url, redacted } = buildAuthenticatedUrl(repoPath, username, password);

    // Stash local changes
    console.log(`Stashing local changes...`);
    await execCommand(`git stash save "local changes ${new Date().toISOString()}"`, localPath, deploymentId);

    // Reset to HEAD
    console.log(`Resetting to HEAD...`);
    const resetResult = await execCommand("git reset --hard HEAD", localPath, deploymentId);
    if (!resetResult.success) {
        return { success: false, error: `Git reset failed: ${resetResult.error || resetResult.output}` };
    }

    // Fetch
    console.log(`Fetching from remote...`);
    const fetchProc = Bun.spawn(
        ["git", "fetch", url, productionBranch],
        { cwd: localPath, stdout: "pipe", stderr: "pipe" }
    );
    const fetchOutput = await new Response(fetchProc.stdout).text();
    const fetchError = await new Response(fetchProc.stderr).text();
    await fetchProc.exited;

    insertCommand(
        deploymentId,
        `git fetch ${redacted} ${productionBranch}`,
        fetchOutput,
        fetchError || null,
        fetchProc.exitCode || 0,
        fetchProc.exitCode === 0
    );

    if (fetchProc.exitCode !== 0) {
        return { success: false, error: `Git fetch failed: ${fetchError || fetchOutput}` };
    }

    // Checkout branch
    await execCommand(`git checkout ${productionBranch}`, localPath, deploymentId);

    // Pull
    console.log(`Pulling latest changes...`);
    const pullProc = Bun.spawn(
        ["git", "pull", url, productionBranch],
        { cwd: localPath, stdout: "pipe", stderr: "pipe" }
    );
    const pullOutput = await new Response(pullProc.stdout).text();
    const pullError = await new Response(pullProc.stderr).text();
    await pullProc.exited;

    insertCommand(
        deploymentId,
        `git pull ${redacted} ${productionBranch}`,
        pullOutput,
        pullError || null,
        pullProc.exitCode || 0,
        pullProc.exitCode === 0
    );

    if (pullProc.exitCode !== 0) {
        return { success: false, error: `Git pull failed: ${pullError || pullOutput}` };
    }

    console.log(`Git pull successful`);
    return { success: true };
}
