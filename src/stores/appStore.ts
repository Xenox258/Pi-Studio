import { createSignal } from 'solid-js';
import type { AdvisorMessageItem, AssistantMessageItem, ConversationNotice, ConversationRun, FileAttachment, ImageAttachment, OmpMessage, OmpModel, ProjectSummary, SessionSummary, ToolActivityStatus, UserMessageItem } from '../types';
import { studioApi } from '../api/invoke';
import { resolveEffortConfig } from '../models/effort';
import { createToolActivity, hasPendingToolConfirmation, reconstructConversationRuns, updateToolActivity } from '../models/conversation';

const recentModelStorageKey = 'omp-studio:recent-models';
const advisorStorageKey = 'omp-studio:advisor-enabled';
const thinkingStorageKey = 'omp-studio:thinking-level';
const maxRecentModels = 4;

function readStoredValue(key: string): string | undefined {
  if (typeof window === 'undefined') return;
  try { return window.localStorage.getItem(key) ?? undefined; } catch { return; }
}

function writeStoredValue(key: string, value: string) {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(key, value); } catch { /* preferences remain available for this run */ }
}

function loadRecentModelSelectors(): string[] {
  try {
    const stored = JSON.parse(readStoredValue(recentModelStorageKey) ?? '[]');
    return Array.isArray(stored) ? stored.filter((value): value is string => typeof value === 'string').slice(0, maxRecentModels) : [];
  } catch {
    return [];
  }
}

export const [planEnabled, setPlanEnabled] = createSignal(true);
export const [advisorEnabled, setAdvisorEnabled] = createSignal(readStoredValue(advisorStorageKey) !== 'false');
export const [availableModels, setAvailableModels] = createSignal<OmpModel[]>([]);
export const modelOptions = () => availableModels().map(model => ({ value: model.selector, label: `${model.name} · ${model.provider}` }));
export const [activeModel, setActiveModel] = createSignal('');
export const activeModelLabel = () => availableModels().find(model => model.selector === activeModel())?.name ?? activeModel();
export const [thinkingLevel, setThinkingLevel] = createSignal(readStoredValue(thinkingStorageKey) ?? 'high');
export const [recentModelSelectors, setRecentModelSelectors] = createSignal(loadRecentModelSelectors());
export const recentModels = () => recentModelSelectors().flatMap(selector => {
  const model = availableModels().find(candidate => candidate.selector === selector);
  return model ? [model] : [];
});

export function rememberModel(selector: string) {
  if (!selector) return;
  const next = [selector, ...recentModelSelectors().filter(value => value !== selector)].slice(0, maxRecentModels);
  setRecentModelSelectors(next);
  writeStoredValue(recentModelStorageKey, JSON.stringify(next));
}

export function setPreferredThinkingLevel(level: string) {
  setThinkingLevel(level);
  writeStoredValue(thinkingStorageKey, level);
}

export function selectPreferredModel(model: OmpModel) {
  setActiveModel(model.selector);
  rememberModel(model.selector);
  setPreferredThinkingLevel(resolveEffortConfig(model, thinkingLevel()).selectedValue);
}

export function applyModelCatalog(models: OmpModel[], preferredSelector?: string) {
  setAvailableModels(models);
  const selected = models.find(model => model.selector === preferredSelector) ?? models.find(model => model.selector === activeModel()) ?? models.find(model => model.selector === recentModelSelectors()[0]) ?? models[0];
  if (selected) selectPreferredModel(selected); else setActiveModel('');
}
export const [activeProject, setActiveProject] = createSignal<ProjectSummary | null>(null);
export const [activeSession, setActiveSession] = createSignal<SessionSummary | null>(null);
export const [conversationRuns, setConversationRuns] = createSignal<ConversationRun[]>([]);
export const [conversationNotices, setConversationNotices] = createSignal<ConversationNotice[]>([]);
export const [rightPanelOpen, setRightPanelOpen] = createSignal(true);
export const [sessionLoading, setSessionLoading] = createSignal(false);
export const [sessionConnecting, setSessionConnecting] = createSignal(false);
// A painted transcript is not a running process: prompts stay blocked until an attach reports one.
export const [sessionLive, setSessionLive] = createSignal(false);

