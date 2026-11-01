import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    evaluateGiteaWebhook,
    gitSyncFromOrigin,
    repositoryIdentityMatches,
    verifySignature,
} from "./utils";
import {
    createDeployment,
    getCommandsByDeploymentId,
    initializeDatabase,
} from "./db";

describe("verifySignature", () => {
    test("accepts a SHA-256 HMAC in Gitea bare-hex format", () => {
        const signature = "757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
        expect(verifySignature("Hello, World!", signature, "It's a Secret to Everybody")).toBe(true);
    });

    test("rejects missing, malformed, and incorrect signatures", () => {
        expect(verifySignature("payload", "", "secret")).toBe(false);
        expect(verifySignature("payload", "abcdef", "secret")).toBe(false);
        expect(verifySignature("payload", "sha256=abcdef", "secret")).toBe(false);
        const valid = "757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
        expect(verifySignature("modified payload", valid, "It's a Secret to Everybody")).toBe(false);
    });
});

describe("evaluateGiteaWebhook", () => {
    const repository = {
        name: "RezinaLMS-BackEnd",
        owner: { login: "RezinaLMS" },
        full_name: "RezinaLMS/RezinaLMS-BackEnd",
    };

    test("ignores ping and unrelated events without parsing their payload", () => {
        expect(evaluateGiteaWebhook("ping", "not-json", "main").kind).toBe("ignore");
        expect(evaluateGiteaWebhook("issues", "not-json", "main").kind).toBe("ignore");
    });

    test("rejects malformed pushes and pushes without repository information", () => {
        expect(evaluateGiteaWebhook("push", "not-json", "production")).toEqual({
            kind: "invalid",
            error: "Invalid webhook payload: malformed JSON",
        });
        expect(evaluateGiteaWebhook("push", JSON.stringify({ ref: "refs/heads/production" }), "production").kind).toBe("invalid");
    });

    test("ignores non-production pushes and branch deletions", () => {
        expect(evaluateGiteaWebhook("push", JSON.stringify({
            repository,
            ref: "refs/heads/feature",
            after: "feature-sha",
        }), "production").kind).toBe("ignore");

        expect(evaluateGiteaWebhook("push", JSON.stringify({
            repository,
            ref: "refs/heads/production",
            after: "0000000000000000000000000000000000000000",
            deleted: true,
        }), "production").kind).toBe("ignore");
    });

    test("uses the after SHA for a production deployment", () => {
        expect(evaluateGiteaWebhook("push", JSON.stringify({
            repository,
            ref: "refs/heads/production",
            after: "a".repeat(40),
            commits: [{ id: "b".repeat(40) }],
        }), "production")).toEqual({
            kind: "deploy",
            repoName: "RezinaLMS-BackEnd",
            organization: "RezinaLMS",
            branch: "production",
            commitHash: "a".repeat(40),
        });
    });
});

describe("repositoryIdentityMatches", () => {
    test("matches Gitea repository identities case-insensitively", () => {
        expect(repositoryIdentityMatches("RezinaLMS-BackEnd", "RezinaLMS", "rezinalms-backend", "rezinalms")).toBe(true);
        expect(repositoryIdentityMatches("RezinaLMS-BackEnd", "RezinaLMS", "another-repo", "rezinalms")).toBe(false);
    });
});

describe("gitSyncFromOrigin", () => {
    let temporaryDirectory: string | undefined;

    afterEach(async () => {
        if (temporaryDirectory) {
            await rm(temporaryDirectory, { recursive: true, force: true });
            temporaryDirectory = undefined;
        }
    });

    test("synchronizes the checkout from origin without embedding credentials", async () => {
        temporaryDirectory = await mkdtemp(join(tmpdir(), "rezina-cicd-test-"));
        const remotePath = join(temporaryDirectory, "remote.git");
        const publisherPath = join(temporaryDirectory, "publisher");
        const checkoutPath = join(temporaryDirectory, "checkout");

        runGit(["init", "--bare", "--initial-branch=production", remotePath]);
        runGit(["clone", remotePath, publisherPath]);
        runGit(["-C", publisherPath, "config", "user.name", "Test User"]);
        runGit(["-C", publisherPath, "config", "user.email", "test@example.com"]);
        await writeFile(join(publisherPath, "version.txt"), "one\n");
        runGit(["-C", publisherPath, "add", "version.txt"]);
        runGit(["-C", publisherPath, "commit", "-m", "initial"]);
        runGit(["-C", publisherPath, "push", "origin", "production"]);
        runGit(["clone", remotePath, checkoutPath]);

        await writeFile(join(publisherPath, "version.txt"), "two\n");
        runGit(["-C", publisherPath, "commit", "-am", "update"]);
        runGit(["-C", publisherPath, "push", "origin", "production"]);


        initializeDatabase(":memory:");
        const deploymentId = createDeployment("owner/repo", "production", "commit", "in_progress");
        const result = await gitSyncFromOrigin(checkoutPath, deploymentId, "production");

        expect(result.success).toBe(true);
        expect(await readFile(join(checkoutPath, "version.txt"), "utf8")).toBe("two\n");

        const initialSha = new TextDecoder().decode(Bun.spawnSync(["git", "-C", publisherPath, "rev-list", "--max-parents=0", "HEAD"]).stdout).trim();
        const pinned = await gitSyncFromOrigin(checkoutPath, deploymentId, "production", initialSha);
        expect(pinned.success).toBe(true);
        expect(await readFile(join(checkoutPath, "version.txt"), "utf8")).toBe("one\n");
        await writeFile(join(checkoutPath, "version.txt"), "operator edit\n");
        const dirty = await gitSyncFromOrigin(checkoutPath, deploymentId, "production");
        expect(dirty.success).toBe(false);
        expect(await readFile(join(checkoutPath, "version.txt"), "utf8")).toBe("operator edit\n");

        const commands = getCommandsByDeploymentId(deploymentId).map((command) => command.command);
        expect(commands).toContain("git fetch origin production");
        expect(commands).toContain("git checkout --detach origin/production");
        expect(commands.join("\n")).not.toContain("https://");
        expect(commands.join("\n")).not.toContain("@github.com");
    });
});

function runGit(args: string[]): void {
    const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) {
        throw new Error(new TextDecoder().decode(result.stderr));
    }
}
