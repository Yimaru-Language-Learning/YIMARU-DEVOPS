import { Layout } from "../components/Layout";
import type { Deployment, Command } from "../index";

interface DeploymentDetailProps {
    deployment: Deployment;
    commands: Command[];
}

function getStatusBadge(status: string): string {
    const statusClass = status === "success" ? "badge-success" :
        status === "failed" ? "badge-failed" :
            status === "pending" ? "badge-pending" :
                "badge-in_progress";
    return `<span class="badge ${statusClass}">${status}</span>`;
}

function formatDate(dateString: string | undefined): string {
    if (!dateString) return "N/A";
    const date = new Date(dateString);
    return date.toLocaleString();
}

function escapeHtml(text: string | undefined): string {
    if (!text) return "";
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

export function DeploymentDetail({ deployment, commands }: DeploymentDetailProps): string {
    const content = `
        <div class="card">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; flex-wrap: wrap; gap: 12px;">
                <h2 style="margin: 0;">Deployment #${deployment.id}</h2>
                <a href="/" class="btn btn-secondary">← Back to List</a>
            </div>
            
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 15px; margin-bottom: 30px;">
                <div>
                    <strong>Repository:</strong>
                    <p>${escapeHtml(deployment.repository)}</p>
                </div>
                <div>
                    <strong>Branch:</strong>
                    <p>${escapeHtml(deployment.branch) || "N/A"}</p>
                </div>
                <div>
                    <strong>Commit:</strong>
                    <p>
                        ${deployment.commit_hash ?
            `<code style="font-size: 12px;">${escapeHtml(deployment.commit_hash)}</code>` :
            "N/A"}
                    </p>
                </div>
                <div>
                    <strong>Status:</strong>
                    <p>${getStatusBadge(deployment.status)}</p>
                </div>
                <div>
                    <strong>Created At:</strong>
                    <p class="timestamp">${formatDate(deployment.created_at)}</p>
                </div>
            </div>

            <h3 style="margin-bottom: 15px;">Commands (${commands.length})</h3>
            
            ${commands.length === 0 ?
            "<p>No commands executed.</p>" :
            commands.map((command) => `
                    <div class="command">
                        <div class="command-header">
                            <strong>${escapeHtml(command.command)}</strong>
                            <div>
                                ${command.success ?
                    '<span class="badge badge-success">Success</span>' :
                    '<span class="badge badge-failed">Failed</span>'}
                                ${command.exit_code !== null ?
                    `<span style="margin-left: 10px; color: #999; font-size: 12px;">Exit: ${command.exit_code}</span>` :
                    ""}
                            </div>
                        </div>
                        ${command.stdout ? `
                            <div class="command-output">
                                <strong>Output:</strong>
                                <pre>${escapeHtml(command.stdout)}</pre>
                            </div>
                        ` : ""}
                        ${command.stderr ? `
                            <div class="command-error">
                                <strong>Error:</strong>
                                <pre>${escapeHtml(command.stderr)}</pre>
                            </div>
                        ` : ""}
                    </div>
                `).join("")}
        </div>
    `;

    return Layout({ title: `Deployment #${deployment.id}`, children: content });
}

