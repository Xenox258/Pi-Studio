import { spawn } from "node:child_process";
import { rmSync } from "node:fs";

const host = "127.0.0.1";
const previewPort = 1439;
const debugPort = 9444;
const origin = `http://${host}:${previewPort}`;
const profile = "/tmp/omp-studio-e2e-profile";
const preview = spawn(
	"npm",
	[
		"run",
		"preview",
		"--",
		"--host",
		host,
		"--port",
		String(previewPort),
		"--strictPort",
	],
	{ detached: true, stdio: "ignore" },
);
const chromium = spawn(
	"chromium",
	[
		"--headless=new",
		"--disable-gpu",
		"--no-sandbox",
		`--remote-debugging-port=${debugPort}`,
		`--user-data-dir=${profile}`,
		"about:blank",
	],
	{ detached: true, stdio: "ignore" },
);

async function retry(operation, timeout = 30000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		try {
			const value = await operation();
			if (value) return value;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("Timed out waiting for browser state");
}

let socket;
let nextId = 0;
const pending = new Map();
function send(method, params = {}) {
	const id = ++nextId;
	socket.send(JSON.stringify({ id, method, params }));
	return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function evaluate(expression) {
	const response = await send("Runtime.evaluate", {
		expression,
		returnByValue: true,
		awaitPromise: true,
	});
	if (response.exceptionDetails)
		throw new Error(
			response.exceptionDetails.exception?.description ??
				response.exceptionDetails.text,
		);
	return response.result.value;
}
async function navigate(path, readyText) {
	await send("Page.navigate", { url: `${origin}${path}` });
	await retry(async () =>
		evaluate(`document.body?.innerText.includes(${JSON.stringify(readyText)})`),
	);
}
let assertions = 0;
function assert(condition, message) {
	assertions++;
	if (!condition) throw new Error(message);
}

try {
	await retry(async () => (await fetch(origin)).ok);
	const target = await retry(async () =>
		(await (await fetch(`http://${host}:${debugPort}/json/list`)).json()).find(
			(item) => item.type === "page",
		),
	);
	socket = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		socket.addEventListener("open", resolve, { once: true });
		socket.addEventListener("error", reject, { once: true });
	});
	socket.addEventListener("message", (event) => {
		const message = JSON.parse(event.data);
		if (!message.id || !pending.has(message.id)) return;
		const request = pending.get(message.id);
		pending.delete(message.id);
		if (message.error) request.reject(new Error(message.error.message));
		else request.resolve(message.result);
	});
	await send("Page.enable");
	await send("Runtime.enable");
	await send("Emulation.setDeviceMetricsOverride", {
		width: 1280,
		height: 800,
		deviceScaleFactor: 1,
		mobile: false,
	});
	await send("Page.addScriptToEvaluateOnNewDocument", {
		source: `
    window.__calls = []; window.__sessionStarted = false; window.__newSessionTitle = 'New session';
    window.__catalogCalls = { discover: 0, installed: 0, updates: 0, local: 0 }; window.__holdDiscover = false; window.__releaseDiscover = undefined;
    window.__listeners = {};
    const readConnected = () => JSON.parse(sessionStorage.getItem('connected') || '[]');
    const writeConnected = list => sessionStorage.setItem('connected', JSON.stringify(list));
    window.__TAURI_INTERNALS__ = {
      __cbs: {}, __cbId: 0,
      invoke: async (command, args) => {
        window.__calls.push({ command, args });
        if (command === 'get_studio_settings') return { processPolicy: 'Economy', suspendBackground: true, cacheLimitMb: 100, onboardingCompleted: sessionStorage.getItem('onboarding') === 'done', connectedProviders: readConnected() };
        if (command === 'save_studio_settings') { if (args.settings.onboardingCompleted) sessionStorage.setItem('onboarding', 'done'); return; }
        if (command === 'available_models' && sessionStorage.getItem('models-unavailable') === '1') return [];
        if (command === 'available_models') return [
          { provider: 'openai-codex', id: 'gpt-5.6-sol', selector: 'openai-codex/gpt-5.6-sol', name: 'GPT 5.6 Sol', contextWindow: 272000, maxTokens: 128000, reasoning: true, thinking: ['low', 'medium', 'high', 'xhigh', 'max'], input: ['text'] },
          { provider: 'anthropic', id: 'claude-fable-5', selector: 'anthropic/claude-fable-5', name: 'Claude Fable 5', contextWindow: 1000000, maxTokens: 128000, reasoning: true, thinking: ['low', 'medium', 'high', 'xhigh', 'max'], input: ['text'] },
          { provider: 'anthropic', id: 'claude-mythos-5', selector: 'anthropic/claude-mythos-5', name: 'Claude Mythos 5', contextWindow: 1000000, maxTokens: 128000, reasoning: true, thinking: ['low', 'medium', 'high', 'xhigh', 'max'], input: ['text'] },
          { provider: 'anthropic', id: 'claude-sonnet-5', selector: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5', contextWindow: 1000000, maxTokens: 128000, reasoning: true, thinking: ['low', 'medium', 'high', 'xhigh', 'max'], input: ['text'] },
          { provider: 'anthropic', id: 'claude-opus-4-7', selector: 'anthropic/claude-opus-4-7', name: 'Claude Opus 4.7', contextWindow: 1000000, maxTokens: 128000, reasoning: true, thinking: ['low', 'medium', 'high', 'xhigh', 'max'], input: ['text'] },
          { provider: 'anthropic', id: 'claude-haiku-4-5', selector: 'anthropic/claude-haiku-4-5', name: 'Claude Haiku 4.5', contextWindow: 200000, maxTokens: 64000, reasoning: true, thinking: ['minimal', 'low', 'medium', 'high', 'xhigh'], input: ['text'] },
          { provider: 'anthropic', id: 'claude-opus-4-8', selector: 'anthropic/claude-opus-4-8', name: 'Claude Opus 4.8', contextWindow: 1000000, maxTokens: 128000, reasoning: true, thinking: ['low', 'medium', 'high', 'xhigh', 'max'], input: ['text'] },
          { provider: 'anthropic', id: 'claude-haiku-4-5-20251001', selector: 'anthropic/claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', contextWindow: 200000, maxTokens: 64000, reasoning: false, thinking: [], input: ['text'] },
          { provider: 'anthropic', id: 'claude-3-5-sonnet-20241022', selector: 'anthropic/claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', contextWindow: 200000, maxTokens: 8192, reasoning: false, thinking: [], input: ['text'] },
          { provider: 'openai-codex', id: 'gpt-5.5', selector: 'openai-codex/gpt-5.5', name: 'GPT 5.5', contextWindow: 272000, maxTokens: 128000, reasoning: true, thinking: ['low', 'medium', 'high', 'xhigh'], input: ['text'] },
          { provider: 'openai-codex', id: 'gpt-5.4', selector: 'openai-codex/gpt-5.4', name: 'GPT 5.4', contextWindow: 272000, maxTokens: 128000, reasoning: true, thinking: ['low', 'medium', 'high', 'xhigh'], input: ['text'] },
          { provider: 'openai-codex', id: 'gpt-4.1', selector: 'openai-codex/gpt-4.1', name: 'GPT 4.1', contextWindow: 128000, maxTokens: 32768, reasoning: false, thinking: [], input: ['text'] },
          { provider: 'deepseek', id: 'deepseek-v4-pro', selector: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 128000, maxTokens: 64000, reasoning: true, thinking: ['high', 'max'], input: ['text'] },
          { provider: 'deepseek', id: 'deepseek-v4-flash', selector: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 128000, maxTokens: 64000, reasoning: true, thinking: ['high', 'max'], input: ['text'] },
          { provider: 'deepseek', id: 'deepseek-v3', selector: 'deepseek/deepseek-v3', name: 'DeepSeek V3', contextWindow: 128000, maxTokens: 64000, reasoning: false, thinking: [], input: ['text'] },
          { provider: 'ollama', id: 'qwen3.5:9b', selector: 'ollama/qwen3.5:9b', name: 'Qwen 3.5 9B', contextWindow: 128000, maxTokens: 32768, reasoning: false, thinking: [], input: ['text'] },
        ];
        if (command === 'available_providers') return [{ id: 'anthropic', name: 'Anthropic' }, { id: 'openai', name: 'OpenAI API' }, { id: 'xai-oauth', name: 'xAI Grok OAuth' }, { id: 'lm-studio', name: 'LM Studio' }];
        if (command === 'get_role_mappings') return JSON.parse(sessionStorage.getItem('role-mappings') || '[{"id":"default","label":"Default","description":"Fallback role","model":"anthropic/claude-fable-5","thinking":"High","tone":"purple"}]');
        if (command === 'save_role_mappings') { sessionStorage.setItem('role-mappings', JSON.stringify(args.roles)); return; }
        if (command === 'catalog_marketplaces') return [{ name: 'studio-smoke', source: '/tmp/marketplace' }];
        if (command === 'catalog_packages') {
          const mode = args.mode;
          if (!(mode in window.__catalogCalls)) throw new Error('Unexpected catalog mode: ' + mode);
          window.__catalogCalls[mode]++;
          if (mode === 'discover' && window.__holdDiscover && window.__catalogCalls.discover === 1) await new Promise(resolve => { window.__releaseDiscover = resolve; });
          return mode === 'discover' ? [{ id: 'studio-tool@studio-smoke', name: 'studio-tool', author: 'studio-smoke', description: 'Reported by OMP', kind: 'Package', version: '1.2.3', installed: false, updateAvailable: false, compatibility: 'OMP marketplace', permissions: [], resources: [] }] : [];
        }
        if (command === 'recent_projects') return [{ id: 'p1', name: 'Demo Project', path: '/tmp/demo' }];
        if (command === 'recent_sessions') return [...(window.__sessionStarted ? [{ id: 'sess-1', title: window.__newSessionTitle, projectId: 'p1', updatedAt: new Date().toISOString(), active: true }] : []), { id: 'past-1', title: 'Past session', projectId: 'p1', updatedAt: '2026-07-20T12:00:00Z', active: false }];
        if (command === 'provider_test') return false;
        if (command === 'open_project') return { id: 'p1', name: 'Demo Project', path: args.path };
        if (command === 'plugin:dialog|open') return '/tmp/demo';
        if (command === 'start_session') { window.__sessionStarted = true; window.__newSessionTitle = 'New session'; if (window.__holdSessionStart) await new Promise(resolve => { window.__releaseSessionStart = resolve; }); return 'sess-1'; }
        // Tauri rejects with the raw Err(String) payload, never an Error instance.
        if (command === 'resume_session' && window.__failResume) throw 'omp is not installed';
        if (command === 'resume_session') { if (window.__holdResume) await new Promise(resolve => { window.__releaseResume = resolve; }); return { id: 'p1', name: 'Demo Project', path: '/tmp/demo' }; }
        if (command === 'conversation_history' && window.__failHistory) throw 'RPC response exceeded the transport limit';
        if (command === 'session_snapshot' && window.__failSnapshot) throw 'Unknown session';
        const storedHistory = [
          { id: 'hu', role: 'user', content: 'Historical question', timestamp: 1753012800000 },
          { id: 'ht-call', role: 'assistant', content: [{ type: 'toolCall', id: 'historical-tool', name: 'read', arguments: { path: 'src/history.ts' } }], timestamp: 1753012804000 },
          { id: 'ht-result', role: 'toolResult', toolCallId: 'historical-tool', toolName: 'read', content: [{ type: 'text', text: 'Historical tool output' }], timestamp: 1753012806000 },
          { id: 'hadvisor', role: 'custom', customType: 'advisor', content: 'Native concern', details: { notes: [{ note: 'Native concern', severity: 'concern', advisor: 'default' }] }, timestamp: 1753012808000 },
          { id: 'ha', role: 'assistant', content: [{ type: 'text', text: 'Historical answer' }], stopReason: 'stop', timestamp: 1753012810000 },
        ];
        if (command === 'conversation_history') return storedHistory;
        // The snapshot is read off disk, so it answers with the whole session before any process attaches.
        if (command === 'session_snapshot') return { project: { id: 'p1', name: 'Demo Project', path: '/tmp/demo' }, messages: storedHistory, model: 'anthropic/claude-fable-5', thinkingLevel: 'xhigh', title: window.__sessionName };
        // Mirrors the real command: reading the state is what writes OMP's name into stored history.
        if (command === 'session_configuration') { if (window.__sessionName) window.__newSessionTitle = window.__sessionName; return { model: 'anthropic/claude-fable-5', thinkingLevel: 'xhigh', sessionName: window.__sessionName }; }
        if (command === 'set_session_title') { window.__newSessionTitle = args.title; return; }
        if (command === 'available_commands') return [{ name: 'stop', description: 'Stop the current run', source: 'builtin' }, { name: 'advisor', description: 'Toggle advisor', input: { hint: '[on|off]' }, subcommands: [{ name: 'on', description: 'Enable the advisor' }, { name: 'off', description: 'Disable the advisor' }], source: 'builtin' }, { name: 'review', description: 'Run the review skill', source: 'skill' }];
        if (command === 'stop_session' || command === 'send_prompt' || command === 'steer_prompt' || command === 'follow_up_prompt' || command === 'stop_run') return;
        if (command === 'set_model') { if (window.__holdModel) await new Promise(resolve => { window.__releaseModel = resolve; }); return; }
        if (command === 'set_thinking_level') { if (window.__failThinkingOnce) { window.__failThinkingOnce = false; throw new Error('OMP rejected effort'); } return; }
        if (command === 'set_workflow_mode' || command === 'set_advisor_enabled') return;
        if (command === 'provider_login' || command === 'provider_api_key_login') { const list = readConnected(); if (!list.includes(args.providerId)) list.push(args.providerId); writeConnected(list); return; }
        if (command === 'provider_logout') { writeConnected(readConnected().filter(id => id !== args.providerId)); return; }
        if (command === 'git_snapshot') return { branch: 'main', clean: true, changedFiles: [], branches: ['main'], worktrees: [] };
        if (command === 'github_snapshot') return { available: false, checkedAt: new Date().toISOString() };
        if (command === 'runtime_stats') return { activeProcesses: 1 };
        if (command === 'usage_get_snapshot') return { fetchedAt: new Date().toISOString(), source: 'ompCli', stale: false, providers: [{ providerId: 'openai-codex', providerName: 'OpenAI Codex', accounts: [{ credentialId: 'openai-account', displayLabel: 'developer@example.com', authKind: 'subscription', planType: 'plus', activeForSession: false, limits: [{ id: 'openai:7d', label: '7 days', usedPercent: 96 }], resetCredits: { available: 0, credits: [] } }] }, { providerId: 'anthropic', providerName: 'Anthropic', accounts: [{ credentialId: 'anthropic-account', displayLabel: 'developer@example.com', organizationLabel: 'Example Organization', authKind: 'subscription', activeForSession: false, limits: [{ id: 'anthropic:5h', label: 'Claude 5 Hour', usedPercent: 2 }, { id: 'anthropic:7d', label: 'Claude 7 Day', usedPercent: 0 }], resetCredits: { available: 0, credits: [] } }] }] };
        if (command === 'plugin:event|listen') { window.__listeners[args.event] = args.handler; return 1; }
        if (command === 'plugin:event|unlisten') return;
        throw new Error('Unhandled command: ' + command);
      },
      transformCallback: (callback) => { const id = ++window.__TAURI_INTERNALS__.__cbId; window.__TAURI_INTERNALS__.__cbs[id] = callback; return id; },
      unregisterCallback: () => {}, convertFileSrc: value => value
    };
    window.__ompEmit = (raw, sessionId = 'sess-1') => {
      const handlerId = window.__listeners['omp-frame'];
      const callback = window.__TAURI_INTERNALS__.__cbs[handlerId];
      if (!callback) throw new Error('omp-frame listener not registered');
      callback({ event: 'omp-frame', id: handlerId, payload: { sessionId, raw } });
    };
  `,
	});

	// Scenario 1 — onboarding distinguishes auth contexts and derives connected state from OMP models.
	await navigate("/", "Welcome to OMP Studio");
	const onboarding = await evaluate(
		`({ path: location.pathname, providers: document.querySelectorAll('.provider-list > button').length, branded: document.querySelectorAll('.provider-list .provider-brand-logo').length, detected: [...document.querySelectorAll('.provider-list > button')].find(row => row.innerText.includes('Anthropic'))?.innerText.includes('Logged in'), staleBrokerCopy: document.body.innerText.includes('Connection not checked') || document.body.innerText.includes('Check broker'), overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth })`,
	);
	assert(
		onboarding.path === "/onboarding",
		"First launch did not route to onboarding",
	);
	assert(
		onboarding.providers === 4 &&
			onboarding.branded === 4 &&
			onboarding.detected &&
			!onboarding.staleBrokerCopy &&
			!onboarding.overflow,
		"Onboarding provider contract failed: " + JSON.stringify(onboarding),
	);
	await evaluate(
		`([...document.querySelectorAll('.tabs button')].find(button => button.innerText.trim() === 'Sign in')).click()`,
	);
	const signInProviders = await evaluate(
		`([...document.querySelectorAll('.provider-list > button strong')].map(node => node.innerText))`,
	);
	assert(
		JSON.stringify(signInProviders) ===
			JSON.stringify(["Anthropic", "xAI Grok OAuth"]),
		"Sign-in provider context is incorrect: " + JSON.stringify(signInProviders),
	);
	await evaluate(
		`([...document.querySelectorAll('.tabs button')].find(button => button.innerText.trim() === 'Web search')).click()`,
	);
	const webProviders = await evaluate(
		`([...document.querySelectorAll('.provider-list > button strong')].map(node => node.innerText))`,
	);
	assert(
		JSON.stringify(webProviders) ===
			JSON.stringify(["Anthropic", "OpenAI API"]),
		"Web-search provider context is incorrect: " + JSON.stringify(webProviders),
	);

	await evaluate(`sessionStorage.setItem('onboarding', 'done')`);
	await navigate("/models", "Models & Roles");
	await retry(async () =>
		evaluate(`window.__calls.some(call => call.command === 'get_role_mappings')`),
	);
	const models = await evaluate(
		`({ live: document.body.innerText.includes('GPT 5.6 Sol'), fake: document.body.innerText.includes('GPT-4o'), roles: [...document.querySelectorAll('.role-name strong')].map(node => node.textContent), overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth })`,
	);
	assert(
		models.live && !models.fake && !models.overflow,
		"Live model contract failed",
	);
	assert(
		JSON.stringify(models.roles) ===
			JSON.stringify(["Default", "Smol", "Slow", "Plan", "Advisor", "Vision", "Task", "Designer"]),
		"Built-in OMP roles were replaced by the partial stored mapping: " +
			JSON.stringify(models.roles),
	);
	const storedDefault = await evaluate(
		`({ mapping: document.querySelector('.role-row select')?.value, active: document.querySelector('a[href="/models"]')?.getAttribute('aria-label'), usage: document.querySelector('.topbar-usage-trigger strong')?.textContent })`,
	);
	assert(
		storedDefault.mapping === "anthropic/claude-fable-5" &&
			storedDefault.active === "Models · Claude Fable 5" &&
			storedDefault.usage === "2%",
		"The stored Default role did not initialize the active model and usage provider: " +
			JSON.stringify(storedDefault),
	);
	await evaluate(
		`(() => { const select = document.querySelector('.role-row select'); const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set; setter.call(select, 'openai-codex/gpt-5.6-sol'); select.dispatchEvent(new Event('change', { bubbles: true })); })()`,
	);
	const openAiDefault = await evaluate(
		`({ active: document.querySelector('a[href="/models"]')?.getAttribute('aria-label'), usage: document.querySelector('.topbar-usage-trigger strong')?.textContent })`,
	);
	assert(
		openAiDefault.active === "Models · GPT 5.6 Sol" && openAiDefault.usage === "96%",
		"Reactivating the GPT Default role did not update the workspace: " +
			JSON.stringify(openAiDefault),
	);
	await evaluate(
		`([...document.querySelectorAll('.summary-actions button')].find(button => button.textContent.includes('Save globally'))).click()`,
	);
	await retry(async () =>
		evaluate(`window.__calls.some(call => call.command === 'save_role_mappings')`),
	);
	await evaluate(`sessionStorage.setItem('models-unavailable', '1')`);
	await navigate('/models', 'No models available');
	const unavailableModels = await evaluate(
		`(() => { const state = document.querySelector('.models-unavailable'); return { alert: state?.getAttribute('role'), actions: [...state?.querySelectorAll('.button') ?? []].map(button => button.textContent.trim()), roles: document.querySelectorAll('.role-row').length, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth }; })()`,
	);
	assert(
		unavailableModels.alert === 'alert' &&
			JSON.stringify(unavailableModels.actions) === JSON.stringify(['Retry', 'Open providers']) &&
			unavailableModels.roles === 0 &&
			!unavailableModels.overflow,
		'Model recovery state is incomplete or overflows: ' + JSON.stringify(unavailableModels),
	);
	await evaluate(
		`sessionStorage.removeItem('models-unavailable'); document.querySelector('.models-unavailable button').click()`,
	);
	await retry(async () =>
		evaluate(`document.querySelectorAll('.role-row').length === 8 && !document.querySelector('.models-unavailable')`),
	);
	await navigate("/", "OMP workspace");

	// Scenario 2 — Discover reports held loading without duplicate requests, then marketplace routes reuse warmed catalogs in the same shell.
	await evaluate(
		`(() => { window.__documentMarker = {}; window.__shellBefore = document.querySelector('.app-shell'); window.__catalogCalls = { discover: 0, installed: 0, updates: 0, local: 0 }; window.__holdDiscover = true; window.__releaseDiscover = undefined; document.querySelector('.sidebar a[href="/discover"]')?.click(); return true; })()`,
	);
	await retry(async () =>
		evaluate(
			`window.__catalogCalls.discover === 1 && !!document.querySelector('a[aria-label="Discover"][aria-busy="true"] .spin') && !!document.querySelector('.page-transition-status[role="status"] .loading-status__spinner')`,
		),
	);
	const initialDiscoverLoading = await evaluate(
		`(() => { const status = document.querySelector('.page-transition-status[role="status"]'); return { calls: window.__catalogCalls.discover, sidebarBusy: !!document.querySelector('a[aria-label="Discover"][aria-busy="true"]'), sidebarSpinner: !!document.querySelector('a[aria-label="Discover"] .spin'), pageStatus: status?.textContent ?? '', pageSpinner: !!status?.querySelector('.loading-status__spinner') }; })()`,
	);
	assert(
		initialDiscoverLoading.calls === 1 &&
			initialDiscoverLoading.sidebarBusy &&
			initialDiscoverLoading.sidebarSpinner &&
			initialDiscoverLoading.pageSpinner &&
			initialDiscoverLoading.pageStatus.includes("Loading Discover catalog"),
		"Discover did not expose immediate loading feedback: " +
			JSON.stringify(initialDiscoverLoading),
	);
	await evaluate(
		`(async () => { const discover = document.querySelector('a[aria-label="Discover"]'); if (!discover) throw new Error('Discover navigation item missing'); for (let activation = 0; activation < 3; activation++) { discover.click(); await Promise.resolve(); } await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); return true; })()`,
	);
	const heldDiscover = await evaluate(
		`(() => { const status = document.querySelector('.page-transition-status[role="status"]'); return { calls: window.__catalogCalls.discover, sidebarBusy: !!document.querySelector('a[aria-label="Discover"][aria-busy="true"]'), sidebarSpinner: !!document.querySelector('a[aria-label="Discover"] .spin'), pageStatus: status?.textContent ?? '', pageSpinner: !!status?.querySelector('.loading-status__spinner') }; })()`,
	);
	assert(
		heldDiscover.calls === 1,
		"Repeated Discover activation issued another catalog request: " +
			JSON.stringify(heldDiscover),
	);
	assert(
		heldDiscover.sidebarBusy &&
			heldDiscover.sidebarSpinner &&
			heldDiscover.pageSpinner &&
			heldDiscover.pageStatus.includes("Loading Discover catalog"),
		"Discover loading feedback cleared before its request settled: " +
			JSON.stringify(heldDiscover),
	);
	await evaluate(
		`(() => { const release = window.__releaseDiscover; if (typeof release !== 'function') throw new Error('Discover release missing'); window.__holdDiscover = false; window.__releaseDiscover = undefined; release(); return true; })()`,
	);
	await retry(async () =>
		evaluate(
			`window.__catalogCalls.discover === 1 && !document.querySelector('a[aria-label="Discover"][aria-busy="true"]') && !document.querySelector('a[aria-label="Discover"] .spin') && !document.querySelector('.page-transition-status[role="status"]')`,
		),
	);
	const settledDiscover = await evaluate(
		`({ calls: window.__catalogCalls.discover, sidebarBusy: document.querySelector('a[aria-label="Discover"]')?.getAttribute('aria-busy') === 'true', sidebarSpinner: !!document.querySelector('a[aria-label="Discover"] .spin'), pageStatus: !!document.querySelector('.page-transition-status[role="status"]') })`,
	);
	assert(
		settledDiscover.calls === 1 &&
			!settledDiscover.sidebarBusy &&
			!settledDiscover.sidebarSpinner &&
			!settledDiscover.pageStatus,
		"Discover loading feedback did not clear after release: " +
			JSON.stringify(settledDiscover),
	);
	await retry(async () =>
		evaluate(`document.querySelector('.page-host h1')?.textContent === 'Pi Catalog'`),
	);
	await retry(async () =>
		evaluate(
			`Object.values(window.__catalogCalls).every(count => count >= 1)`,
		),
	);
	const warmedCatalogCalls = await evaluate(`window.__catalogCalls`);
	assert(
		Object.values(warmedCatalogCalls).every((count) => count === 1),
		"Marketplace did not warm every catalog mode exactly once: " +
			JSON.stringify(warmedCatalogCalls),
	);
	await evaluate(
		`(() => { const tab = [...document.querySelectorAll('.ecosystem-page .tabs button')].find(button => button.textContent.trim().startsWith('Installed')); if (!tab) return false; tab.click(); return true; })()`,
	);
	await retry(async () =>
		evaluate(
			`location.pathname === '/installed' && document.querySelector('.page-host h1')?.textContent === 'Installed resources'`,
		),
	);
	const routeSettled = await evaluate(
		`({ sameDocument: !!window.__documentMarker, shell: window.__shellBefore === document.querySelector('.app-shell'), startup: !!document.querySelector('.startup-loading') })`,
	);
	assert(
		routeSettled.sameDocument && routeSettled.shell && !routeSettled.startup,
		"Marketplace navigation reloaded the application: " +
			JSON.stringify(routeSettled),
	);
	const installedCatalogCalls = await evaluate(`window.__catalogCalls`);
	assert(
		Object.values(installedCatalogCalls).every((count) => count === 1),
		"Installed navigation re-fetched a warmed catalog mode: " +
			JSON.stringify(installedCatalogCalls),
	);
	for (const tab of [
		{ label: "Updates", path: "/updates", heading: "Package updates" },
		{ label: "Local resources", path: "/local", heading: "Local resources" },
		{ label: "Discover", path: "/discover", heading: "Pi Catalog" },
	]) {
		await evaluate(
			`(() => { const tab = [...document.querySelectorAll('.ecosystem-page .tabs button')].find(button => button.textContent.trim().startsWith(${JSON.stringify(tab.label)})); if (!tab) return false; tab.click(); return true; })()`,
		);
		await retry(async () =>
			evaluate(
				`location.pathname === ${JSON.stringify(tab.path)} && document.querySelector('.page-host h1')?.textContent === ${JSON.stringify(tab.heading)}`,
			),
		);
		const warmedRoute = await evaluate(
			`({ sameDocument: !!window.__documentMarker, shell: window.__shellBefore === document.querySelector('.app-shell'), startup: !!document.querySelector('.startup-loading'), calls: window.__catalogCalls })`,
		);
		assert(
			warmedRoute.sameDocument && warmedRoute.shell && !warmedRoute.startup,
			`${tab.label} navigation reloaded the application: ` +
				JSON.stringify(warmedRoute),
		);
		assert(
			Object.values(warmedRoute.calls).every((count) => count === 1),
			`${tab.label} navigation re-fetched a warmed catalog mode: ` +
				JSON.stringify(warmedRoute.calls),
		);
	}
	await navigate("/", "OMP workspace");
	await retry(async () =>
		evaluate(
			`!!document.querySelector('[aria-label="Active model and effort"]')`,
		),
	);
	await evaluate(
		`document.querySelector('[aria-label="Active model and effort"]')?.click()`,
	);
	await retry(async () =>
		evaluate(`!!document.querySelector('.adaptive-effort-popover')`),
	);
	const effort = await evaluate(
		`(() => { const popover = document.querySelector('.adaptive-effort-popover'); const segments = [...popover.querySelectorAll('[role="radio"]')]; return { model: popover.querySelector('.current-model-header')?.innerText, labels: segments.map(button => button.innerText.trim()), selected: segments.find(button => button.getAttribute('aria-checked') === 'true')?.innerText, description: popover.querySelector('.effort-description')?.innerText, configurable: popover.querySelector('.adaptive-effort-selector')?.getAttribute('aria-disabled') }; })()`,
	);
	assert(
		effort.model.includes("GPT 5.6 Sol") &&
			effort.model.includes("OpenAI") &&
			effort.model.includes("Active"),
		"Current model header is incomplete: " + JSON.stringify(effort),
	);
	assert(
		JSON.stringify(effort.labels) ===
			JSON.stringify(["Low", "Medium", "High", "Xhigh", "Max"]) &&
			effort.selected.includes("High") &&
			effort.description.includes("level 3 of 5"),
		"Adaptive effort names and count do not match OMP metadata: " +
			JSON.stringify(effort),
	);
	await evaluate(
		`(() => { const current = document.querySelector('[role="radio"][aria-checked="true"]'); current.focus(); current.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); })()`,
	);
	await retry(async () =>
		evaluate(
			`document.querySelector('[role="radio"][aria-checked="true"]')?.innerText.includes('Xhigh')`,
		),
	);
	await evaluate(
		`[...document.querySelectorAll('.adaptive-effort-popover button')].find(button => button.textContent.includes('Change model')).click()`,
	);
	await retry(async () =>
		evaluate(`!!document.querySelector('.quick-model-picker')`),
	);
	const modelPicker = await evaluate(
		`(() => { const menu = document.querySelector('.quick-model-picker'); const options = [...menu.querySelectorAll('.model-select__option')]; const firstGroup = menu.querySelector('.model-select__group'); return { search: menu.querySelector('input')?.placeholder, filters: [...menu.querySelectorAll('.model-select__filters button')].map(button => button.textContent), optionCount: options.length, selected: options.some(option => option.getAttribute('aria-selected') === 'true'), firstProvider: firstGroup?.querySelector('h3')?.textContent, firstModel: options[0]?.querySelector('strong')?.textContent, anthropicModels: [...firstGroup?.querySelectorAll('.model-select__option strong') ?? []].map(node => node.textContent), footer: menu.querySelector('.model-select__footer button')?.textContent, footerPosition: getComputedStyle(menu.querySelector('.model-select__footer')).position, manage: menu.querySelector('.model-select__footer')?.innerText.includes('Manage models & roles') }; })()`,
	);
	assert(
		modelPicker.search === "Search models…" &&
			JSON.stringify(modelPicker.filters) ===
				JSON.stringify(["All", "Anthropic", "OpenAI", "DeepSeek", "Other"]),
		"Model search/provider filters are missing",
	);
	assert(
		modelPicker.optionCount <= 9 &&
			modelPicker.selected &&
			modelPicker.firstProvider === "Anthropic" &&
			modelPicker.firstModel === "Claude Fable 5" &&
			modelPicker.anthropicModels.includes("Claude Opus 4.8") &&
			modelPicker.anthropicModels.includes("Claude Haiku 4.5"),
		"Initial models do not preserve useful recent Anthropic families: " +
			JSON.stringify(modelPicker),
	);
	assert(
		modelPicker.footer?.includes("View all models (16)") &&
			modelPicker.footerPosition === "sticky" &&
			modelPicker.manage,
		"Sticky model footer or management link is missing",
	);
	await evaluate(
		`document.querySelector('.model-select__footer button').click()`,
	);
	const expandedModels = await evaluate(
		`({ options: document.querySelectorAll('.model-select__option').length, legacy: [...document.querySelectorAll('.model-select__group h4')].some(heading => heading.textContent === 'Legacy'), other: [...document.querySelectorAll('.model-select__group h3')].some(heading => heading.textContent === 'Ollama') })`,
	);
	assert(
		expandedModels.options === 16 &&
			expandedModels.legacy &&
			expandedModels.other,
		"Expanded provider groups or Legacy models are incomplete",
	);
	await evaluate(
		`(() => { const input = document.querySelector('[aria-label="Search models"]'); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(input, 'GPT 4.1'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
	);
	await retry(async () =>
		evaluate(`document.querySelectorAll('.model-select__option').length === 1`),
	);
	const searchedModel = await evaluate(
		`({ model: document.querySelector('.model-select__option strong')?.textContent, provider: document.querySelector('.model-select__group h3')?.textContent })`,
	);
	assert(
		searchedModel.model === "GPT 4.1" && searchedModel.provider === "OpenAI",
		"Model search did not preserve provider grouping",
	);
	await evaluate(`document.querySelector('.model-select__option').click()`);
	await retry(async () =>
		evaluate(
			`document.querySelector('.current-model-header')?.innerText.includes('GPT 4.1')`,
		),
	);
	const automaticEffort = await evaluate(
		`({ trigger: document.querySelector('[aria-label="Active model and effort"]')?.innerText, selected: document.querySelector('[role="radio"][aria-checked="true"]')?.innerText, disabled: document.querySelector('.adaptive-effort-selector')?.getAttribute('aria-disabled') })`,
	);
	assert(
		automaticEffort.trigger.includes("GPT 4.1") &&
			automaticEffort.selected.includes("Default") &&
			automaticEffort.disabled === "true",
		"A model without thinking metadata did not fall back to Default",
	);
	await evaluate(
		`[...document.querySelectorAll('.adaptive-effort-popover button')].find(button => button.textContent.includes('Change model')).click()`,
	);
	await retry(async () =>
		evaluate(`!!document.querySelector('.quick-model-picker')`),
	);
	await evaluate(
		`([...document.querySelectorAll('.model-select__filters button')].find(button => button.textContent === 'DeepSeek')).click()`,
	);
	await retry(async () =>
		evaluate(`document.querySelectorAll('.model-select__group').length === 1`),
	);
	const filteredModels = await evaluate(
		`({ provider: document.querySelector('.model-select__group h3')?.textContent, options: document.querySelectorAll('.model-select__option').length })`,
	);
	assert(
		filteredModels.provider === "DeepSeek" && filteredModels.options === 3,
		"Provider filtering did not isolate DeepSeek",
	);
	await evaluate(
		`([...document.querySelectorAll('.model-select__option')].find(button => button.innerText.includes('DeepSeek V4 Pro'))).click()`,
	);
	await retry(async () =>
		evaluate(
			`document.querySelector('.current-model-header')?.innerText.includes('DeepSeek V4 Pro')`,
		),
	);
	const deepSeekEffort = await evaluate(
		`({ labels: [...document.querySelectorAll('[role="radio"]')].map(button => button.innerText.trim()), count: document.querySelectorAll('[role="radio"]').length })`,
	);
	assert(
		deepSeekEffort.count === 2 &&
			JSON.stringify(deepSeekEffort.labels) === JSON.stringify(["High", "Max"]),
		"Effort count and names were not derived from the selected OMP model: " +
			JSON.stringify(deepSeekEffort),
	);
	const recentModels = await evaluate(
		`([...document.querySelectorAll('.recent-model-switcher button')].map(button => button.textContent))`,
	);
	assert(
		recentModels.includes("GPT 4.1") && recentModels.includes("GPT 5.6 Sol"),
		"Recent model shortcuts did not retain prior selections: " +
			JSON.stringify(recentModels),
	);
	await evaluate(
		`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
	);

	await navigate("/discover", "studio-tool");
	const catalog = await evaluate(
		`({ heading: document.querySelector('h1')?.textContent, marketplace: document.body.innerText.includes('Also searching studio-smoke'), overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth })`,
	);
	assert(
		catalog.heading === "Pi Catalog" &&
			catalog.marketplace &&
			!catalog.overflow,
		"Catalog contract failed",
	);
	const persistedPreferences = await evaluate(
		`({ recent: JSON.parse(localStorage.getItem('omp-studio:recent-models') || '[]'), effort: localStorage.getItem('omp-studio:thinking-level') })`,
	);
	assert(
		persistedPreferences.recent[0] === "openai-codex/gpt-5.6-sol" &&
			persistedPreferences.recent.includes("deepseek/deepseek-v4-pro") &&
			persistedPreferences.effort === "high",
		"Model and effort preferences were not persisted: " +
			JSON.stringify(persistedPreferences),
	);
	await evaluate(
		`localStorage.removeItem('omp-studio:recent-models'); localStorage.removeItem('omp-studio:thinking-level')`,
	);

	// Scenario 2 — starting a session pushes the selected model/thinking BEFORE any prompt, in order.
	await evaluate(`sessionStorage.setItem('onboarding', 'done')`);
	await navigate("/", "OMP workspace");
	await retry(async () =>
		evaluate(`!!document.querySelector('[aria-label="New session"]')`),
	);
	await evaluate(`window.__calls.length = 0; window.__holdSessionStart = true`);
	await evaluate(
		`(() => { const button = document.querySelector('[aria-label="New session"]'); if (!button) throw new Error('new session button missing'); button.click(); button.click(); button.click(); return true; })()`,
	);
	await retry(async () =>
		evaluate(`typeof window.__releaseSessionStart === 'function'`),
	);
	const pendingSessionStarts = await evaluate(
		`window.__calls.filter(call => call.command === 'start_session').length`,
	);
	assert(
		pendingSessionStarts === 1,
		"Repeated project clicks created duplicate sessions while OMP was starting",
	);
	await evaluate(
		`window.__holdSessionStart = false; window.__releaseSessionStart()`,
	);
	await retry(async () =>
		evaluate(
			`window.__calls.some(call => call.command === 'set_thinking_level')`,
		),
	);
	const newSessionUi = await evaluate(
		`({ title: document.querySelector('.topbar-context strong')?.textContent, active: document.querySelector('.session-row.is-active')?.textContent })`,
	);
	assert(
		newSessionUi.title === "New session" &&
			newSessionUi.active?.includes("New session"),
		"New session was not added to project history and selected: " +
			JSON.stringify(newSessionUi),
	);
	const order = await evaluate(
		`window.__calls.map(call => call.command).filter(command => ['start_session', 'set_model', 'set_thinking_level'].includes(command))`,
	);
	assert(
		JSON.stringify(order) ===
			JSON.stringify(["start_session", "set_model", "set_thinking_level"]),
		"Session start did not configure model/thinking in order: " +
			JSON.stringify(order),
	);
	const configArgs = await evaluate(
		`({ start: window.__calls.find(call => call.command === 'start_session')?.args, model: window.__calls.find(call => call.command === 'set_model')?.args, thinking: window.__calls.find(call => call.command === 'set_thinking_level')?.args, startBeforeModel: window.__calls.findIndex(call => call.command === 'start_session') < window.__calls.findIndex(call => call.command === 'set_model'), promptSent: window.__calls.some(call => call.command === 'send_prompt') })`,
	);
	assert(
		configArgs.start?.advisorEnabled === true,
		"start_session did not enable the native Advisor",
	);
	assert(
		configArgs.model?.model === "openai-codex/gpt-5.6-sol",
		"set_model did not receive the selected model",
	);
	assert(
		configArgs.thinking?.level === "high",
		"set_thinking_level did not receive the selected OMP value",
	);
	assert(
		configArgs.startBeforeModel && !configArgs.promptSent,
		"Configuration must precede any prompt after session start",
	);
	await evaluate(
		`window.__calls.length = 0; document.querySelector('[aria-label="Active model and effort"]').click()`,
	);
	await retry(async () =>
		evaluate(`!!document.querySelector('.adaptive-effort-popover')`),
	);
	await evaluate(
		`([...document.querySelectorAll('[role="radio"]')].find(button => button.innerText.trim() === 'Max')).click()`,
	);
	await retry(async () =>
		evaluate(
			`window.__calls.some(call => call.command === 'set_thinking_level' && call.args.level === 'max')`,
		),
	);
	const confirmedEffort = await evaluate(
		`({ trigger: document.querySelector('[aria-label="Active model and effort"]').innerText, selected: document.querySelector('[role="radio"][aria-checked="true"]')?.innerText })`,
	);
	assert(
		confirmedEffort.trigger.includes("Max") &&
			confirmedEffort.selected.includes("Max"),
		"Confirmed effort was not committed to the UI",
	);
	await evaluate(
		`window.__failThinkingOnce = true; ([...document.querySelectorAll('[role="radio"]')].find(button => button.innerText.trim() === 'High')).click()`,
	);
	await retry(async () =>
		evaluate(
			`document.querySelector('.model-effort-error')?.innerText.includes('OMP rejected effort')`,
		),
	);
	const rolledBackEffort = await evaluate(
		`({ trigger: document.querySelector('[aria-label="Active model and effort"]').innerText, selected: document.querySelector('[role="radio"][aria-checked="true"]')?.innerText, attempted: window.__calls.some(call => call.command === 'set_thinking_level' && call.args.level === 'high') })`,
	);
	assert(
		rolledBackEffort.trigger.includes("Max") &&
			rolledBackEffort.selected.includes("Max") &&
			rolledBackEffort.attempted,
		"Rejected effort did not roll back to the confirmed value",
	);
	await evaluate(
		`window.__calls.length = 0; window.__holdModel = true; [...document.querySelectorAll('.adaptive-effort-popover button')].find(button => button.textContent.includes('Change model')).click()`,
	);
	await retry(async () =>
		evaluate(`!!document.querySelector('.quick-model-picker')`),
	);
	await evaluate(
		`([...document.querySelectorAll('.model-select__option')].find(button => button.innerText.includes('Claude Fable 5'))).click()`,
	);
	await retry(async () =>
		evaluate(`typeof window.__releaseModel === 'function'`),
	);
	const pendingModel = await evaluate(
		`({ current: document.querySelector('.quick-model-picker__header')?.innerText, pending: !!document.querySelector('.model-select__option .spin') })`,
	);
	assert(
		pendingModel.current.includes("GPT 5.6 Sol") && pendingModel.pending,
		"Model changed visually before backend confirmation",
	);
	await evaluate(`window.__holdModel = false; window.__releaseModel()`);
	await retry(async () =>
		evaluate(
			`document.querySelector('.current-model-header')?.innerText.includes('Claude Fable 5')`,
		),
	);
	const modelChange = await evaluate(
		`({ order: window.__calls.map(call => call.command).filter(command => ['set_model', 'set_thinking_level'].includes(command)), model: window.__calls.find(call => call.command === 'set_model')?.args, effort: window.__calls.find(call => call.command === 'set_thinking_level')?.args, trigger: document.querySelector('[aria-label="Active model and effort"]')?.innerText })`,
	);
	assert(
		JSON.stringify(modelChange.order) ===
			JSON.stringify(["set_model", "set_thinking_level"]) &&
			modelChange.model?.model === "anthropic/claude-fable-5" &&
			modelChange.effort?.level === "max" &&
			modelChange.trigger.includes("Claude Fable 5"),
		"Confirmed model/effort change is inconsistent: " +
			JSON.stringify(modelChange),
	);
	await evaluate(
		`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
	);

	// Scenario 3 — an API-key-only provider never offers OAuth and persists after saving.
	await navigate("/providers", "Welcome to OMP Studio");
	await evaluate(
		`([...document.querySelectorAll('.provider-list > button')].find(row => row.innerText.includes('OpenAI API'))).click()`,
	);
	await retry(async () =>
		evaluate(`!!document.querySelector('.api-key-form input[type=password]')`),
	);
	const apiOnly = await evaluate(
		`({ signIn: [...document.querySelectorAll('.provider-card button')].some(button => button.innerText.includes('Sign in with')), keyUrl: document.querySelector('.api-key-link')?.getAttribute('href') })`,
	);
	assert(
		!apiOnly.signIn &&
			apiOnly.keyUrl === "https://platform.openai.com/api-keys",
		"API-only provider offered the wrong actions: " + JSON.stringify(apiOnly),
	);
	await evaluate(
		`(() => { const input = document.querySelector('.api-key-form input[type=password]'); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(input, 'sk-smoke-test-key'); input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
	);
	await retry(async () =>
		evaluate(
			`(() => { const save = [...document.querySelectorAll('.api-key-form button')].find(button => button.textContent.includes('Save API key')); return save && !save.disabled; })()`,
		),
	);
	await evaluate(
		`[...document.querySelectorAll('.api-key-form button')].find(button => button.textContent.includes('Save API key')).click()`,
	);
	await retry(async () =>
		evaluate(
			`document.querySelector('.provider-detail-pane')?.innerText.includes('● Logged in')`,
		),
	);
	const apiKey = await evaluate(
		`({ call: window.__calls.find(call => call.command === 'provider_api_key_login')?.args, badge: document.querySelector('.provider-detail-pane').innerText.includes('● Logged in') })`,
	);
	assert(
		apiKey.call?.providerId === "openai" &&
			apiKey.call?.apiKey === "sk-smoke-test-key",
		"provider_api_key_login received wrong arguments: " +
			JSON.stringify(apiKey.call),
	);
	assert(
		apiKey.badge,
		"Provider badge did not switch to logged in after API key save",
	);
	await navigate("/models", "Models & Roles");
	await navigate("/providers", "Welcome to OMP Studio");
	await evaluate(
		`([...document.querySelectorAll('.provider-list > button')].find(row => row.innerText.includes('OpenAI API'))).click()`,
	);
	await retry(async () =>
		evaluate(
			`document.querySelector('.provider-detail-pane')?.innerText.includes('● Logged in')`,
		),
	);
	const persisted = await evaluate(
		`document.querySelector('.provider-detail-pane').innerText.includes('● Logged in')`,
	);
	assert(
		persisted,
		"Connected provider badge did not persist across navigation",
	);

	// Scenario 4 — a sent prompt grows the thread while live text, tools, and Advisor cards arrive.
	await navigate("/", "OMP workspace");
	await retry(async () => evaluate(`!!window.__listeners['omp-frame']`));
	await evaluate(
		`(() => { const button = document.querySelector('[aria-label="New session"]'); if (!button) throw new Error('new session button missing'); button.click(); return true; })()`,
	);
	await retry(async () =>
		evaluate(
			`window.__calls.some(call => call.command === 'set_thinking_level')`,
		),
	);
	await retry(async () =>
		evaluate(
			`document.querySelector('.topbar-context strong')?.innerText === 'New session'`,
		),
	);
	await evaluate(`document.querySelector('[aria-label="Advisor"]').click()`);
	await retry(async () =>
		evaluate(
			`window.__calls.some(call => call.command === 'set_advisor_enabled' && call.args.enabled === false)`,
		),
	);
	await evaluate(`document.querySelector('[aria-label="Advisor"]').click()`);
	await retry(async () =>
		evaluate(
			`window.__calls.some(call => call.command === 'set_advisor_enabled' && call.args.enabled === true)`,
		),
	);
	// Composer control order is a stated layout contract: attach, model, Plan, Advisor — left to right.
	const controlOrder = await evaluate(
		`(() => { const left = sel => { const el = document.querySelector(sel); return el ? el.getBoundingClientRect().left : null; }; return { attach: left('.composer-attach-button'), model: left('.composer .model-effort-trigger'), plan: left('.plan-control'), advisor: left('.advisor-control'), planInTopbar: !!document.querySelector('.topbar .plan-control, .topbar-plan'), planToggle: !!document.querySelector('.plan-control [aria-label="Plan mode"]') }; })()`,
	);
	assert(
		controlOrder.attach !== null &&
			controlOrder.model !== null &&
			controlOrder.plan !== null &&
			controlOrder.advisor !== null,
		"A composer control is missing: " + JSON.stringify(controlOrder),
	);
	assert(
		controlOrder.attach < controlOrder.model,
		"The attach button is not left of the model picker: " +
			JSON.stringify(controlOrder),
	);
	assert(
		controlOrder.plan < controlOrder.advisor &&
			controlOrder.model < controlOrder.plan,
		"Plan is not between the model picker and Advisor: " +
			JSON.stringify(controlOrder),
	);
	assert(
		!controlOrder.planInTopbar && controlOrder.planToggle,
		"Plan did not move out of the top bar into the composer: " +
			JSON.stringify(controlOrder),
	);
	await evaluate(
		`(() => { const input = document.querySelector('.composer textarea'); const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(input, 'Live question'); input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
	);
	await evaluate(
		`document.querySelector('.composer-actions button:last-child').click()`,
	);
	await retry(async () =>
		evaluate(
			`window.__calls.some(call => call.command === 'send_prompt' && call.args.message === 'Live question')`,
		),
	);
	// The opening words are no longer a title: OMP publishes its own summary once the run settles.
	const beforeNaming = await evaluate(
		`({ title: document.querySelector('.topbar-context strong')?.textContent, renamed: window.__calls.some(call => call.command === 'set_session_title') })`,
	);
	assert(
		beforeNaming.title === "New session" && !beforeNaming.renamed,
		"The prompt prefix was still used as a session title: " +
			JSON.stringify(beforeNaming),
	);
	await retry(async () =>
		evaluate(
			`document.querySelector('.event-card--user')?.innerText.includes('Live question')`,
		),
	);
	await evaluate(`window.__ompEmit({ type: 'agent_start' })`);
	await evaluate(
		`window.__ompEmit({ type: 'message_start', message: { id: 'live-a', role: 'assistant', content: [{ type: 'thinking', thinking: '' }] } })`,
	);
	await evaluate(
		`window.__ompEmit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'pondering-internally' } })`,
	);
	await evaluate(
		`window.__ompEmit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'wrong-session' } }, 'other-session')`,
	);
	await evaluate(
		`window.__ompEmit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hel' } })`,
	);
	await evaluate(
		`window.__ompEmit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'lo' } })`,
	);
	await retry(async () =>
		evaluate(
			`document.querySelector('.event-card--assistant')?.innerText.includes('Hello')`,
		),
	);
	const streaming = await evaluate(
		`({ cards: document.querySelectorAll('.event-card--assistant').length, text: document.querySelector('.event-card--assistant').innerText, user: document.querySelector('.event-card--user')?.innerText, thinkingLeaked: document.body.innerText.includes('pondering-internally'), wrongSessionLeaked: document.body.innerText.includes('wrong-session') })`,
	);
	assert(
		streaming.cards === 1 && streaming.user.includes("Live question"),
		"Conversation did not grow from user to assistant",
	);
	assert(
		streaming.text.includes("Hello") &&
			!streaming.text.includes("HelHello") &&
			!streaming.text.includes("Hellolo"),
		"Assistant deltas did not accumulate cleanly: " +
			JSON.stringify(streaming.text),
	);
	assert(
		!streaming.thinkingLeaked && !streaming.wrongSessionLeaked,
		"Non-text or foreign-session deltas leaked into the conversation",
	);
	await evaluate(
		`window.__ompEmit({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'read', args: { path: 'src/App.tsx' } })`,
	);
	await retry(async () =>
		evaluate(
			`document.querySelector('.run-activity')?.innerText.includes('Reading App.tsx')`,
		),
	);
	await evaluate(
		`window.__ompEmit({ type: 'tool_execution_update', toolCallId: 'tool-1', toolName: 'read', partialResult: { content: [{ type: 'text', text: 'partial' }] } }); window.__ompEmit({ type: 'tool_execution_update', toolCallId: 'tool-1', toolName: 'read', partialResult: { content: [{ type: 'text', text: 'still running' }] } })`,
	);
	const updatedTool = await evaluate(
		`({ rows: document.querySelectorAll('.run-activity .tool-activity-row').length, toolCards: document.querySelectorAll('.event-card--tool').length })`,
	);
	assert(
		updatedTool.rows === 1 && updatedTool.toolCards === 0,
		"Tool updates created duplicate or root-level cards: " +
			JSON.stringify(updatedTool),
	);
	await evaluate(
		`window.__ompEmit({ type: 'tool_execution_end', toolCallId: 'tool-1', toolName: 'read', result: { content: [{ type: 'text', text: 'done' }] } })`,
	);
	await retry(async () =>
		evaluate(
			`document.querySelector('.tool-activity-row--completed')?.innerText.includes('done')`,
		),
	);
	await evaluate(`document.querySelector('.tool-activity-row__main').click()`);
	await retry(async () =>
		evaluate(
			`document.querySelector('.tool-activity-row__details')?.innerText.includes('done')`,
		),
	);
	await evaluate(
		`window.__ompEmit({ type: 'tool_execution_start', toolCallId: 'tool-failed', toolName: 'bash', args: { command: 'npm test' } }); window.__ompEmit({ type: 'tool_execution_end', toolCallId: 'tool-failed', toolName: 'bash', isError: true, error: 'npm test failed' })`,
	);
	await retry(async () =>
		evaluate(
			`document.querySelector('.tool-activity-row--failed')?.innerText.includes('npm test failed')`,
		),
	);
	await evaluate(
		`window.__ompEmit({ type: 'tool_execution_start', toolCallId: 'tool-pending', toolName: 'permission_request', args: { status: 'approval required' } })`,
	);
	await retry(async () =>
		evaluate(
			`document.querySelector('.tool-activity-row--running')?.innerText.includes('approval required') && document.querySelectorAll('.tool-activity-row--running').length === 1`,
		),
	);
	const pendingTool = await evaluate(
		`({ pending: document.querySelectorAll('.tool-activity-row--running').length, text: document.querySelector('.tool-activity-row--running')?.innerText })`,
	);
	assert(
		pendingTool.pending === 1 && pendingTool.text.includes("approval required"),
		"Pending tool confirmation was not surfaced: " +
			JSON.stringify(pendingTool),
	);
	await evaluate(
		`window.__ompEmit({ type: 'tool_execution_end', toolCallId: 'tool-pending', toolName: 'permission_request', cancelled: true, result: { content: [{ type: 'text', text: 'Permission denied' }] } })`,
	);
	await retry(async () =>
		evaluate(
			`document.querySelector('.tool-activity-row--cancelled')?.innerText.includes('Permission denied')`,
		),
	);
	const cancelledTool = await evaluate(
		`({ cancelled: document.querySelectorAll('.tool-activity-row--cancelled').length, text: document.querySelector('.tool-activity-row--cancelled')?.innerText })`,
	);
	assert(
		cancelledTool.cancelled === 1 &&
			cancelledTool.text.includes("Permission denied"),
		"Cancelled tool state was not kept visible: " +
			JSON.stringify(cancelledTool),
	);
	await evaluate(
		`window.__ompEmit({ type: 'message_end', message: { role: 'custom', customType: 'advisor', content: 'Stop before deleting', details: { notes: [{ note: 'Stop before deleting', severity: 'blocker', advisor: 'default' }] }, timestamp: Date.now() } })`,
	);
	await evaluate(
		String.raw`window.__ompEmit({ type: 'message_end', message: { id: 'live-a', role: 'assistant', content: [{ type: 'text', text: '## Final OMP response\n\n**Formatted answer**\n\n| Scope | Count |\n| --- | ---: |\n| Versioned | **39** |\n\n1. First check\n2. Second check\n\n- Cache excluded\n\n> Verified output' }], stopReason: 'stop' } })`,
	);
	await retry(async () =>
		evaluate(
			`document.querySelector('.event-card--advisor')?.innerText.includes('Stop before deleting') && document.querySelector('.event-card--assistant')?.innerText.includes('Final OMP response')`,
		),
	);
	const duringRun = await evaluate(
		`(() => { const markdown = document.querySelector('.event-card--assistant .markdown'); return { activities: document.querySelectorAll('.run-activity').length, rows: document.querySelectorAll('.run-activity .tool-activity-row').length, toolCards: document.querySelectorAll('.event-card--tool').length, advisor: document.querySelector('.event-card--advisor')?.innerText, final: document.querySelector('.event-card--assistant')?.innerText, markdown: { heading: markdown?.querySelector('h2')?.textContent, strong: markdown?.querySelector('strong')?.textContent, tableRows: markdown?.querySelectorAll('tbody tr').length, orderedItems: markdown?.querySelectorAll('ol li').length, unorderedItems: markdown?.querySelectorAll('ul li').length, quote: markdown?.querySelector('blockquote')?.textContent, rawMarkers: markdown?.innerText.includes('**') } }; })()`,
	);
	assert(
		duringRun.activities === 1 &&
			duringRun.rows === 3 &&
			duringRun.toolCards === 0,
		"Live tools were not grouped into one Activity block: " +
			JSON.stringify(duringRun),
	);
	assert(
		duringRun.advisor.includes("Blocker") &&
			duringRun.final.includes("Final OMP response"),
		"Advisor or final OMP response was not kept separate from Activity",
	);
	assert(
		duringRun.markdown.heading === "Final OMP response" &&
			duringRun.markdown.strong === "Formatted answer" &&
			duringRun.markdown.tableRows === 1 &&
			duringRun.markdown.orderedItems === 2 &&
			duringRun.markdown.unorderedItems === 1 &&
			duringRun.markdown.quote === "Verified output" &&
			!duringRun.markdown.rawMarkers,
		"Assistant Markdown was not rendered semantically: " +
			JSON.stringify(duringRun.markdown),
	);
	await evaluate(`window.__sessionName = 'Add image support to prompts'`);
	await evaluate(`window.__ompEmit({ type: 'agent_end', messages: [] })`);
	await retry(async () =>
		evaluate(
			`document.querySelector('.topbar-context strong')?.textContent === 'Add image support to prompts'`,
		),
	);
	const ompNamed = await evaluate(
		`({ title: document.querySelector('.topbar-context strong')?.textContent, renamed: window.__calls.some(call => call.command === 'set_session_title'), stored: window.__newSessionTitle })`,
	);
	assert(
		ompNamed.title === "Add image support to prompts" &&
			ompNamed.stored === "Add image support to prompts" &&
			!ompNamed.renamed,
		"The session did not adopt and persist the summary OMP generated: " +
			JSON.stringify(ompNamed),
	);
	await retry(async () => evaluate(`!document.querySelector('.run-activity')`));
	const finishedRun = await evaluate(
		`({ activities: document.querySelectorAll('.run-activity').length, advisor: document.querySelector('.event-card--advisor')?.innerText, final: document.querySelector('.event-card--assistant')?.innerText, completedBadges: [...document.querySelectorAll('.event-card--assistant .event-status')].filter(item => item.textContent === 'Completed').length })`,
	);
	assert(
		finishedRun.activities === 0 &&
			finishedRun.completedBadges === 0 &&
			finishedRun.advisor.includes("Stop before deleting") &&
			finishedRun.final.includes("Final OMP response"),
		"Activity was not removed cleanly after agent_end: " +
			JSON.stringify(finishedRun),
	);
	await evaluate(
		`(() => { const list = document.querySelector('.conversation-scroll'); list.scrollTop = list.scrollHeight; list.dispatchEvent(new Event('scroll')); for (let index = 0; index < 12; index += 1) window.__ompEmit({ type: 'tool_execution_end', toolCallId: 'scroll-' + index, toolName: 'read', result: { content: [{ type: 'text', text: 'Scrollable output ' + index + String.fromCharCode(10) + 'content '.repeat(40) }] } }); })()`,
	);
	await retry(async () =>
		evaluate(
			`(() => { const list = document.querySelector('.conversation-scroll'); return list && list.scrollHeight > list.clientHeight && list.scrollTop > 0 && list.scrollHeight - list.scrollTop - list.clientHeight < 96; })()`,
		),
	);
	const followedOutput = await evaluate(
		`(() => { const list = document.querySelector('.conversation-scroll'); return { viewport: innerHeight, host: document.querySelector('.page-host').clientHeight, workspace: document.querySelector('.workspace-page').clientHeight, column: list.parentElement.clientHeight, height: list.clientHeight, scrollHeight: list.scrollHeight, scrollTop: list.scrollTop }; })()`,
	);
	assert(
		followedOutput.scrollHeight > followedOutput.height &&
			followedOutput.scrollTop > 0,
		"Conversation did not become vertically scrollable or follow new output: " +
			JSON.stringify(followedOutput),
	);
	await evaluate(
		`(() => { const list = document.querySelector('.conversation-scroll'); list.scrollTop = 0; list.dispatchEvent(new Event('scroll')); window.__scrollHeightBefore = list.scrollHeight; window.__ompEmit({ type: 'tool_execution_end', toolCallId: 'manual-scroll', toolName: 'read', result: { content: [{ type: 'text', text: 'Manual scroll position must be preserved ' + 'content '.repeat(40) }] } }); })()`,
	);
	await retry(async () =>
		evaluate(
			`document.querySelector('.conversation-scroll').scrollHeight > window.__scrollHeightBefore`,
		),
	);
	await evaluate(
		`window.__ompEmit({ type: 'tool_execution_end', toolCallId: 'manual-scroll', toolName: 'read', result: { content: [{ type: 'text', text: 'Expanded manual-scroll output ' + 'content '.repeat(120) }] } })`,
	);
	await retry(async () =>
		evaluate(
			`document.body.innerText.includes('Expanded manual-scroll output')`,
		),
	);
	const manualScroll = await evaluate(
		`(() => { const list = document.querySelector('.conversation-scroll'); const items = [...list.querySelectorAll(':scope > .conversation-run > *')]; const rects = items.map(item => item.getBoundingClientRect()); return { scrollTop: list.scrollTop, items: rects.length, overlap: rects.some((rect, index) => index > 0 && rect.top < rects[index - 1].bottom - 0.5) }; })()`,
	);
	await evaluate(
		`(() => { const list = document.querySelector('.conversation-scroll'); list.scrollTop = list.scrollHeight; list.dispatchEvent(new Event('scroll')); window.__scrollHeightBefore = list.scrollHeight; window.__ompEmit({ type: 'tool_execution_end', toolCallId: 'resume-follow', toolName: 'read', result: { content: [{ type: 'text', text: 'Follow output resumed ' + 'content '.repeat(40) }] } }); })()`,
	);
	await retry(async () =>
		evaluate(
			`(() => { const list = document.querySelector('.conversation-scroll'); return list.scrollHeight > window.__scrollHeightBefore && list.scrollHeight - list.scrollTop - list.clientHeight < 96; })()`,
		),
	);
	assert(
		manualScroll.scrollTop === 0 && !manualScroll.overlap,
		"Incoming output moved or overlapped the manually scrolled conversation: " +
			JSON.stringify(manualScroll),
	);
	await evaluate(`window.__ompEmit({ type: 'agent_end', messages: [] })`);
	await retry(async () => evaluate(`!document.querySelector('.run-activity')`));
	await evaluate(
		`window.__ompEmit({ type: 'agent_start' }); window.__ompEmit({ type: 'message_start', message: { id: 'no-tool-a', role: 'assistant', content: [] } }); window.__ompEmit({ type: 'message_end', message: { id: 'no-tool-a', role: 'assistant', content: [{ type: 'text', text: 'No-tool response' }], stopReason: 'stop' } })`,
	);
	await retry(async () =>
		evaluate(
			`[...document.querySelectorAll('.event-card--assistant')].some(card => card.innerText.includes('No-tool response'))`,
		),
	);
	const noToolRun = await evaluate(
		`({ activities: document.querySelectorAll('.run-activity').length, activityText: [...document.querySelectorAll('.run-activity')].map(item => item.innerText), responses: [...document.querySelectorAll('.event-card--assistant')].filter(card => card.innerText.includes('No-tool response')).length })`,
	);
	assert(
		noToolRun.activities === 0 && noToolRun.responses === 1,
		"A run without tools rendered Activity or duplicated its response: " +
			JSON.stringify(noToolRun),
	);
	await evaluate(`window.__ompEmit({ type: 'agent_end', messages: [] })`);
	const noToolFinished = await evaluate(
		`({ activities: document.querySelectorAll('.run-activity').length, responses: [...document.querySelectorAll('.event-card--assistant')].filter(card => card.innerText.includes('No-tool response')).length })`,
	);
	assert(
		noToolFinished.activities === 0 && noToolFinished.responses === 1,
		"A no-tool run changed after agent_end: " + JSON.stringify(noToolFinished),
	);

	// Scenario 5 — selecting a stored session paints its transcript from the on-disk snapshot, then attaches the process behind it.
	await evaluate(
		`(() => { const button = [...document.querySelectorAll('.sidebar-sessions .session-row__open')].find(el => el.textContent.includes('Past session')); if (!button) throw new Error('past session button missing'); button.click(); return true; })()`,
	);
	await retry(async () =>
		evaluate(
			`document.body.innerText.includes('Historical answer') && document.body.innerText.includes('Native concern')`,
		),
	);
	// The transcript is already on screen above; the attach lands after it, so the probe waits for it.
	await retry(async () =>
		evaluate(
			`window.__calls.some(call => call.command === 'session_configuration' && call.args.sessionId === 'past-1')`,
		),
	);
	const restored = await evaluate(
		`(() => { const advisor = document.querySelector('.event-card--advisor'); const assistant = document.querySelector('.event-card--assistant'); const callIndex = command => window.__calls.findIndex(call => call.command === command && call.args.sessionId === 'past-1'); return { snapshot: callIndex('session_snapshot'), resumed: callIndex('resume_session'), state: callIndex('session_configuration'), title: document.querySelector('.topbar-context strong')?.textContent, trigger: document.querySelector('[aria-label="Active model and effort"]')?.innerText, users: document.querySelectorAll('.event-card--user').length, assistants: document.querySelectorAll('.event-card--assistant').length, advisors: document.querySelectorAll('.event-card--advisor').length, user: document.querySelector('.event-card--user')?.innerText, assistant: assistant?.innerText, advisor: advisor?.innerText, activity: document.querySelectorAll('.run-activity').length, toolCards: document.querySelectorAll('.event-card--tool').length, toolOutputLeaked: document.body.innerText.includes('Historical tool output'), advisorBeforeAssistant: advisor && assistant && advisor.getBoundingClientRect().top < assistant.getBoundingClientRect().top }; })()`,
	);
	assert(
		restored.snapshot >= 0 &&
			restored.trigger.includes("Claude Fable 5") &&
			restored.trigger.includes("Xhigh"),
		"Stored session did not restore its transcript, model, and effort",
	);
	assert(
		restored.resumed > restored.snapshot && restored.state > restored.snapshot,
		"The stored transcript did not paint before the background attach: " +
			JSON.stringify(restored),
	);
	assert(
		restored.title === "Add image support to prompts",
		"Resuming did not mirror the name OMP holds for the session: " +
			JSON.stringify(restored.title),
	);
	assert(
		restored.users === 1 &&
			restored.assistants === 1 &&
			restored.advisors === 1 &&
			restored.user.includes("Historical question") &&
			restored.assistant.includes("Historical answer"),
		"Stored conversation runs were duplicated or reconstructed incorrectly: " +
			JSON.stringify(restored),
	);
	assert(
		restored.advisor.includes("Concern") &&
			restored.advisor.includes("Native concern") &&
			restored.advisorBeforeAssistant,
		"Stored Advisor concern was not restored in chronological order",
	);
	assert(
		restored.activity === 0 &&
			restored.toolCards === 0 &&
			!restored.toolOutputLeaked,
		"Restored tool activity leaked into the completed conversation: " +
			JSON.stringify(restored),
	);

	// Scenario 6 — usage lists every provider account at once (no selector) and manual refresh bypasses caches.
	await navigate("/usage", "Usage & limits");
	await retry(async () =>
		evaluate(`document.querySelectorAll('.usage-account').length === 2`),
	);
	const usageOverview = await evaluate(
		`(() => { const blocks = [...document.querySelectorAll('.usage-account')]; return { count: blocks.length, selectorless: !document.querySelector('[aria-label="Usage account"]'), providers: blocks.map(block => block.querySelector('h2')?.textContent), orgs: blocks.map(block => block.querySelector('.usage-account__id small')?.textContent), limits: blocks.map(block => [...block.querySelectorAll('.usage-limit')].map(card => card.innerText)) }; })()`,
	);
	assert(
		usageOverview.count === 2 &&
			usageOverview.selectorless &&
			usageOverview.providers.includes("OpenAI Codex") &&
			usageOverview.providers.includes("Anthropic"),
		"Usage did not stack every provider account: " +
			JSON.stringify(usageOverview),
	);
	const usageLimits = usageOverview.limits.flat().join(" || ");
	assert(
		usageLimits.includes("96%") &&
			usageLimits.includes("Claude 5 Hour") &&
			usageLimits.includes("2%") &&
			usageLimits.includes("Claude 7 Day") &&
			usageLimits.includes("0%") &&
			usageOverview.orgs.includes("Example Organization"),
		"Provider limits were not all visible at once: " +
			JSON.stringify(usageOverview),
	);
	await evaluate(
		`window.__calls.length = 0; [...document.querySelectorAll('.usage-heading button')].find(button => button.textContent.includes('Refresh')).click()`,
	);
	await retry(async () =>
		evaluate(
			`window.__calls.some(call => call.command === 'usage_get_snapshot' && call.args.forceRefresh === true)`,
		),
	);
	const usageRefresh = await evaluate(
		`window.__calls.find(call => call.command === 'usage_get_snapshot')?.args`,
	);
	assert(
		usageRefresh.forceRefresh === true,
		"Manual usage refresh did not bypass caches: " +
			JSON.stringify(usageRefresh),
	);

	// Scenario 7 — a Hyprland-sized tile keeps navigation, controls, conversation, composer, and dropdowns inside the viewport.
	await send("Emulation.setDeviceMetricsOverride", {
		width: 940,
		height: 760,
		deviceScaleFactor: 1,
		mobile: false,
	});
	await navigate("/", "OMP workspace");
	await evaluate(
		`(() => { const button = document.querySelector('[aria-label="New session"]'); if (!button) throw new Error('responsive new session button missing'); button.click(); return true; })()`,
	);
	await retry(async () =>
		evaluate(
			`window.__calls.some(call => call.command === 'set_thinking_level')`,
		),
	);
	await evaluate(
		`window.__ompEmit({ type: 'message_start', message: { id: 'responsive-a', role: 'assistant', content: [] } }); window.__ompEmit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Long/uninterrupted/path/to/a/repository/file/that/must/remain/inside/the/tiled/conversation/window.tsx' } }); window.__ompEmit({ type: 'agent_start' })`,
	);
	await retry(async () =>
		evaluate(
			`document.querySelector('.event-card--assistant')?.innerText.includes('Long/uninterrupted')`,
		),
	);
	const responsive = await evaluate(
		`(() => { const box = selector => { const rect = document.querySelector(selector)?.getBoundingClientRect(); return rect && { left: rect.left, right: rect.right, width: rect.width, bottom: rect.bottom }; }; const rail = document.querySelector('.workspace-rail'); return { viewport: innerWidth, sidebar: box('.sidebar'), topbar: box('.topbar'), controls: box('.topbar-controls'), effort: box('.model-effort-trigger'), workspace: box('.workspace-page'), conversation: box('.conversation-column'), composer: box('.composer'), composerButtons: [...document.querySelectorAll('.composer-actions button')].map(button => button.getBoundingClientRect().right), labelsHidden: [...document.querySelectorAll('.sidebar .nav-item span')].every(label => getComputedStyle(label).display === 'none'), railHidden: !rail || getComputedStyle(rail).display === 'none', scrollWidth: document.documentElement.scrollWidth }; })()`,
	);
	assert(
		responsive.sidebar.width === 68 && responsive.labelsHidden,
		"Sidebar did not switch to compact navigation at 940px",
	);
	assert(
		responsive.topbar.right <= responsive.viewport &&
			responsive.controls.right <= responsive.viewport &&
			responsive.effort.right <= responsive.viewport,
		"Topbar controls overflowed the Hyprland tile",
	);
	assert(
		responsive.workspace.right <= responsive.viewport &&
			responsive.conversation.right <= responsive.viewport &&
			responsive.railHidden &&
			responsive.scrollWidth === responsive.viewport,
		"Central workspace did not shrink without horizontal overflow",
	);
	assert(
		responsive.composer.right <= responsive.viewport &&
			responsive.composerButtons.every((right) => right <= responsive.viewport),
		"Composer controls overflowed the tiled window",
	);
	await evaluate(
		`document.querySelector('[aria-label="Active model and effort"]')?.click()`,
	);
	await retry(async () =>
		evaluate(`!!document.querySelector('.adaptive-effort-popover')`),
	);
	const responsiveMenu = await evaluate(
		`(() => { const menu = document.querySelector('.adaptive-effort-popover').getBoundingClientRect(); const sidebar = document.querySelector('.sidebar').getBoundingClientRect(); return { left: menu.left, right: menu.right, bottom: menu.bottom, sidebarRight: sidebar.right, viewportWidth: innerWidth, viewportHeight: innerHeight }; })()`,
	);
	assert(
		responsiveMenu.left >= responsiveMenu.sidebarRight &&
			responsiveMenu.right <= responsiveMenu.viewportWidth &&
			responsiveMenu.bottom <= responsiveMenu.viewportHeight,
		"Adaptive effort popover escaped the tiled viewport",
	);
	await send("Emulation.setDeviceMetricsOverride", {
		width: 560,
		height: 700,
		deviceScaleFactor: 1,
		mobile: false,
	});
	const narrowPopover = await evaluate(
		`(() => { const popover = document.querySelector('.adaptive-effort-popover').getBoundingClientRect(); const segments = [...document.querySelectorAll('.effort-segment')].map(button => button.getBoundingClientRect()); return { left: popover.left, right: popover.right, bottom: popover.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight, vertical: segments.length > 1 && segments[1].top > segments[0].top && segments[1].left === segments[0].left, overflow: document.documentElement.scrollWidth > innerWidth }; })()`,
	);
	assert(
		narrowPopover.left >= 56 &&
			narrowPopover.right <= narrowPopover.viewportWidth &&
			narrowPopover.bottom <= narrowPopover.viewportHeight &&
			narrowPopover.vertical &&
			!narrowPopover.overflow,
		"Adaptive effort popover is not usable in the narrow tile: " +
			JSON.stringify(narrowPopover),
	);

	// Scenario 8 — the composer accepts clipboard images, ships them with the prompt, and releases them again.
	await send("Emulation.setDeviceMetricsOverride", {
		width: 1280,
		height: 800,
		deviceScaleFactor: 1,
		mobile: false,
	});
	await navigate("/", "OMP workspace");
	await evaluate(
		`(() => { const button = document.querySelector('[aria-label="New session"]'); if (!button) throw new Error('new session button missing'); button.click(); return true; })()`,
	);
	await retry(async () =>
		evaluate(
			`window.__calls.some(call => call.command === 'set_thinking_level')`,
		),
	);
	await evaluate(
		`window.__pasteImage = (type = 'image/png', name = 'shot.png') => { const file = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], name, { type }); const transfer = new DataTransfer(); transfer.items.add(file); const event = new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }); document.querySelector('.composer textarea').dispatchEvent(event); return event.defaultPrevented; }`,
	);
	const imagePasteHandled = await evaluate(`window.__pasteImage()`);
	assert(
		imagePasteHandled === true,
		"Clipboard image paste was not intercepted by the composer",
	);
	await retry(async () =>
		evaluate(
			`document.querySelectorAll('.composer-images .composer-image-thumb img').length === 1`,
		),
	);
	const textPasteHandled = await evaluate(
		`(() => { const transfer = new DataTransfer(); transfer.setData('text/plain', 'plain words'); const event = new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }); document.querySelector('.composer textarea').dispatchEvent(event); return event.defaultPrevented; })()`,
	);
	assert(
		textPasteHandled === false,
		"Text paste was swallowed by the image handler",
	);
	const imageOnlySendable = await evaluate(
		`!document.querySelector('.composer-send').disabled`,
	);
	assert(imageOnlySendable, "Send stayed disabled for an image-only prompt");
	await evaluate(
		`window.__calls.length = 0; document.querySelector('.composer-send').click()`,
	);
	await retry(async () =>
		evaluate(`window.__calls.some(call => call.command === 'send_prompt')`),
	);
	const imagePrompt = await evaluate(
		`(() => { const args = window.__calls.find(call => call.command === 'send_prompt')?.args; const image = args?.images?.[0]; return { message: args?.message, count: args?.images?.length, mediaType: image?.mediaType, prefix: (image?.dataUrl || '').slice(0, 22), fileName: image?.fileName }; })()`,
	);
	assert(
		imagePrompt.message === "" &&
			imagePrompt.count === 1 &&
			imagePrompt.mediaType === "image/png" &&
			imagePrompt.prefix === "data:image/png;base64," &&
			imagePrompt.fileName === "shot.png",
		"send_prompt did not carry the pasted image: " +
			JSON.stringify(imagePrompt),
	);
	await retry(async () =>
		evaluate(
			`document.querySelectorAll('.composer-images .composer-image-thumb').length === 0`,
		),
	);
	await retry(async () =>
		evaluate(
			`document.querySelectorAll('.event-card--user .event-images img').length === 1`,
		),
	);
	await evaluate(`window.__pasteImage('image/jpeg', 'photo.jpg')`);
	await retry(async () =>
		evaluate(`document.querySelectorAll('.composer-image-thumb').length === 1`),
	);
	await evaluate(`document.querySelector('.composer-image-remove').click()`);
	await retry(async () =>
		evaluate(`document.querySelectorAll('.composer-image-thumb').length === 0`),
	);
	const clearedSend = await evaluate(
		`document.querySelector('.composer-send').disabled`,
	);
	assert(
		clearedSend === true,
		"Send stayed enabled after the last attachment was removed",
	);

	// Scenario 9 — a stored session whose process refuses to attach still paints its transcript and names the outage.
	// An OMP that reports no name leaves the stored title alone.
	await evaluate(
		`window.__failResume = true; window.__sessionName = undefined`,
	);
	await retry(async () =>
		evaluate(
			`(() => { const button = [...document.querySelectorAll('.sidebar-sessions .session-row__open')].find(el => el.textContent.includes('Past session')); if (!button) return false; button.click(); return true; })()`,
		),
	);
	await retry(async () =>
		evaluate(`document.body.innerText.includes('Session offline')`),
	);
	const degraded = await evaluate(
		`({ title: document.querySelector('.topbar-context strong')?.textContent, transcript: document.body.innerText.includes('Historical answer'), notice: [...document.querySelectorAll('.event-card--error, .event-card--notice')].map(card => card.innerText).join(' || '), alert: document.querySelector('.sidebar-alert')?.innerText ?? '' })`,
	);
	assert(
		degraded.transcript,
		"A failed attach hid the stored conversation: " + JSON.stringify(degraded),
	);
	assert(
		degraded.notice.includes("Session offline"),
		"The unreachable process was not reported to the user: " +
			JSON.stringify(degraded),
	);
	assert(
		!degraded.alert.includes("Unable to resume session"),
		"Resume still reported the generic fallback: " + JSON.stringify(degraded),
	);
	assert(
		degraded.title === "Past session",
		"Session did not fall back to its stored name: " + JSON.stringify(degraded),
	);
	await evaluate(`window.__failResume = false`);

	// Scenario 10 — narration stays visible while the model works, then folds behind the final answer.
	await navigate("/", "OMP workspace");
	await evaluate(
		`(() => { const button = document.querySelector('[aria-label="New session"]'); if (!button) throw new Error('new session button missing'); button.click(); return true; })()`,
	);
	await retry(async () =>
		evaluate(
			`window.__calls.some(call => call.command === 'set_thinking_level')`,
		),
	);
	await evaluate(`window.__ompEmit({ type: 'agent_start' })`);
	for (const [id, text] of [
		["step-1", "Reading the manager"],
		["step-2", "Patching the assembler"],
	]) {
		await evaluate(
			`window.__ompEmit({ type: 'message_start', message: { id: '${id}', role: 'assistant', content: [] } }); window.__ompEmit({ type: 'message_end', message: { id: '${id}', role: 'assistant', content: [{ type: 'text', text: '${text}' }], stopReason: 'stop' } })`,
		);
	}
	await evaluate(
		`window.__ompEmit({ type: 'message_end', message: { role: 'custom', customType: 'advisor', content: 'Watch the frame cap', details: { notes: [{ note: 'Watch the frame cap', severity: 'nit', advisor: 'default' }] }, timestamp: Date.now() } })`,
	);
	await evaluate(
		`window.__ompEmit({ type: 'message_start', message: { id: 'final-a', role: 'assistant', content: [] } }); window.__ompEmit({ type: 'message_end', message: { id: 'final-a', role: 'assistant', content: [{ type: 'text', text: 'Here is the final answer' }], stopReason: 'stop' } })`,
	);
	await retry(async () =>
		evaluate(`document.body.innerText.includes('Here is the final answer')`),
	);
	const whileRunning = await evaluate(
		`({ cards: document.querySelectorAll('.event-card--assistant').length, toggle: !!document.querySelector('.run-intermediate-toggle'), narration: document.body.innerText.includes('Reading the manager') && document.body.innerText.includes('Patching the assembler') })`,
	);
	assert(
		whileRunning.cards === 3 && whileRunning.narration && !whileRunning.toggle,
		"Narration was hidden while the run was still live: " +
			JSON.stringify(whileRunning),
	);
	await evaluate(`window.__ompEmit({ type: 'agent_end', messages: [] })`);
	await retry(async () =>
		evaluate(`!!document.querySelector('.run-intermediate-toggle')`),
	);
	const whenDone = await evaluate(
		`({ cards: document.querySelectorAll('.event-card--assistant').length, toggle: document.querySelector('.run-intermediate-toggle')?.innerText ?? '', final: document.body.innerText.includes('Here is the final answer'), narration: document.body.innerText.includes('Reading the manager'), advisor: document.body.innerText.includes('Watch the frame cap') })`,
	);
	assert(
		whenDone.cards === 1 && whenDone.final && !whenDone.narration,
		"Intermediate messages survived the final answer: " +
			JSON.stringify(whenDone),
	);
	assert(
		whenDone.advisor,
		"Advisor notes were folded away with the narration: " +
			JSON.stringify(whenDone),
	);
	assert(
		whenDone.toggle.includes("2 intermediate messages"),
		"The reveal affordance did not count the folded messages: " +
			JSON.stringify(whenDone),
	);
	await evaluate(`document.querySelector('.run-intermediate-toggle').click()`);
	await retry(async () =>
		evaluate(`document.body.innerText.includes('Reading the manager')`),
	);
	const reopened = await evaluate(
		`({ cards: document.querySelectorAll('.event-card--assistant').length, toggle: document.querySelector('.run-intermediate-toggle')?.innerText ?? '' })`,
	);
	assert(
		reopened.cards === 3 && reopened.toggle.includes("Hide"),
		"Revealing the narration did not restore every message: " +
			JSON.stringify(reopened),
	);

	// Scenario 11 — slash commands wait for the process, not the session id, and a second click rides the attach already in flight.
	await navigate("/", "OMP workspace");
	// The reload is what makes this a cold open: nothing has fetched slash commands on this document.
	await retry(async () => evaluate(`!window.__sessionStarted`));
	await retry(async () =>
		evaluate(
			`(() => { const group = [...document.querySelectorAll('.project-group-row')].find(row => row.innerText.includes('Demo Project')); if (!group) return false; if (group.getAttribute('aria-expanded') !== 'true') group.click(); return true; })()`,
		),
	);
	await evaluate(`window.__calls.length = 0; window.__holdResume = true`);
	await retry(async () =>
		evaluate(
			`(() => { const button = [...document.querySelectorAll('.sidebar-sessions .session-row__open')].find(el => el.textContent.includes('Past session')); if (!button || button.disabled) return false; button.click(); return true; })()`,
		),
	);
	await retry(async () =>
		evaluate(`typeof window.__releaseResume === 'function'`),
	);
	await retry(async () =>
		evaluate(
			`document.body.innerText.includes('Historical answer') && !!document.querySelector('.composer-hint__connecting')`,
		),
	);
	await evaluate(
		`(() => { const input = document.querySelector('.composer textarea'); const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(input, '/'); input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
	);
	const connecting = await evaluate(
		`({ transcript: document.body.innerText.includes('Historical answer'), hint: !!document.querySelector('.composer-hint__connecting'), status: document.querySelector('.session-connection-status')?.innerText ?? '', suggestions: document.querySelectorAll('.slash-item').length, fetches: window.__calls.filter(call => call.command === 'available_commands').length, sendDisabled: document.querySelector('.composer-send').disabled })`,
	);
	assert(
		connecting.transcript && connecting.hint && connecting.status.includes('starting in the background') && connecting.sendDisabled,
		"A booting process did not paint the stored transcript behind a connecting composer: " +
			JSON.stringify(connecting),
	);
	assert(
		connecting.suggestions === 0 && connecting.fetches === 0,
		"Slash commands were requested from a session that has no process yet: " +
			JSON.stringify(connecting),
	);
	await retry(async () =>
		evaluate(
			`(() => { const button = [...document.querySelectorAll('.sidebar-sessions .session-row__open')].find(el => el.textContent.includes('Past session')); if (!button || button.disabled) return false; button.click(); return true; })()`,
		),
	);
	// The repaint proves the second click was handled: only the attach behind it may be skipped.
	await retry(async () =>
		evaluate(
			`window.__calls.filter(call => call.command === 'session_snapshot' && call.args.sessionId === 'past-1').length >= 2`,
		),
	);
	const reclicked = await evaluate(
		`({ resumes: window.__calls.filter(call => call.command === 'resume_session' && call.args.sessionId === 'past-1').length, hint: !!document.querySelector('.composer-hint__connecting') })`,
	);
	assert(
		reclicked.resumes === 1,
		"Reopening a connecting session started a second OMP process for it: " +
			JSON.stringify(reclicked),
	);
	assert(
		reclicked.hint,
		"The reused attach dropped the connecting state while it was still booting: " +
			JSON.stringify(reclicked),
	);
	await evaluate(`window.__holdResume = false; window.__releaseResume()`);
	await retry(async () =>
		evaluate(`!document.querySelector('.composer-hint__connecting')`),
	);
	await evaluate(
		`(() => { const input = document.querySelector('.composer textarea'); const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(input, '/'); input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
	);
	await retry(async () =>
		evaluate(`document.querySelectorAll('.slash-item').length > 0`),
	);
	const live = await evaluate(
		`({ connecting: !!document.querySelector('.composer-hint__connecting'), status: !!document.querySelector('.session-connection-status'), offline: !!document.querySelector('.composer-hint__offline'), menu: !!document.querySelector('.slash-menu'), suggestions: [...document.querySelectorAll('.slash-item strong')].map(item => item.textContent), resumes: window.__calls.filter(call => call.command === 'resume_session' && call.args.sessionId === 'past-1').length })`,
	);
	assert(
		live.menu &&
			live.suggestions.includes("/review") &&
			live.suggestions.includes("/advisor on"),
		"Slash commands never arrived once the attach landed: " +
			JSON.stringify(live),
	);
	assert(
		!live.connecting && !live.status && !live.offline && live.resumes === 1,
		"A session that attached once did not settle as live: " +
			JSON.stringify(live),
	);
	await evaluate(
		`(() => { const input = document.querySelector('.composer textarea'); const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(input, ''); input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
	);

	// Scenario 13 — the document paints dark before external CSS or JavaScript can load.
	await send("Network.enable");
	await send("Network.setBlockedURLs", { urls: ["*.css", "*.js"] });
	await send("Page.navigate", { url: `${origin}/` });
	await retry(async () =>
		evaluate(
			`document.readyState !== 'loading' && !!document.querySelector('#root')`,
		),
	);
	const earlyPaint = await evaluate(
		`(() => { const loader = document.querySelector('#startup-loader[role="status"]'); const rect = loader?.getBoundingClientRect(); const text = loader?.textContent ?? ''; return { html: getComputedStyle(document.documentElement).backgroundColor, body: getComputedStyle(document.body).backgroundColor, branded: text.includes('OMP Studio') && text.includes('Starting workspace…'), fillsViewport: !!rect && rect.width === innerWidth && rect.height === innerHeight, spinner: !!loader?.querySelector('.startup-loader__spinner') }; })()`,
	);
	assert(
		earlyPaint.html === "rgb(27, 27, 27)" &&
			earlyPaint.body === "rgb(27, 27, 27)" &&
			earlyPaint.branded &&
			earlyPaint.fillsViewport &&
			earlyPaint.spinner,
		"Document startup loader failed without assets: " +
			JSON.stringify(earlyPaint),
	);
	await send("Network.setBlockedURLs", { urls: [] });

	console.log(JSON.stringify({ scenarios: 13, assertions, status: "ok" }));
} finally {
	socket?.close();
	for (const process of [chromium, preview]) {
		try {
			process.kill("SIGTERM");
			process.kill("SIGKILL");
		} catch {}
	}
	try {
		process.kill(-chromium.pid, "SIGTERM");
	} catch {}
	try {
		process.kill(-preview.pid, "SIGTERM");
	} catch {}
	rmSync(profile, { recursive: true, force: true });
}