// OMP summarizes the conversation into a session name of its own once it has seen enough of the
// exchange, so the app mirrors that instead of guessing a title from the opening words. Reading the
// configuration is what persists the name locally, so no rename has to be pushed back — doing that
// would tell OMP the title is user-owned and stop it from refining the name later.
export async function adoptOmpSessionTitle(sessionId: string) {
  const session = activeSession();
  if (!session || session.id !== sessionId) return;
  const title = (await studioApi.sessionConfiguration(sessionId).catch(() => undefined))?.sessionName;
  if (!title || title === session.title) return;
  setActiveSession(current => current?.id === sessionId ? { ...current, title, updatedAt: new Date().toISOString() } : current);
}

export async function changeWorkflowPlan(enabled: boolean) {
  const previous = planEnabled();
  setPlanEnabled(enabled);
  const id = activeSession()?.id;
  if (!id) return;
  try { await studioApi.setWorkflowMode(id, enabled ? 'plan' : 'build'); }
  catch (cause) { setPlanEnabled(previous); throw cause; }
}

export async function changeAdvisorEnabled(enabled: boolean) {
  const id = activeSession()?.id;
  if (id) await studioApi.setAdvisor(id, enabled);
  setAdvisorEnabled(enabled);
  writeStoredValue(advisorStorageKey, String(enabled));
}

export async function changeThinkingLevel(backendValue: string) {
  const id = activeSession()?.id;
  if (id) await studioApi.setThinking(id, backendValue);
  setPreferredThinkingLevel(backendValue);
}

export async function changeActiveModel(model: OmpModel) {
  if (model.selector === activeModel()) return;
  const previousModel = availableModels().find(candidate => candidate.selector === activeModel());
  const previousEffort = resolveEffortConfig(previousModel, thinkingLevel());
  const nextEffort = resolveEffortConfig(model, thinkingLevel());
  const id = activeSession()?.id;
  let modelConfirmed = false;
  try {
    if (id) {
      await studioApi.setModel(id, model.selector);
      modelConfirmed = true;
      const option = nextEffort.options.find(candidate => candidate.value === nextEffort.selectedValue);
      if (nextEffort.configurable && option) await studioApi.setThinking(id, option.backendValue);
    }
  } catch (cause) {
    if (id && modelConfirmed && previousModel) {
      try {
        await studioApi.setModel(id, previousModel.selector);
        const option = previousEffort.options.find(candidate => candidate.value === previousEffort.selectedValue);
        if (previousEffort.configurable && option) await studioApi.setThinking(id, option.backendValue);
      } catch {}
    }
    throw cause;
  }
  selectPreferredModel(model);
}

let conversationSequence = 0;

function displayTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.valueOf()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function latestRun(sessionId: string, runningOnly = false): ConversationRun | undefined {
  return conversationRuns().findLast(run => run.sessionId === sessionId && (!runningOnly || run.status === 'running'));
}

function updateRun(runId: string, update: (run: ConversationRun) => ConversationRun) {
  setConversationRuns(runs => runs.map(run => run.id === runId ? update(run) : run));
}

export function appendConversationNotice(title: string, body: string, kind: ConversationNotice['kind'] = 'error') {
  const now = new Date().toISOString();
  setConversationNotices(items => [...items, { id: crypto.randomUUID(), kind, title, body, timestamp: displayTime(now), sequence: conversationSequence++ }]);
}

