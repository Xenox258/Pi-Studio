import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const host = '127.0.0.1';
const port = '1438';
const origin = `http://${host}:${port}`;
let server;

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

let sourceAssertions = 0;
function requireContract(condition, description) {
  if (!condition) throw new Error(`Frontend startup contract missing: ${description}`);
  sourceAssertions += 1;
}
function occurrences(source, text) {
  return source.split(text).length - 1;
}

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const protectedShellSource = appSource.slice(appSource.indexOf('function ProtectedShell'), appSource.indexOf('return <Router>'));
const interactiveEffectAt = protectedShellSource.indexOf('createEffect(() => {');
const firstInteractiveFrameAt = protectedShellSource.indexOf('requestAnimationFrame(', interactiveEffectAt);
const interactiveLogAt = protectedShellSource.indexOf('console.info(`[startup] gui-interactive:', firstInteractiveFrameAt);
const interactiveCleanupAt = protectedShellSource.indexOf('onCleanup(() => {', interactiveEffectAt);
const interactiveReadinessGuardSource = protectedShellSource.slice(interactiveEffectAt, firstInteractiveFrameAt);
const interactivePaintSource = protectedShellSource.slice(firstInteractiveFrameAt, interactiveLogAt);
const interactiveCleanupSource = protectedShellSource.slice(interactiveCleanupAt);
const storeSource = readFileSync(new URL('../src/stores/appStore.ts', import.meta.url), 'utf8');
const applyCatalogSource = storeSource.slice(storeSource.indexOf('export function applyModelCatalog'), storeSource.indexOf('export const [modelCatalogLoading'));
const bootstrapSource = storeSource.slice(storeSource.indexOf('export function bootstrapModelCatalog'), storeSource.indexOf('export const [activeProject'));
const bootSource = storeSource.slice(storeSource.indexOf('async function bootConfiguredSession'));
const startSessionAt = bootSource.indexOf('studioApi.startSession');
const runtimeConfigurationAt = bootSource.indexOf('await studioApi.sessionConfiguration(id)');
const catalogAt = bootSource.indexOf('await bootstrapModelCatalog()');
const setModelAt = bootSource.indexOf('studioApi.setModel');
const setThinkingAt = bootSource.indexOf('studioApi.setThinking');
const catalogFailureAt = bootSource.indexOf('} catch (catalogError) {');
const configureAt = bootSource.indexOf('if (catalogReady) {');
const catalogFailureSource = bootSource.slice(catalogFailureAt, configureAt);
const runtimeStateSource = bootSource.slice(runtimeConfigurationAt, catalogAt);
const preferredConfigurationSource = bootSource.slice(configureAt, bootSource.indexOf('setActiveProject(opened)'));

