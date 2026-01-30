import { Layout } from "../components/Layout";
import type { Deployment } from "../index";

interface DeploymentsListProps {
    deployments: Deployment[];
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

export function DeploymentsList({ deployments }: DeploymentsListProps): string {
    const content = `
        <div class="card">
            <h2>Deployment History</h2>
            ${deployments.length === 0 ?
            "<p>No deployments yet.</p>" :
            `<table>
                    <thead>
                        <tr>
                            <th>ID</th>
                            <th>Repository</th>
                            <th>Branch</th>
                            <th>Commit</th>
                            <th>Status</th>
                            <th>Created At</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${deployments.map((deployment) => `
                            <tr>
                                <td>${deployment.id}</td>
                                <td>${escapeHtml(deployment.repository)}</td>
                                <td>${escapeHtml(deployment.branch) || "N/A"}</td>
                                <td>
                                    ${deployment.commit_hash ?
                    `<code style="font-size: 11px;">${escapeHtml(deployment.commit_hash.substring(0, 7))}</code>` :
                    "N/A"}
                                </td>
                                <td>${getStatusBadge(deployment.status)}</td>
                                <td>
                                    <span class="timestamp">${formatDate(deployment.created_at)}</span>
                                </td>
                                <td>
                                    <a href="/deployments/${deployment.id}" class="btn btn-primary" style="font-size: 12px; padding: 6px 12px;">View</a>
                                </td>
                            </tr>
                        `).join("")}
                    </tbody>
                </table>`}
        </div>
    `;

    return Layout({ title: "Deployments", children: content });
}