export function startConversationRun(sessionId: string, body = '', images?: ImageAttachment[], files?: FileAttachment[]): string {
  const existing = latestRun(sessionId, true);
  if (existing) return existing.id;
  const now = new Date().toISOString();
  const runId = `run:${crypto.randomUUID()}`;
  const userMessage: UserMessageItem = { id: `${runId}:user`, kind: 'user', title: 'You', body, timestamp: displayTime(now), sequence: conversationSequence++, ...(images?.length ? { images } : {}), ...(files?.length ? { files } : {}) };
  const run: ConversationRun = { id: runId, sessionId, userMessage, activity: { id: `${runId}:activity`, runId, tools: [], expanded: true, autoCollapsed: false, hasErrors: false, hasPendingConfirmation: false, userOpenedDuringRun: false }, advisorMessages: [], assistantMessages: [], status: 'running', startedAt: now };
  setConversationRuns(runs => [...runs, run]);
  return runId;
}

export function handleAgentStart(sessionId: string) {
  startConversationRun(sessionId);
}

export function updateRunTool(sessionId: string, frame: Record<string, unknown>, eventType: string) {
  const runId = latestRun(sessionId, true)?.id ?? startConversationRun(sessionId);
  const toolName = String(frame.toolName ?? frame.tool ?? 'OMP');
  const toolId = `tool:${String(frame.toolCallId ?? frame.id ?? toolName)}`;
  const input = frame.args ?? frame.arguments ?? frame.input;
  const now = new Date().toISOString();
  const failed = frame.isError === true || Boolean(frame.error);
  const cancelled = frame.cancelled === true || frame.status === 'cancelled';
  const status: ToolActivityStatus = eventType === 'tool_execution_end' ? failed ? 'failed' : cancelled ? 'cancelled' : 'completed' : 'running';
  updateRun(runId, run => {
    const existing = run.activity.tools.find(tool => tool.id === toolId);
    const base = existing ?? createToolActivity(toolId, toolName, input, now);
    const tool = eventType === 'tool_execution_start' && !existing ? base : updateToolActivity(base, frame, status, eventType === 'tool_execution_end' ? now : undefined);
    const tools = existing ? run.activity.tools.map(item => item.id === toolId ? tool : item) : [...run.activity.tools, tool];
    return { ...run, activity: { ...run.activity, tools, hasErrors: tools.some(item => item.status === 'failed'), hasPendingConfirmation: tools.some(hasPendingToolConfirmation) } };
  });
}

export function appendRunAdvisor(sessionId: string, message: OmpMessage) {
  const run = latestRun(sessionId) ?? conversationRuns().findLast(item => item.sessionId === sessionId);
  const runId = run?.id ?? startConversationRun(sessionId);
  const details = message.details && typeof message.details === 'object' ? message.details as Record<string, unknown> : {};
  const notes = Array.isArray(details.notes) ? details.notes : [];
  const timestamp = displayTime(new Date(typeof message.timestamp === 'number' || typeof message.timestamp === 'string' ? message.timestamp : Date.now()).toISOString());
  const advisors: AdvisorMessageItem[] = notes.flatMap((entry, index) => {
    if (!entry || typeof entry !== 'object') return [];
    const note = entry as Record<string, unknown>;
    if (typeof note.note !== 'string') return [];
    const severity = note.severity === 'nit' || note.severity === 'concern' || note.severity === 'blocker' ? note.severity : undefined;
    const advisor = typeof note.advisor === 'string' && note.advisor !== 'default' ? ` · ${note.advisor}` : '';
    return [{ id: typeof message.id === 'string' ? `${message.id}:note:${index}` : `advisor:${runId}:${conversationSequence}`, kind: 'advisor' as const, title: `Advisor${advisor}`, body: note.note, severity, timestamp, sequence: conversationSequence++ }];
  });
  const fallback = typeof message.content === 'string' ? message.content : '';
  if (!advisors.length && fallback) advisors.push({ id: typeof message.id === 'string' ? message.id : `advisor:${runId}:${conversationSequence}`, kind: 'advisor', title: 'Advisor', body: fallback, timestamp, sequence: conversationSequence++ });
  updateRun(runId, current => ({ ...current, advisorMessages: [...current.advisorMessages, ...advisors] }));
}

