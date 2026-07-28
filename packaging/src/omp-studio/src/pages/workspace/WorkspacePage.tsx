import { For, Show, createResource, createSignal, onCleanup, onMount } from 'solid-js';
import { listen } from '@tauri-apps/api/event';
import { Bot, Code2, FileCode2, GitBranch, MessageCircle, Send, Sparkles, Square } from 'lucide-solid';
import { activeProject, activeSession, appendConversation, conversation, rightPanelOpen, upsertConversation } from '../../stores/appStore';
import type { ConversationEvent } from '../../types';
import { Button, Dialog, Panel, VirtualList } from '../../components/ui';
import Markdown from '../../components/ui/Markdown';
import { studioApi } from '../../api/invoke';


const cardIcon = (kind: ConversationEvent['kind']) => kind === 'planner' ? <Code2 size={17} /> : kind === 'advisor' ? <Sparkles size={17} /> : kind === 'subagent' ? <Bot size={17} /> : <MessageCircle size={17} />;

function EventCard(props: { event: ConversationEvent }) {
  return <article class={`event-card event-card--${props.event.kind}`}><div class="event-avatar">{cardIcon(props.event.kind)}</div><div class="event-content"><header><strong>{props.event.title}</strong><time>{props.event.timestamp}</time>{props.event.status && <span class="event-status">{props.event.status}</span>}</header><Markdown source={props.event.body} /></div></article>;
}

function WorkspaceRightRail() {
  const projectPath = () => rightPanelOpen() ? activeProject()?.path : undefined;
  const [git] = createResource(projectPath, path => studioApi.git(path));
  const [github] = createResource(projectPath, path => studioApi.github(path));
  const [runtime] = createResource(() => rightPanelOpen(), open => open ? studioApi.runtimeStats() : undefined);
  const [inspection, setInspection] = createSignal<{ title: string; body: string }>();
  async function inspect(filePath: string, mode: 'file' | 'diff') {
    const project = projectPath(); if (!project) return;
    try { const body = mode === 'diff' ? await studioApi.diff(project, filePath) : await studioApi.readFile(project, filePath); setInspection({ title: `${mode === 'diff' ? 'Diff' : 'File'} · ${filePath}`, body: body || 'No unstaged diff.' }); }
    catch (error) { setInspection({ title: filePath, body: error instanceof Error ? error.message : 'Unable to inspect file' }); }
  }
  return <aside class="workspace-rail"><Panel title="Session"><div class="rail-body repository-summary"><dl><dt>Active session</dt><dd>{activeSession()?.title ?? 'None'}</dd><dt>OMP processes</dt><dd>{runtime()?.activeProcesses ?? 0}</dd></dl></div></Panel><Panel title="Repository"><Show when={activeProject()} fallback={<div class="rail-body">Open a project to load repository data.</div>}><div class="rail-body repository-summary"><a>{github()?.repository ?? activeProject()?.name}</a><dl><dt>Branch</dt><dd>{git()?.branch ?? 'Loading…'}</dd><dt>Status</dt><dd class={git()?.clean ? 'success' : ''}>{git()?.clean ? '● Clean' : `${git()?.changedFiles.length ?? 0} local changes`}</dd><dt>GitHub</dt><dd>{github()?.available ? 'Connected via gh' : 'Unavailable'}</dd><dt>Branches</dt><dd>{git()?.branches.length ?? 0}</dd><dt>Worktrees</dt><dd>{git()?.worktrees.length ?? 0}</dd><dt>Latest commit</dt><dd>{git()?.lastCommit ?? '—'}</dd></dl><Show when={github()?.pullRequest}><div class="event-status">{github()!.pullRequest}</div></Show></div></Show></Panel><Panel title="Pi ecosystem"><div class="rail-body recommendation"><div class="package-icon"><Sparkles size={20} /></div><div><strong>Package updates</strong><small>Review updates reported by OMP</small></div><Button variant="solid" tone="accent" onClick={() => location.assign('/updates')}>Updates</Button></div></Panel><Panel title="Branches & worktrees"><ul class="activity-list"><For each={git()?.branches ?? []}>{branch => <li><GitBranch size={14} />{branch}</li>}</For><For each={git()?.worktrees ?? []}>{worktree => <li><GitBranch size={14} />{worktree}</li>}</For></ul></Panel><Panel title="Changes"><div class="changes-list"><For each={git()?.changedFiles ?? []}>{file => <div><FileCode2 size={14} /><span>{file.path}</span><b>+{file.additions}</b><em>-{file.deletions}</em><button onClick={() => void inspect(file.path, 'diff')}>Diff</button><button onClick={() => void inspect(file.path, 'file')}>File</button></div>}</For></div></Panel><Dialog open={Boolean(inspection())} title={inspection()?.title ?? 'Inspection'} onClose={() => setInspection()}><pre class="file-inspector"><code>{inspection()?.body}</code></pre></Dialog></aside>;
}

