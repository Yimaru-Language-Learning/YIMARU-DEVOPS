interface LayoutProps {
    title: string;
    children: string;
}

const styles = `
    /* Match customer/design/tokens.json and the customer frontend's dark palette. */
    :root {
        --ink: #111111;
        --ink-2: #3A3A3A;
        --ink-muted: #6B6B6B;
        --paper: #FFFFFF;
        --canvas: #F4F4F4;
        --mist: #F7F7F7;
        --line: #E4E4E4;
        --accent-soft: #EFEFEF;
        --accent-hover: #000000;
        --alert: #000000;
        --alert-soft: #E6E6E6;
        --warn-soft: #F3F3F3;
        --info-soft: #F0F0F0;
        --on-ink: #FFFFFF;
        color-scheme: light;
    }
    @media (prefers-color-scheme: dark) {
        :root {
            --ink: #F5F5F5;
            --ink-2: #C8C8C8;
            --ink-muted: #9A9A9A;
            --paper: #0A0A0A;
            --canvas: #000000;
            --mist: #161616;
            --line: #2A2A2A;
            --accent-soft: #2A2A2A;
            --accent-hover: #FFFFFF;
            --alert: #FFFFFF;
            --alert-soft: #2A2A2A;
            --warn-soft: #1F1F1F;
            --info-soft: #1C1C1C;
            --on-ink: #0A0A0A;
            color-scheme: dark;
        }
    }
    * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
    }
    body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
        background: var(--canvas);
        color: var(--ink);
        line-height: 1.6;
    }
    .container {
        max-width: 1200px;
        margin: 0 auto;
        padding: 20px;
    }
    header {
        background: var(--paper);
        color: var(--ink);
        padding: 20px 0;
        margin-bottom: 30px;
        border-bottom: 1px solid var(--line);
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
    }
    header h1 {
        font-size: 24px;
        font-weight: 600;
    }
    nav {
        margin-top: 10px;
    }
    nav a {
        color: var(--ink-2);
        text-decoration: none;
        margin-right: 20px;
        padding: 6px 14px;
        border-radius: 6px;
        transition: all 0.2s ease;
        font-weight: 500;
    }
    nav a:hover {
        background: var(--mist);
        color: var(--ink);
    }
    h2, h3 {
        color: var(--ink);
    }
    .card {
        background: var(--paper);
        border-radius: 12px;
        padding: 24px;
        margin-bottom: 20px;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
        border: 1px solid var(--line);
    }
    .badge {
        display: inline-block;
        padding: 4px 12px;
        border-radius: 20px;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        border: 1px solid transparent;
    }
    .badge-success {
        background: var(--ink);
        color: var(--on-ink);
    }
    .badge-failed {
        background: var(--alert-soft);
        color: var(--alert);
        border-color: var(--alert);
        border-style: dashed;
    }
    .badge-in_progress, .badge-pending {
        background: var(--info-soft);
        color: var(--ink);
        border-color: var(--line);
    }
    .badge-pending {
        background: var(--warn-soft);
    }
    table {
        width: 100%;
        border-collapse: collapse;
        margin-top: 20px;
    }
    th, td {
        padding: 14px 12px;
        text-align: left;
        border-bottom: 1px solid var(--line);
    }
    th {
        background: var(--canvas);
        font-weight: 600;
        color: var(--ink);
        font-size: 13px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
    }
    tr:hover {
        background: var(--canvas);
    }
    .command {
        background: var(--canvas);
        padding: 16px;
        border-radius: 8px;
        margin-bottom: 16px;
        font-family: 'Monaco', 'Menlo', 'Courier New', monospace;
        font-size: 13px;
        border: 1px solid var(--line);
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
        color: var(--ink);
        word-break: break-all;
    }
    .command-text {
        color: var(--ink-muted);
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
        background: var(--mist);
        border: 1px solid var(--line);
    }
    .command-output strong {
        color: var(--ink);
        display: block;
        margin-bottom: 8px;
    }
    .command-output pre {
        color: var(--ink-2);
        white-space: pre-wrap;
        word-break: break-word;
        margin: 0;
        font-family: inherit;
        font-size: 12px;
        line-height: 1.5;
    }
    .command-error {
        background: var(--alert-soft);
        border: 1px solid var(--line);
        border-left: 3px solid var(--alert);
    }
    .command-error strong {
        color: var(--alert);
        display: block;
        margin-bottom: 8px;
    }
    .command-error pre {
        color: var(--ink);
        white-space: pre-wrap;
        word-break: break-word;
        margin: 0;
        font-family: inherit;
        font-size: 12px;
        line-height: 1.5;
    }
    .timestamp {
        color: var(--ink-muted);
        font-size: 13px;
    }
    a {
        color: var(--ink);
        text-decoration: none;
        font-weight: 500;
    }
    a:hover {
        color: var(--accent-hover);
        text-decoration: underline;
    }
    a:focus-visible {
        outline: 2px solid var(--ink);
        outline-offset: 3px;
    }
    code {
        background: var(--canvas);
        padding: 2px 6px;
        border-radius: 4px;
        font-family: 'Monaco', 'Menlo', 'Courier New', monospace;
        font-size: 12px;
        border: 1px solid var(--line);
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
        background: var(--ink);
        color: var(--on-ink);
    }
    .btn-primary:hover {
        background: var(--accent-hover);
        text-decoration: none;
        color: var(--on-ink);
    }
    .btn-secondary {
        background: var(--mist);
        color: var(--ink);
    }
    .btn-secondary:hover {
        background: var(--accent-soft);
        text-decoration: none;
    }
    .btn-danger {
        background: var(--alert);
        color: var(--on-ink);
    }
    .btn-danger:hover {
        background: var(--accent-hover);
        text-decoration: none;
        color: var(--on-ink);
    }
`;

export function Layout({ title, children }: LayoutProps): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title} - Rezina CI/CD</title>
    <style>${styles}</style>
</head>
<body>
    <header>
        <div class="container">
            <h1>🚀 Rezina CI/CD Dashboard</h1>
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