export function upsertRunAssistant(sessionId: string, message: Omit<AssistantMessageItem, 'sequence'>) {
  const runId = latestRun(sessionId, true)?.id ?? latestRun(sessionId)?.id ?? startConversationRun(sessionId);
  updateRun(runId, run => {
    const existing = run.assistantMessages.find(item => item.id === message.id);
    const next: AssistantMessageItem = { ...message, sequence: existing?.sequence ?? conversationSequence++ };
    return { ...run, assistantMessages: existing ? run.assistantMessages.map(item => item.id === message.id ? next : item) : [...run.assistantMessages, next] };
  });
}

export function completeConversationRun(sessionId: string, status: ConversationRun['status'] = 'completed') {
  const run = latestRun(sessionId, true);
  if (!run) return;
  const now = new Date().toISOString();
  updateRun(run.id, current => {
    const tools = current.activity.tools.map(tool => tool.status === 'running' || tool.status === 'queued' ? { ...tool, status: 'cancelled' as const, completedAt: now, important: true, summary: tool.summary ?? 'Interrupted before completion' } : tool);
    const hasErrors = tools.some(tool => tool.status === 'failed');
    const hasPendingConfirmation = tools.some(hasPendingToolConfirmation);
    return { ...current, status, completedAt: now, activity: { ...current.activity, tools, hasErrors, hasPendingConfirmation, expanded: false, autoCollapsed: true } };
  });
}

export function setRunActivityExpanded(runId: string, expanded: boolean) {
  updateRun(runId, run => ({ ...run, activity: { ...run.activity, expanded, autoCollapsed: false, userOpenedDuringRun: run.activity.userOpenedDuringRun || (run.status === 'running' && expanded) } }));
}

export function restoreConversation(messages: OmpMessage[], sessionId: string) {
  const runs = reconstructConversationRuns(messages, sessionId, activeModelLabel() || 'Assistant');
  conversationSequence = runs.reduce((total, run) => total + 1 + run.advisorMessages.length + run.assistantMessages.length, 0);
  setConversationRuns(runs);
  setConversationNotices([]);
}

export async function resumeStoredSession(session: SessionSummary): Promise<ProjectSummary> {
  setSessionLoading(true);
  try {
    // Booting OMP costs tens of seconds once extensions load, and none of that is needed to read
    // what was already said: the stored transcript holds the whole conversation, so the session
    // paints from a single disk read.
    const snapshot = await studioApi.sessionSnapshot(session.id);
    const storedModel = availableModels().find(model => model.selector === snapshot.model);
    if (storedModel) { setActiveModel(storedModel.selector); rememberModel(storedModel.selector); }
    if (snapshot.thinkingLevel) setPreferredThinkingLevel(resolveEffortConfig(storedModel, snapshot.thinkingLevel).selectedValue);
    // Both indicators move before the session shows: the composer reads no process plus no attach as
    // offline, so a paint landing ahead of the attach would flash that hint for a frame.
    setSessionLive(false);
    setSessionConnecting(true);
    setActiveProject(snapshot.project);
    setActiveSession({ ...session, active: true, title: snapshot.title ?? session.title });
    restoreConversation(snapshot.messages, session.id);
    // Unawaited on purpose: the process only decides when the next prompt can be sent, so the
    // loading window closes here with the transcript already on screen.
    void attachStoredSession(session);
    return snapshot.project;
  } finally {
    setSessionLoading(false);
  }
}

// Every selection owns the visible indicator, while repeated selections of one boot share its RPC.
let attachSequence = 0;
const pendingSessionAttaches = new Map<string, Promise<void>>();

function resumeSessionOnce(session: SessionSummary): Promise<void> {
  const existing = pendingSessionAttaches.get(session.id);
  if (existing) return existing;
  const pending = studioApi.resumeSession(session.id, advisorEnabled()).then(() => undefined);
  pendingSessionAttaches.set(session.id, pending);
  const clearPending = () => { if (pendingSessionAttaches.get(session.id) === pending) pendingSessionAttaches.delete(session.id); };
  pending.then(clearPending, clearPending);
  return pending;
}

