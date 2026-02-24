interface LayoutProps {
    title: string;
    children: string;
}

const styles = `
    :root {
        --primary-green: #9e2891;
        --primary-green-dark: #7a1f6f;
        --secondary-orange: #FFB668;
        --secondary-orange-dark: #e9a050;
        --error-red: #EF4444;
        --error-red-light: #FEE2E2;
        --text-dark: #1a1a1a;
        --text-muted: #6b7280;
        --bg-white: #ffffff;
        --bg-light: #f9fafb;
        --border-light: #e5e7eb;
    }
    * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
    }
    body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
        background: var(--bg-light);
        color: var(--text-dark);
        line-height: 1.6;
    }
    .container {
        max-width: 1200px;
        margin: 0 auto;
        padding: 20px;
    }
    header {
        background: var(--primary-green);
        color: white;
        padding: 20px 0;
        margin-bottom: 30px;
        box-shadow: 0 2px 8px rgba(158, 40, 145, 0.3);
    }
    header h1 {
        font-size: 24px;
        font-weight: 600;
    }
    nav {
        margin-top: 10px;
    }
    nav a {
        color: rgba(255, 255, 255, 0.9);
        text-decoration: none;
        margin-right: 20px;
        padding: 6px 14px;
        border-radius: 6px;
        transition: all 0.2s ease;
        font-weight: 500;
    }
    nav a:hover {
        background: rgba(255, 255, 255, 0.15);
        color: white;
    }
    h2, h3 {
        color: var(--primary-green);
    }
    .card {
        background: var(--bg-white);
        border-radius: 12px;
        padding: 24px;
        margin-bottom: 20px;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
        border: 1px solid var(--border-light);
    }
    .badge {
        display: inline-block;
        padding: 4px 12px;
        border-radius: 20px;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
    }
    .badge-success {
        background: var(--primary-green);
        color: white;
    }
    .badge-failed {
        background: var(--error-red);
        color: white;
    }
    .badge-in_progress, .badge-pending {
        background: var(--secondary-orange);
        color: var(--text-dark);
    }
    table {
        width: 100%;
        border-collapse: collapse;
        margin-top: 20px;
    }
    th, td {
        padding: 14px 12px;
        text-align: left;
        border-bottom: 1px solid var(--border-light);
    }
    th {
        background: var(--bg-light);
        font-weight: 600;
        color: var(--text-dark);
        font-size: 13px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
    }
    tr:hover {
        background: var(--bg-light);
    }
    .command {
        background: var(--bg-light);
        padding: 16px;
        border-radius: 8px;
        margin-bottom: 16px;
        font-family: 'Monaco', 'Menlo', 'Courier New', monospace;
        font-size: 13px;
        border: 1px solid var(--border-light);
    }
    .command-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 12px;
        flex-wrap: wrap;
        gap: 8px;
    }
    .command-header strong {
        color: var(--text-dark);
        word-break: break-all;
    }
    .command-text {
        color: var(--text-muted);
        margin-bottom: 10px;
    }
    .command-output, .command-error {
        margin-top: 12px;
        padding: 12px;
        border-radius: 6px;
        max-height: 300px;
        overflow: auto;
    }
    .command-output {
        background: #f0fdf4;
        border: 1px solid #bbf7d0;
    }
    .command-output strong {
        color: var(--primary-green);
        display: block;
        margin-bottom: 8px;
    }
    .command-output pre {
        color: var(--primary-green-dark);
        white-space: pre-wrap;
        word-break: break-word;
        margin: 0;
        font-family: inherit;
        font-size: 12px;
        line-height: 1.5;
    }
    .command-error {
        background: var(--error-red-light);
        border: 1px solid #fecaca;
    }
    .command-error strong {
        color: var(--error-red);
        display: block;
        margin-bottom: 8px;
    }
    .command-error pre {
        color: #991b1b;
        white-space: pre-wrap;
        word-break: break-word;
        margin: 0;
        font-family: inherit;
        font-size: 12px;
        line-height: 1.5;
    }
    .timestamp {
        color: var(--text-muted);
        font-size: 13px;
    }
    a {
        color: var(--primary-green);
        text-decoration: none;
        font-weight: 500;
    }
    a:hover {
        color: var(--primary-green-dark);
        text-decoration: underline;
    }
    code {
        background: var(--bg-light);
        padding: 2px 6px;
        border-radius: 4px;
        font-family: 'Monaco', 'Menlo', 'Courier New', monospace;
        font-size: 12px;
        border: 1px solid var(--border-light);
    }
    .btn {
        display: inline-block;
        padding: 8px 16px;
        border-radius: 6px;
        font-weight: 500;
        text-decoration: none;
        transition: all 0.2s ease;
        cursor: pointer;
        border: none;
    }
    .btn-primary {
        background: var(--primary-green);
        color: white;
    }
    .btn-primary:hover {
        background: var(--primary-green-dark);
        text-decoration: none;
        color: white;
    }
    .btn-secondary {
        background: var(--secondary-orange);
        color: var(--text-dark);
    }
    .btn-secondary:hover {
        background: var(--secondary-orange-dark);
        text-decoration: none;
    }
    .btn-danger {
        background: var(--error-red);
        color: white;
    }
    .btn-danger:hover {
        background: #dc2626;
        text-decoration: none;
        color: white;
    }
`;

export function Layout({ title, children }: LayoutProps): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title} - Yimaru CI/CD</title>
    <style>${styles}</style>
</head>
<body>
    <header>
        <div class="container">
            <h1>🚀 Yimaru CI/CD Dashboard</h1>
            <nav>
                <a href="/">Deployments</a>
                <a href="/health">Health</a>
            </nav>
        </div>
    </header>
    <div class="container">
        ${children}
    </div>
</body>
</html>`;
}