export default function WorkspacePage() {
  const [draft, setDraft] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const events = () => conversation();
  const sessionId = () => activeSession()?.id;
  let unlisten: undefined | (() => void);

  function acceptFrame(payload: { raw?: Record<string, unknown> }) {
    const raw = payload.raw ?? {}; const type = String(raw.type ?? ''); const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (type === 'agent_start') { setBusy(true); return; }
    if (type === 'agent_end') { setBusy(false); return; }
    if (type === 'message_update') {
      const message = (raw.message && typeof raw.message === 'object' ? raw.message : {}) as Record<string, unknown>;
      const marker = JSON.stringify(raw.assistantMessageEvent ?? '').toLowerCase();
      const kind: ConversationEvent['kind'] = marker.includes('plan') ? 'planner' : marker.includes('advisor') ? 'advisor' : marker.includes('subagent') ? 'subagent' : 'assistant';
      const body = typeof message.text === 'string' ? message.text : typeof message.content === 'string' ? message.content : '';
      if (body) upsertConversation({ id: String(message.id ?? raw.id ?? 'assistant-stream'), kind, title: kind === 'assistant' ? 'OMP' : kind[0].toUpperCase() + kind.slice(1), body, status: 'Streaming', timestamp });
      return;
    }
    if (type.startsWith('tool_execution_')) {
      const id = `tool:${String(raw.toolCallId ?? raw.id ?? raw.tool ?? 'active')}`;
      const ended = type.endsWith('_end'); const failed = Boolean(raw.error);
      const body = [raw.tool, raw.path, raw.command, raw.message, raw.error].filter(value => typeof value === 'string').join(' · ') || 'OMP tool execution';
      upsertConversation({ id, kind: failed ? 'error' : 'tool', title: failed ? 'Tool error' : `Tool · ${String(raw.tool ?? 'OMP')}`, body, status: failed ? 'Failed' : ended ? 'Completed' : 'Running', timestamp });
    }
  }

  onMount(async () => { if ('__TAURI_INTERNALS__' in window) unlisten = await listen<{ raw?: Record<string, unknown> }>('omp-frame', event => acceptFrame(event.payload)); });
  onCleanup(() => unlisten?.());

  async function submit(mode: 'auto' | 'followup' = 'auto') {
    const message = draft().trim(); if (!message) return;
    const id = sessionId(); if (!id) { appendConversation({ id: crypto.randomUUID(), kind: 'error', title: 'OMP', body: 'Open a project and start a session before sending a prompt.', timestamp: 'now' }); return; }
    if (message === '/stop') { await studioApi.stopRun(id); setDraft(''); return; }
    appendConversation({ id: crypto.randomUUID(), kind: 'user', title: 'You', body: message, timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }); setDraft('');
    const wasBusy = busy(); if (!wasBusy) setBusy(true); try { if (mode === 'followup') await studioApi.followUpPrompt(id, message); else if (wasBusy) await studioApi.steerPrompt(id, message); else await studioApi.sendPrompt(id, message); } catch (error) { appendConversation({ id: crypto.randomUUID(), kind: 'error', title: 'OMP', body: error instanceof Error ? error.message : 'Unable to send message', timestamp: 'now' }); if (!wasBusy) setBusy(false); }
  }

  return <div class="workspace-page"><section class="conversation-column"><header class="conversation-header"><MessageCircle size={17} /><strong>{activeSession()?.title ?? 'OMP workspace'}</strong></header><Show when={events().length} fallback={<Panel class="empty-state">Open a project, then send a prompt to start a conversation.</Panel>}><VirtualList class="conversation-scroll" items={events()} estimateSize={188}>{event => <EventCard event={event} />}</VirtualList></Show><div class="composer"><textarea aria-label="Message" placeholder="Ask OMP Studio anything…" value={draft()} onInput={event => setDraft(event.currentTarget.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(); } }} /><Show when={draft().startsWith('/')}><div class="slash-menu"><strong>OMP command</strong><span>/stop · stop current run</span><span>Other slash commands are forwarded to OMP.</span></div></Show><div class="composer-toolbar"><div class="composer-actions"><Show when={busy()}><Button onClick={() => sessionId() && studioApi.stopRun(sessionId()!)}><Square size={15} />Stop</Button><Button onClick={() => void submit('followup')}>Follow up</Button></Show><Button variant="solid" tone="accent" onClick={() => void submit()}><Send size={16} />{busy() ? 'Steer' : 'Send'}</Button></div></div></div></section><Show when={rightPanelOpen()}><WorkspaceRightRail /></Show></div>;
}
