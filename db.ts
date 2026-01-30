import { Database } from "bun:sqlite";

export interface Deployment {
    id?: number;
    created_at?: string;
    repository: string;
    branch?: string;
    commit_hash?: string;
    status: string;
}

export interface Command {
    id?: number;
    deployment_id: number;
    command: string;
    stdout?: string;
    stderr?: string;
    exit_code?: number;
    success: boolean;
}

let db: Database;

/**
 * Initialize SQLite database with schema
 */
export function initializeDatabase(dbPath?: string): Database {
    db = new Database(dbPath || "deployments.db");

    // Create deployments table
    db.exec(`
        CREATE TABLE IF NOT EXISTS deployments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            repository TEXT NOT NULL,
            branch TEXT,
            commit_hash TEXT,
            status TEXT NOT NULL
        )
    `);

    // Create commands table
    db.exec(`
        CREATE TABLE IF NOT EXISTS commands (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            deployment_id INTEGER,
            command TEXT,
            stdout TEXT,
            stderr TEXT,
            exit_code INTEGER,
            success BOOLEAN,
            FOREIGN KEY(deployment_id) REFERENCES deployments(id)
        )
    `);

    console.log("✅ Database initialized successfully");
    return db;
}

/**
 * Get database instance
 */
export function getDb(): Database {
    if (!db) {
        throw new Error("Database not initialized. Call initializeDatabase first.");
    }
    return db;
}

/**
 * Create a deployment record in the database
 */
export function createDeployment(
    repository: string,
    branch?: string,
    commitHash?: string,
    status: string = "in_progress"
): number {
    const insertDeployment = getDb().prepare(`
        INSERT INTO deployments (repository, branch, commit_hash, status)
        VALUES (?, ?, ?, ?)
    `);
    const result = insertDeployment.run(repository, branch || null, commitHash || null, status);
    return result.lastInsertRowid as number;
}

/**
 * Update deployment status
 */
export function updateDeploymentStatus(deploymentId: number, status: string): void {
    const updateDeployment = getDb().prepare(`
        UPDATE deployments SET status = ? WHERE id = ?
    `);
    updateDeployment.run(status, deploymentId);
}

/**
 * Insert a command record
 */
export function insertCommand(
    deploymentId: number,
    command: string,
    stdout: string,
    stderr: string | null,
    exitCode: number,
    success: boolean
): void {
    const insertCmd = getDb().prepare(`
        INSERT INTO commands (deployment_id, command, stdout, stderr, exit_code, success)
        VALUES (?, ?, ?, ?, ?, ?)
    `);
    insertCmd.run(deploymentId, command, stdout, stderr, exitCode, success ? 1 : 0);
}

/**
 * Get deployments with optional filtering
 */
export function getDeployments(limit: number = 50, repository?: string): Deployment[] {
    let query = "SELECT * FROM deployments";
    const params: any[] = [];

    if (repository) {
        query += " WHERE repository = ?";
        params.push(repository);
    }

    query += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);

    const stmt = getDb().prepare(query);
    return stmt.all(...params) as Deployment[];
}

/**
 * Get deployment by ID
 */
export function getDeploymentById(deploymentId: number): Deployment | undefined {
    const stmt = getDb().prepare("SELECT * FROM deployments WHERE id = ?");
    return stmt.get(deploymentId) as Deployment | undefined;
}

/**
 * Get commands for a deployment
 */
export function getCommandsByDeploymentId(deploymentId: number): Command[] {
    const stmt = getDb().prepare("SELECT * FROM commands WHERE deployment_id = ? ORDER BY id ASC");
    return stmt.all(deploymentId) as Command[];
}