async function attachStoredSession(session: SessionSummary) {
  const attach = ++attachSequence;
  setSessionConnecting(true);
  try {
    await resumeSessionOnce(session);
    // A superseded selection can finish late, but only the latest selection may mutate visible state.
    if (attach !== attachSequence || activeSession()?.id !== session.id) return;
    setSessionLive(true);
    try {
      // The running process outranks the transcript, and reading its configuration is also what
      // mirrors OMP's own session name into stored history.
      const configuration = await studioApi.sessionConfiguration(session.id);
      if (attach !== attachSequence || activeSession()?.id !== session.id) return;
      const runtimeModel = availableModels().find(model => model.selector === configuration.model);
      if (runtimeModel) { setActiveModel(runtimeModel.selector); rememberModel(runtimeModel.selector); }
      if (configuration.thinkingLevel) setPreferredThinkingLevel(resolveEffortConfig(runtimeModel, configuration.thinkingLevel).selectedValue);
      const title = configuration.sessionName;
      if (title) setActiveSession(current => current?.id === session.id ? { ...current, title } : current);
    } catch {
      if (attach === attachSequence && activeSession()?.id === session.id) appendConversationNotice('Session settings unavailable', 'OMP did not report the stored model and effort for this session, so the current selection stays active.');
    }
  } catch (error) {
    if (attach === attachSequence && activeSession()?.id === session.id) { setSessionLive(false); appendConversationNotice('Session offline', `${error instanceof Error ? error.message : 'OMP could not be reached'}. The conversation above is complete, but new prompts cannot be sent until OMP is reachable — click the session again in the sidebar to retry.`); }
  } finally {
    if (attach === attachSequence) setSessionConnecting(false);
  }
}

export function clearWorkspace() {
  setActiveSession(null);
  setSessionLive(false);
  setConversationRuns([]);
  setConversationNotices([]);
}

// Session startup is intentionally single-flight: OMP can take a few seconds to become ready, and
// repeated clicks during that window must resolve to the same persisted session.
let pendingSessionStart: { projectPath: string; promise: Promise<ProjectSummary> } | undefined;

export function startConfiguredSession(projectPath: string): Promise<ProjectSummary> {
  if (pendingSessionStart) {
    if (pendingSessionStart.projectPath === projectPath) return pendingSessionStart.promise;
    return pendingSessionStart.promise.then(() => startConfiguredSession(projectPath));
  }
  const promise = bootConfiguredSession(projectPath);
  pendingSessionStart = { projectPath, promise };
  const clearPending = () => { if (pendingSessionStart?.promise === promise) pendingSessionStart = undefined; };
  promise.then(clearPending, clearPending);
  return promise;
}

export async function createAndStartProject(parentPath: string, name: string): Promise<ProjectSummary> {
  const created = await studioApi.createProject(parentPath, name);
  return startConfiguredSession(created.path);
}

async function bootConfiguredSession(projectPath: string): Promise<ProjectSummary> {
  setSessionLoading(true);
  try {
    const opened = await studioApi.openProject(projectPath);
    const id = await studioApi.startSession(opened.id, opened.path, advisorEnabled());
    try {
      const model = availableModels().find(candidate => candidate.selector === activeModel());
      if (model) await studioApi.setModel(id, model.selector);
      const effort = resolveEffortConfig(model, thinkingLevel());
      const option = effort.options.find(candidate => candidate.value === effort.selectedValue);
      if (effort.configurable && option) await studioApi.setThinking(id, option.backendValue);
    } catch (configError) {
      await studioApi.stopSession(id);
      throw configError;
    }
    setActiveProject(opened);
    setActiveSession({ id, title: 'New session', projectId: opened.id, updatedAt: new Date().toISOString(), active: true });
    setConversationRuns([]); setConversationNotices([]);
    // Starting a session only resolves once OMP reports ready, so this one can take prompts.
    setSessionLive(true);
    return opened;
  } catch (error) {
    setSessionLive(false);
    throw error;
  } finally {
    setSessionLoading(false);
  }
}