requireContract(appSource.includes('void bootstrapModelCatalog().catch(() => undefined);'), 'App starts catalog loading in the background');
requireContract(appSource.includes('<Show when={!settings.loading}') && !appSource.includes('modelBootstrap.loading'), 'AppShell waits for settings only');
requireContract(/import\s*\{[^}]*\bchildren\b[^}]*\}\s*from ['"]solid-js['"]/.test(appSource), 'App imports Solid children to preserve the nested route accessor');
requireContract(protectedShellSource.includes('const routeChildren = children(() => props.children);'), 'ProtectedShell preserves nested route children in a Solid accessor');
requireContract(!appSource.includes('function InteractiveShell'), 'App does not declare an intermediate InteractiveShell');
requireContract(protectedShellSource.includes('<AppShell>{routeChildren()}</AppShell>') && !protectedShellSource.includes('<AppShell>{props.children}</AppShell>') && !protectedShellSource.includes('<InteractiveShell'), 'AppShell consumes the preserved nested route accessor directly');
requireContract(interactiveEffectAt >= 0 && firstInteractiveFrameAt > interactiveEffectAt && interactiveReadinessGuardSource.includes('settings.loading') && interactiveReadinessGuardSource.includes('settings()?.onboardingCompleted') && interactiveReadinessGuardSource.includes('guiInteractiveLogged') && /\b[A-Za-z_$][\w$]*\s*!==\s*undefined/.test(interactiveReadinessGuardSource) && !protectedShellSource.includes('onMount('), 'interactive timing waits reactively for ready settings and completed onboarding before scheduling once');
requireContract(interactiveLogAt > firstInteractiveFrameAt && occurrences(interactivePaintSource, 'requestAnimationFrame(') >= 2 && interactivePaintSource.includes('guiInteractiveLogged = true;'), 'development startup timing logs once after two shell paint frames');
requireContract(interactiveCleanupAt > interactiveEffectAt && interactiveCleanupSource.includes('cancelAnimationFrame('), 'ProtectedShell cancels pending interactive timing frames on cleanup');
requireContract(!appSource.includes('studioApi.models()') && !appSource.includes("studioApi.roles('global')"), 'App delegates model and role loading to the store');
requireContract(occurrences(storeSource, 'studioApi.models()') === 1 && occurrences(storeSource, "studioApi.roles('global')") === 1, 'the bootstrap issues one models call and one roles call');
requireContract(bootstrapSource.includes('if (modelCatalogBootstrap) return modelCatalogBootstrap;') && bootstrapSource.includes('modelCatalogBootstrap = pending;'), 'concurrent bootstrap callers receive the same promise');
requireContract(bootstrapSource.includes('pending.catch') && bootstrapSource.includes('modelCatalogBootstrap === pending') && bootstrapSource.includes('modelCatalogBootstrap = undefined'), 'a rejected catalog bootstrap is cleared so a later session can retry');
requireContract(storeSource.includes('modelCatalogLoading') && storeSource.includes('modelCatalogError'), 'catalog loading and failure remain observable');
requireContract(startSessionAt >= 0 && startSessionAt < runtimeConfigurationAt && runtimeConfigurationAt < catalogAt && catalogAt < setModelAt && catalogAt < setThinkingAt, 'OMP runtime configuration is read before catalog-backed preferences are applied');
requireContract(runtimeStateSource.includes('if (configuration.model) setActiveModel(configuration.model)') && runtimeStateSource.includes('setThinkingLevel(runtimeModel ?') && runtimeStateSource.includes('normalizeEffortValue(configuration.thinkingLevel)'), 'the live runtime model and effort become authoritative before catalog bootstrap without replacing the stored preference');
requireContract(applyCatalogSource.includes('(!currentSelector ?') && applyCatalogSource.includes("else if (!currentSelector) setActiveModel('')"), 'a runtime selector absent from the quick catalog is not replaced without a valid preference');
requireContract(preferredConfigurationSource.includes('candidate.selector === recentModelSelectors()[0]') && preferredConfigurationSource.includes('resolveEffortConfig(model, preferredEffort)') && preferredConfigurationSource.includes('setActiveModel(model.selector)') && preferredConfigurationSource.includes('setPreferredThinkingLevel(effort.selectedValue)'), 'successful catalog bootstrap restores the valid model and effort preference');
requireContract(catalogFailureAt >= 0 && configureAt > catalogFailureAt && !catalogFailureSource.includes("setActiveModel('')") && catalogFailureSource.includes("appendConversationNotice('Model catalog unavailable'") && catalogFailureSource.includes('runtime model') && !catalogFailureSource.includes('stopSession') && storeSource.includes('?.name ?? activeModel()'), 'catalog failure keeps a truthful runtime label, emits a notice, and leaves the session usable');
requireContract(bootSource.indexOf('setSessionLive(true)') > configureAt, 'a catalog failure can still reach the live session state');

try {
  server = spawn('npm', ['run', 'preview', '--', '--host', host, '--port', port, '--strictPort'], { detached: true, stdio: 'ignore' });
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
  console.log(JSON.stringify({ scenarios: scenarios.length, assertions: 15 + sourceAssertions, status: 'ok' }));
} finally {
  if (server) try { process.kill(-server.pid, 'SIGTERM'); } catch {}
}
