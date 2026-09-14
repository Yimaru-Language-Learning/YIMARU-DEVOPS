import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    evaluateGitHubWebhook,
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
    test("accepts GitHub's published SHA-256 test vector", () => {
        const signature = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
        expect(verifySignature("Hello, World!", signature, "It's a Secret to Everybody")).toBe(true);
    });

    test("rejects missing, malformed, and incorrect signatures", () => {
        expect(verifySignature("payload", "", "secret")).toBe(false);
        expect(verifySignature("payload", "abcdef", "secret")).toBe(false);
        expect(verifySignature("payload", "sha256=abcdef", "secret")).toBe(false);
    });
});

describe("evaluateGitHubWebhook", () => {
    const repository = {
        name: "Yimaru-BackEnd",
        owner: { login: "Yimaru-Language-Learning" },
        full_name: "Yimaru-Language-Learning/Yimaru-BackEnd",
    };

    test("ignores ping and unrelated events without parsing their payload", () => {
        expect(evaluateGitHubWebhook("ping", "not-json", "main").kind).toBe("ignore");
        expect(evaluateGitHubWebhook("issues", "not-json", "main").kind).toBe("ignore");
    });

    test("rejects malformed pushes and pushes without repository information", () => {
        expect(evaluateGitHubWebhook("push", "not-json", "main")).toEqual({
            kind: "invalid",
            error: "Invalid webhook payload: malformed JSON",
        });
        expect(evaluateGitHubWebhook("push", JSON.stringify({ ref: "refs/heads/main" }), "main").kind).toBe("invalid");
    });

    test("ignores non-production pushes and branch deletions", () => {
        expect(evaluateGitHubWebhook("push", JSON.stringify({
            repository,
            ref: "refs/heads/feature",
            after: "feature-sha",
        }), "main").kind).toBe("ignore");

        expect(evaluateGitHubWebhook("push", JSON.stringify({
            repository,
            ref: "refs/heads/main",
            after: "0000000000000000000000000000000000000000",
            deleted: true,
        }), "main").kind).toBe("ignore");
    });

    test("uses the after SHA for a production deployment", () => {
        expect(evaluateGitHubWebhook("push", JSON.stringify({
            repository,
            ref: "refs/heads/main",
            after: "newest-commit",
            commits: [{ id: "oldest-commit" }],
        }), "main")).toEqual({
            kind: "deploy",
            repoName: "Yimaru-BackEnd",
            organization: "Yimaru-Language-Learning",
            branch: "main",
            commitHash: "newest-commit",
        });
    });
});

describe("repositoryIdentityMatches", () => {
    test("matches GitHub repository identities case-insensitively", () => {
        expect(repositoryIdentityMatches("Yimaru-BackEnd", "Yimaru-Language-Learning", "yimaru-backend", "yimaru-language-learning")).toBe(true);
        expect(repositoryIdentityMatches("Yimaru-BackEnd", "Yimaru-Language-Learning", "another-repo", "yimaru-language-learning")).toBe(false);
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
        temporaryDirectory = await mkdtemp(join(tmpdir(), "yimaru-cicd-test-"));
        const remotePath = join(temporaryDirectory, "remote.git");
        const publisherPath = join(temporaryDirectory, "publisher");
        const checkoutPath = join(temporaryDirectory, "checkout");

        runGit(["init", "--bare", "--initial-branch=main", remotePath]);
        runGit(["clone", remotePath, publisherPath]);
        runGit(["-C", publisherPath, "config", "user.name", "Test User"]);
        runGit(["-C", publisherPath, "config", "user.email", "test@example.com"]);
        await writeFile(join(publisherPath, "version.txt"), "one\n");
        runGit(["-C", publisherPath, "add", "version.txt"]);
        runGit(["-C", publisherPath, "commit", "-m", "initial"]);
        runGit(["-C", publisherPath, "push", "origin", "main"]);
        runGit(["clone", remotePath, checkoutPath]);

        await writeFile(join(publisherPath, "version.txt"), "two\n");
        runGit(["-C", publisherPath, "commit", "-am", "update"]);
        runGit(["-C", publisherPath, "push", "origin", "main"]);
        await writeFile(join(checkoutPath, "version.txt"), "local change\n");

        initializeDatabase(":memory:");
        const deploymentId = createDeployment("owner/repo", "main", "commit", "in_progress");
        const result = await gitSyncFromOrigin(checkoutPath, deploymentId, "main");

        expect(result.success).toBe(true);
        expect(await readFile(join(checkoutPath, "version.txt"), "utf8")).toBe("two\n");

        const commands = getCommandsByDeploymentId(deploymentId).map((command) => command.command);
        expect(commands).toContain("git fetch origin");
        expect(commands).toContain("git reset --hard origin/main");
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
