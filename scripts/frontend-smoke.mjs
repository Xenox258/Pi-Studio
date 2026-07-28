import { execFileSync, spawn } from 'node:child_process';

const host = '127.0.0.1';
const port = '1438';
const origin = `http://${host}:${port}`;
const server = spawn('npm', ['run', 'preview', '--', '--host', host, '--port', port, '--strictPort'], { detached: true, stdio: 'ignore' });

async function waitForServer() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try { if ((await fetch(origin)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('Preview server did not become ready');
}

function render(path) {
  return execFileSync('chromium', ['--headless', '--disable-gpu', '--no-sandbox', '--virtual-time-budget=3000', '--dump-dom', `${origin}${path}`], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] });
}

function requireText(html, text, path) {
  if (!html.includes(text)) throw new Error(`${path} did not render ${JSON.stringify(text)}`);
}

try {
  await waitForServer();
  const scenarios = [
    ['/', 'OMP workspace'],
    ['/usage', 'Usage &amp; limits'],
    ['/models', 'Models &amp; Roles'],
    ['/discover', 'Pi Catalog'],
    ['/installed', 'Installed resources'],
    ['/updates', 'Package updates'],
    ['/local', 'Local resources'],
    ['/settings', 'Performance, OMP runtime, storage, and diagnostics.'],
    ['/onboarding', 'Welcome to OMP Studio'],
    ['/providers', 'Welcome to OMP Studio'],
  ];
  for (const [path, expected] of scenarios) requireText(render(path), expected, path);
  const workspace = render('/');
  requireText(workspace, 'Ask OMP Studio anything', '/');
  requireText(workspace, 'Active model', '/');
  if (workspace.includes('GPT-4o')) throw new Error('Workspace rendered a fabricated model');
  const usage = render('/usage');
  requireText(usage, 'Usage is available in the installed OMP Studio application.', '/usage');
  if (usage.includes('developer@example.com')) throw new Error('Usage page rendered fabricated account data');
  console.log(JSON.stringify({ scenarios: scenarios.length, assertions: 14, status: 'ok' }));
} finally {
  try { process.kill(-server.pid, 'SIGTERM'); } catch {}
}
