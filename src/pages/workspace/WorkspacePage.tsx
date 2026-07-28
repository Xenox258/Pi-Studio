import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup, onMount } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { AlertCircle, ArrowUp, Bot, ChevronDown, ChevronRight, ClipboardList, FileCode2, FileText, FolderOpen, FolderPlus, GitBranch, Loader2, Paperclip, ShieldCheck, Sparkles, Square, User, X } from 'lucide-solid';
import { activeModel, activeModelLabel, activeProject, activeSession, adoptOmpSessionTitle, advisorEnabled, appendConversationNotice, appendRunAdvisor, availableModels, changeActiveModel, changeAdvisorEnabled, changeThinkingLevel, changeWorkflowPlan, completeConversationRun, conversationNotices, conversationRuns, createAndStartProject, handleAgentStart, planEnabled, recentModels, rightPanelOpen, sessionConnecting, sessionLive, sessionLoading, startConfiguredSession, startConversationRun, thinkingLevel, updateRunTool, upsertRunAssistant } from '../../stores/appStore';
import type { ConversationMessageItem, ConversationNotice, ConversationRun, FileAttachment, ImageAttachment, OmpFramePayload, OmpMessage } from '../../types';
import { Button, Dialog, Panel, Toggle } from '../../components/ui';
import Markdown from '../../components/ui/Markdown';
import AdaptiveEffortPopover from '../../components/models/AdaptiveEffortPopover';
import { studioApi } from '../../api/invoke';
import RunActivityCard from '../../components/conversation/RunActivityCard';


const cardIcon = (kind: ConversationMessageItem['kind'] | ConversationNotice['kind']) => {
  switch (kind) {
    case 'user': return <User size={17} />;
    case 'advisor': return <ShieldCheck size={17} />;
    case 'error': return <AlertCircle size={17} />;
    default: return <Bot size={17} />;
  }
};

function EventCard(props: { event: ConversationMessageItem | ConversationNotice }) {
  const status = () => props.event.kind === 'advisor' && props.event.severity ? props.event.severity[0].toUpperCase() + props.event.severity.slice(1) : 'status' in props.event ? props.event.status : undefined;
  const images = () => props.event.kind === 'user' ? (props.event as ConversationMessageItem & { images?: ImageAttachment[] }).images : undefined;
  const files = () => props.event.kind === 'user' ? (props.event as ConversationMessageItem & { files?: FileAttachment[] }).files : undefined;
  return <article class={`event-card event-card--${props.event.kind}`}><div class="event-avatar">{cardIcon(props.event.kind)}</div><div class="event-content"><header><strong>{props.event.title}</strong><time>{props.event.timestamp}</time>{status() && <span class="event-status">{status()}</span>}</header><Show when={images()?.length}><div class="event-images"><For each={images()!}>{img => <div class="event-image-thumb"><img src={img.dataUrl} alt={img.fileName ?? ''} /></div>}</For></div></Show><Show when={files()?.length}><div class="event-files"><For each={files()!}>{file => <span class="event-file-chip" title={file.path}><FileText size={13} />{file.fileName}</span>}</For></div></Show><Markdown source={props.event.body} /></div></article>;
}

function RunThread(props: { run: ConversationRun }) {
  const [showIntermediate, setShowIntermediate] = createSignal(false);
  const messages = () => [...props.run.advisorMessages, ...props.run.assistantMessages].sort((left, right) => left.sequence - right.sequence);
  // While the run is live every line is the newest thing the model said, so all of them matter. Once
  // it settles only the closing answer does — the narration in between becomes scrollback noise.
  // Advisor notes and errors are never folded away: they outlive the run that produced them.
  const finalAnswerId = () => props.run.status === 'running' ? undefined : props.run.assistantMessages.findLast(message => message.kind === 'assistant')?.id;
  const isIntermediate = (message: ConversationMessageItem) => message.kind === 'assistant' && finalAnswerId() !== undefined && message.id !== finalAnswerId();
  const intermediateCount = () => messages().filter(isIntermediate).length;
  const visibleMessages = () => showIntermediate() ? messages() : messages().filter(message => !isIntermediate(message));
  return <section class="conversation-run"><Show when={props.run.userMessage.body || props.run.userMessage.images?.length || props.run.userMessage.files?.length}><EventCard event={props.run.userMessage} /></Show><RunActivityCard run={props.run} /><Show when={intermediateCount() > 0}><button type="button" class="run-intermediate-toggle" aria-expanded={showIntermediate()} onClick={() => setShowIntermediate(value => !value)}>{showIntermediate() ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<span>{showIntermediate() ? 'Hide' : 'Show'} {intermediateCount()} intermediate {intermediateCount() === 1 ? 'message' : 'messages'}</span></button></Show><For each={visibleMessages()}>{message => <EventCard event={message} />}</For></section>;
}

function ConversationFeed(props: { runs: ConversationRun[]; notices: ConversationNotice[] }) {
  let viewport!: HTMLDivElement;
  let animationFrame = 0;
  let followingOutput = true;

  function updateFollowingOutput() {
    followingOutput = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 64;
  }

  createEffect(() => {
    const runs = props.runs;
    const lastRun = runs[runs.length - 1];
    const lastMessage = lastRun?.assistantMessages.at(-1) ?? lastRun?.advisorMessages.at(-1);
    const lastTool = lastRun?.activity.tools.at(-1);
    const contentVersion = `${runs.length}:${props.notices.length}:${lastMessage?.body.length ?? 0}:${lastTool?.summary?.length ?? 0}:${lastRun?.activity.expanded ?? false}`;
    if (!contentVersion || (!lastRun && !props.notices.length) || !followingOutput) return;
    cancelAnimationFrame(animationFrame);
    animationFrame = requestAnimationFrame(() => { viewport.scrollTop = viewport.scrollHeight; });
  });
  onCleanup(() => cancelAnimationFrame(animationFrame));

  return <div ref={viewport} class="conversation-scroll" onScroll={updateFollowingOutput}><For each={props.runs}>{run => <RunThread run={run} />}</For><For each={props.notices}>{notice => <EventCard event={notice} />}</For></div>;
}

function WorkspaceRightRail() {
  const navigate = useNavigate();
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
  return <aside class="workspace-rail"><Panel title="Session"><div class="rail-body repository-summary"><dl><dt>Active session</dt><dd>{activeSession()?.title ?? 'None'}</dd><dt>OMP processes</dt><dd>{runtime()?.activeProcesses ?? 0}</dd></dl></div></Panel><Panel title="Repository"><Show when={activeProject()} fallback={<div class="rail-body">Open a project to load repository data.</div>}><div class="rail-body repository-summary"><a>{github()?.repository ?? activeProject()?.name}</a><dl><dt>Branch</dt><dd>{git()?.branch ?? 'Loading…'}</dd><dt>Status</dt><dd class={git()?.clean ? 'success' : ''}>{git()?.clean ? '● Clean' : `${git()?.changedFiles.length ?? 0} local changes`}</dd><dt>GitHub</dt><dd>{github()?.available ? 'Connected via gh' : 'Unavailable'}</dd><dt>Branches</dt><dd>{git()?.branches.length ?? 0}</dd><dt>Worktrees</dt><dd>{git()?.worktrees.length ?? 0}</dd><dt>Latest commit</dt><dd>{git()?.lastCommit ?? '—'}</dd></dl><Show when={github()?.pullRequest}><div class="event-status">{github()!.pullRequest}</div></Show></div></Show></Panel><Panel title="Pi ecosystem"><div class="rail-body recommendation"><div class="package-icon"><Sparkles size={20} /></div><div><strong>Package updates</strong><small>Review updates reported by OMP</small></div><Button variant="solid" tone="accent" onClick={() => navigate('/updates')}>Updates</Button></div></Panel><Panel title="Branches & worktrees"><ul class="activity-list"><For each={git()?.branches ?? []}>{branch => <li><GitBranch size={14} />{branch}</li>}</For><For each={git()?.worktrees ?? []}>{worktree => <li><GitBranch size={14} />{worktree}</li>}</For></ul></Panel><Panel title="Changes"><div class="changes-list"><For each={git()?.changedFiles ?? []}>{file => <div><FileCode2 size={14} /><span>{file.path}</span><b>+{file.additions}</b><em>-{file.deletions}</em><button onClick={() => void inspect(file.path, 'diff')}>Diff</button><button onClick={() => void inspect(file.path, 'file')}>File</button></div>}</For></div></Panel><Dialog open={Boolean(inspection())} title={inspection()?.title ?? 'Inspection'} onClose={() => setInspection()}><pre class="file-inspector"><code>{inspection()?.body}</code></pre></Dialog></aside>;
}

function extractText(message: Record<string, unknown>): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content.flatMap(entry => {
    if (!entry || typeof entry !== 'object') return [];
    const block = entry as Record<string, unknown>;
    return block.type === 'text' && typeof block.text === 'string' ? [block.text] : [];
  }).join('\n');
}


export default function WorkspacePage() {
  const [draft, setDraft] = createSignal('');
  const [draftImages, setDraftImages] = createSignal<ImageAttachment[]>([]);
  const [draftFiles, setDraftFiles] = createSignal<FileAttachment[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [advisorPending, setAdvisorPending] = createSignal(false);
  const [planPending, setPlanPending] = createSignal(false);
  const [projectPending, setProjectPending] = createSignal(false);
  const [newProjectParent, setNewProjectParent] = createSignal('');
  const [newProjectName, setNewProjectName] = createSignal('');
  const runs = () => conversationRuns();
  const sessionId = () => activeSession()?.id;
  // A stored session whose background attach failed: it has an id and a transcript, but no process to prompt.
  const sessionOffline = () => Boolean(activeSession()) && !sessionConnecting() && !sessionLive();
  const assistantName = () => activeModelLabel() || 'Assistant';
  let composerInput: HTMLTextAreaElement | undefined;
  let filePickerInput: HTMLInputElement | undefined;
  // The id lands with the stored transcript tens of seconds before OMP can answer, so key the fetch on liveness: an undefined source waits for the attach instead of failing once.
  const [slashCommands] = createResource(() => sessionLive() ? sessionId() : undefined, id => '__TAURI_INTERNALS__' in window ? studioApi.availableCommands(id) : Promise.resolve([]));
  const [slashIndex, setSlashIndex] = createSignal(0);
  const [slashDismissed, setSlashDismissed] = createSignal(false);
  const slashOptions = createMemo(() => (slashCommands() ?? []).flatMap(command => [
    { command: `/${command.name}`, description: command.description ?? '' },
    ...(command.subcommands ?? []).map(sub => ({ command: `/${command.name} ${sub.name}`, description: sub.description ?? command.description ?? '' })),
  ]));
  const filteredCommands = createMemo(() => {
    if (slashDismissed() || !draft().startsWith('/')) return [];
    const query = draft().toLowerCase();
    const prefixed = slashOptions().filter(option => option.command.toLowerCase().startsWith(query));
    const matches = prefixed.length ? prefixed : slashOptions().filter(option => option.command.toLowerCase().includes(query.slice(1)));
    return matches.slice(0, 50);
  });
  const slashOpen = () => filteredCommands().length > 0;
  const selectedSlash = () => Math.min(slashIndex(), Math.max(0, filteredCommands().length - 1));
  function applyCommand(option: { command: string }) {
    setDraft(`${option.command} `);
    setSlashDismissed(true);
    setSlashIndex(0);
    composerInput?.focus();
  }
  createEffect(() => { selectedSlash(); if (slashOpen()) queueMicrotask(() => document.querySelector('.slash-item.is-active')?.scrollIntoView({ block: 'nearest' })); });

  async function attachImage(file: File) {
    if (!file.type.startsWith('image/')) return;
    const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as string); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
    setDraftImages(prev => [...prev, { id: crypto.randomUUID(), dataUrl, mediaType: file.type, fileName: file.name }]);
  }

  function removeImage(imageId: string) { setDraftImages(prev => prev.filter(img => img.id !== imageId)); }

  function removeFile(fileId: string) { setDraftFiles(prev => prev.filter(item => item.id !== fileId)); }

  // WebKitGTK (the webview Tauri uses on Linux) delivers a paste event whose clipboardData carries
  // no types, items or files for images, so the browser path alone can never see a copied
  // screenshot. When it yields nothing, read the system clipboard natively instead.
  function handleComposerPaste(event: ClipboardEvent) {
    const items = event.clipboardData?.items;
    let attachedFromEvent = false;
    for (let index = 0; index < (items?.length ?? 0); index += 1) {
      const item = items![index];
      if (!item.type.startsWith('image/')) continue;
      const file = item.getAsFile();
      if (!file) continue;
      event.preventDefault();
      attachedFromEvent = true;
      void attachImage(file);
    }
    if (attachedFromEvent || !('__TAURI_INTERNALS__' in window)) return;
    void studioApi.readClipboardImage().then(dataUrl => {
      if (dataUrl) setDraftImages(prev => [...prev, { id: crypto.randomUUID(), dataUrl, mediaType: 'image/png' }]);
    }).catch(() => { /* a clipboard holding no image is the normal case for a text paste */ });
  }

  function handleComposerDrop(event: DragEvent) {
    event.preventDefault();
    const files = event.dataTransfer?.files; if (!files) return;
    for (let index = 0; index < files.length; index += 1) void attachImage(files[index]);
  }

  function handleComposerDragOver(event: DragEvent) { event.preventDefault(); }

  function handleFilePickerChange(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    if (!input.files) return;
    for (let index = 0; index < input.files.length; index += 1) void attachImage(input.files[index]);
    input.value = '';
  }

  // The browser file input hands back a File with no path, so OMP could never open a non-image
  // attachment. The Tauri dialog returns real paths: images are inlined for vision, everything
  // else travels as a path OMP reads itself.
  async function chooseAttachments() {
    if (!('__TAURI_INTERNALS__' in window)) { filePickerInput?.click(); return; }
    const picked = await open({ multiple: true, title: 'Attach files' }).catch(() => null);
    if (!picked) return;
    for (const path of Array.isArray(picked) ? picked : [picked]) {
      try {
        const loaded = await studioApi.loadAttachment(path);
        if (loaded.dataUrl && loaded.mediaType) setDraftImages(prev => [...prev, { id: crypto.randomUUID(), dataUrl: loaded.dataUrl!, mediaType: loaded.mediaType!, fileName: loaded.fileName }]);
        else setDraftFiles(prev => [...prev, { id: crypto.randomUUID(), path: loaded.path, fileName: loaded.fileName }]);
      } catch (error) {
        appendConversationNotice('Attachment', error instanceof Error ? error.message : `Could not attach ${path}`);
      }
    }
  }

  let unlisten: undefined | (() => void);
  let disposed = false;
  let assistantStreamId = '';
  let assistantText = '';
  let observedSessionId = sessionId();

  function acceptFrame(payload: OmpFramePayload) {
    const activeId = sessionId();
    if (!activeId || (payload.sessionId && payload.sessionId !== activeId)) return;
    const raw = payload.raw ?? {};
    const type = String(raw.type ?? '');
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (type === 'agent_start') { handleAgentStart(activeId); setBusy(true); return; }
    if (type === 'agent_end') {
      const status = raw.cancelled === true ? 'cancelled' : raw.error ? 'failed' : 'completed';
      completeConversationRun(activeId, status); setBusy(false); assistantStreamId = ''; assistantText = '';
      // OMP writes its own summary of the exchange only after the run settles.
      void adoptOmpSessionTitle(activeId);
      return;
    }
    // OMP answers host commands such as /marketplace itself, out of band: there is no agent turn to attach the text to.
    if (type === 'command_output') {
      const text = typeof raw.text === 'string' ? raw.text : '';
      if (text.trim()) appendConversationNotice('OMP', text, 'notice');
      return;
    }
    const message = (raw.message && typeof raw.message === 'object' ? raw.message : {}) as OmpMessage;
    if (type === 'message_start' && message.role === 'assistant') {
      assistantStreamId = typeof message.id === 'string' ? message.id : crypto.randomUUID();
      assistantText = extractText(message);
      setBusy(true);
      if (assistantText) upsertRunAssistant(activeId, { id: assistantStreamId, kind: 'assistant', title: assistantName(), body: assistantText, status: 'streaming', timestamp });
      return;
    }
    if (type === 'message_update') {
      const event = (raw.assistantMessageEvent && typeof raw.assistantMessageEvent === 'object' ? raw.assistantMessageEvent : {}) as Record<string, unknown>;
      const eventType = String(event.type ?? '');
      if (eventType !== 'text_delta' && eventType !== 'text_end') return;
      if (!assistantStreamId) assistantStreamId = typeof message.id === 'string' ? message.id : crypto.randomUUID();
      if (eventType === 'text_delta' && typeof event.delta === 'string') assistantText += event.delta;
      if (eventType === 'text_end' && typeof event.content === 'string') assistantText = event.content;
      upsertRunAssistant(activeId, { id: assistantStreamId, kind: 'assistant', title: assistantName(), body: assistantText, status: 'streaming', timestamp });
      return;
    }
    if (type === 'message_end' && message.role === 'assistant') {
      const finalText = extractText(message) || assistantText;
      if (finalText) {
        if (!assistantStreamId) assistantStreamId = typeof message.id === 'string' ? message.id : crypto.randomUUID();
        const failed = message.stopReason === 'error';
        upsertRunAssistant(activeId, { id: assistantStreamId, kind: failed ? 'error' : 'assistant', title: assistantName(), body: finalText, status: failed ? 'failed' : undefined, timestamp });
      }
      assistantStreamId = ''; assistantText = ''; return;
    }
    if (type === 'message_end' && message.role === 'custom' && message.customType === 'advisor') { appendRunAdvisor(activeId, message); return; }
    if (type.startsWith('tool_execution_')) updateRunTool(activeId, raw, type);
  }

  createEffect(() => {
    const id = sessionId();
    if (id === observedSessionId) return;
    observedSessionId = id; assistantStreamId = ''; assistantText = ''; setBusy(false);
  });
  onMount(() => { if ('__TAURI_INTERNALS__' in window) void listen<OmpFramePayload>('omp-frame', event => acceptFrame(event.payload)).then(stop => { if (disposed) stop(); else unlisten = stop; }); });
  onCleanup(() => { disposed = true; unlisten?.(); });

  async function toggleAdvisor(enabled: boolean) {
    if (advisorPending()) return;
    setAdvisorPending(true);
    try { await changeAdvisorEnabled(enabled); }
    catch (error) { appendConversationNotice('Advisor', error instanceof Error ? error.message : 'Unable to update Advisor'); }
    finally { setAdvisorPending(false); }
  }

  async function togglePlan(enabled: boolean) {
    if (planPending()) return;
    setPlanPending(true);
    try { await changeWorkflowPlan(enabled); }
    catch (error) { appendConversationNotice('Plan mode', error instanceof Error ? error.message : 'Unable to switch workflow mode'); }
    finally { setPlanPending(false); }
  }

  async function chooseExistingProject() {
    if (projectPending()) return;
    const path = await open({ directory: true, multiple: false, title: 'Open project' }).catch(() => null);
    if (typeof path !== 'string') return;
    setProjectPending(true);
    try { await startConfiguredSession(path); }
    catch (error) { appendConversationNotice('Project', error instanceof Error ? error.message : 'Unable to open project'); }
    finally { setProjectPending(false); }
  }

  async function startNewProject() {
    if (projectPending()) return;
    const path = await open({ directory: true, multiple: false, title: 'Choose where to create the project' }).catch(() => null);
    if (typeof path !== 'string') return;
    setNewProjectName(''); setNewProjectParent(path);
  }

  async function confirmNewProject() {
    const name = newProjectName().trim();
    if (!name || projectPending()) return;
    setProjectPending(true);
    try { await createAndStartProject(newProjectParent(), name); setNewProjectParent(''); }
    catch (error) { appendConversationNotice('Project', error instanceof Error ? error.message : 'Unable to create project'); }
    finally { setProjectPending(false); }
  }

  const composerEmpty = () => !draft().trim() && !draftImages().length && !draftFiles().length;

  // Aborting settles the run locally whatever OMP answers: the button exists to get the composer
  // out of the running state, and a stale busy flag is exactly the case where OMP has nothing to
  // abort and therefore never emits the agent_end that would clear it.
  async function stopActiveRun() {
    const id = sessionId(); if (!id) return;
    try { await studioApi.stopRun(id); }
    catch (error) { appendConversationNotice('OMP', error instanceof Error ? error.message : 'Unable to stop the run'); }
    completeConversationRun(id, 'cancelled'); setBusy(false);
  }

  async function submit(mode: 'auto' | 'followup' = 'auto') {
    // A resumed session whose OMP process is still booting, or whose attach never landed, would refuse the prompt: keep the draft.
    if (sessionConnecting() || sessionOffline()) return;
    const message = draft().trim(); const images = draftImages(); const files = draftFiles();
    if (composerEmpty()) return;
    // OMP reads attachments itself, so non-image files travel as paths rather than inflating the frame.
    const outgoing = files.length ? `${message}${message ? '\n\n' : ''}Attached files:\n${files.map(file => `- ${file.path}`).join('\n')}` : message;
    const id = sessionId(); if (!id) { appendConversationNotice('OMP', 'Open a project and start a session before sending a prompt.'); return; }
    if (message === '/stop') { setDraft(''); setDraftImages([]); setDraftFiles([]); await stopActiveRun(); return; }
    const wasBusy = busy(); if (!wasBusy) startConversationRun(id, message, images.length ? images : undefined, files.length ? files : undefined);
    setDraft(''); setDraftImages([]); setDraftFiles([]);
    if (!wasBusy) setBusy(true);
    try {
      const agentInvoked = mode === 'followup' ? await studioApi.followUpPrompt(id, outgoing, images.length ? images : undefined)
        : wasBusy ? await studioApi.steerPrompt(id, outgoing, images.length ? images : undefined)
        : await studioApi.sendPrompt(id, outgoing, images.length ? images : undefined);
      // A prompt OMP handles as a host command never produces the agent_end that would clear the composer.
      if (!wasBusy && !agentInvoked) { completeConversationRun(id, 'completed'); setBusy(false); }
    }
    catch (error) { appendConversationNotice('OMP', error instanceof Error ? error.message : 'Unable to send message'); if (!wasBusy) { completeConversationRun(id, 'failed'); setBusy(false); } }
  }
  return <div class={`workspace-page ${rightPanelOpen() ? '' : 'workspace-page--wide'}`}><section class="conversation-column"><Show when={sessionConnecting()}><div class="session-connection-status" role="status" aria-live="polite"><Loader2 size={12} class="spin" /><span>OMP is starting in the background…</span></div></Show><Show when={runs().length || conversationNotices().length} fallback={<Panel class="empty-state"><Show when={sessionLoading()} fallback={<div class="conversation-empty"><p class="conversation-empty__title">Open a project, then send a prompt to start a conversation.</p><div class="conversation-empty__actions"><Button variant="solid" tone="accent" disabled={projectPending()} onClick={() => void startNewProject()}><FolderPlus size={15} />New project</Button><Button disabled={projectPending()} onClick={() => void chooseExistingProject()}><FolderOpen size={15} />Open project</Button></div></div>}><span class="session-loading"><Loader2 size={16} class="spin" />Resuming session…</span></Show></Panel>}><ConversationFeed runs={runs()} notices={conversationNotices()} /></Show><div class="composer-shell"><div class="composer" onPaste={handleComposerPaste} onDrop={handleComposerDrop} onDragOver={handleComposerDragOver}><Show when={draftImages().length > 0 || draftFiles().length > 0}><div class="composer-images"><For each={draftImages()}>{img => <div class="composer-image-thumb"><img src={img.dataUrl} alt={img.fileName ?? ''} /><button type="button" class="composer-image-remove" onClick={() => removeImage(img.id)} aria-label="Remove image"><X size={14} /></button></div>}</For><For each={draftFiles()}>{file => <div class="composer-file-chip" title={file.path}><FileText size={14} /><span>{file.fileName}</span><button type="button" onClick={() => removeFile(file.id)} aria-label={`Remove ${file.fileName}`}><X size={12} /></button></div>}</For></div></Show><textarea ref={composerInput} aria-label="Message" placeholder={draftImages().length ? 'Add a message or drop more images…' : 'Ask OMP Studio anything…'} value={draft()} onInput={event => { setDraft(event.currentTarget.value); setSlashDismissed(false); setSlashIndex(0); }} onKeyDown={event => { if (slashOpen()) { if (event.key === 'ArrowDown') { event.preventDefault(); setSlashIndex(index => (index + 1) % filteredCommands().length); return; } if (event.key === 'ArrowUp') { event.preventDefault(); setSlashIndex(index => (index - 1 + filteredCommands().length) % filteredCommands().length); return; } if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); applyCommand(filteredCommands()[selectedSlash()]); return; } if (event.key === 'Escape') { event.preventDefault(); setSlashDismissed(true); return; } } if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(); } }} /><Show when={slashOpen()}><div class="slash-menu" role="listbox"><For each={filteredCommands()}>{(option, index) => <button type="button" role="option" aria-selected={index() === selectedSlash()} class={`slash-item ${index() === selectedSlash() ? 'is-active' : ''}`} onMouseEnter={() => setSlashIndex(index())} onMouseDown={event => { event.preventDefault(); applyCommand(option); }}><strong>{option.command}</strong><Show when={option.description}><span>{option.description}</span></Show></button>}</For></div></Show><div class="composer-toolbar"><div class="composer-controls"><input ref={filePickerInput} type="file" multiple class="composer-file-input" onChange={handleFilePickerChange} /><button type="button" class="button button--ghost composer-attach-button" onClick={() => void chooseAttachments()} title="Attach files" aria-label="Attach files"><Paperclip size={16} /></button><AdaptiveEffortPopover models={availableModels()} recentModels={recentModels()} modelValue={activeModel()} effortValue={thinkingLevel()} onEffortChange={changeThinkingLevel} onModelChange={changeActiveModel} /><label class={`plan-control ${planPending() ? 'is-pending' : ''}`}><ClipboardList size={14} /><span>Plan</span><Toggle checked={planEnabled()} onChange={enabled => void togglePlan(enabled)} label="Plan mode" /></label><label class={`advisor-control ${advisorPending() ? 'is-pending' : ''}`}><Sparkles size={14} /><span>Advisor</span><Toggle checked={advisorEnabled()} onChange={enabled => void toggleAdvisor(enabled)} label="Advisor" /></label></div><div class="composer-actions"><Show when={busy()}><Button onClick={() => void stopActiveRun()}><Square size={15} />Stop</Button><Button disabled={composerEmpty()} onClick={() => void submit('followup')}>Follow up</Button></Show><Button class="composer-send" variant="solid" tone="accent" aria-label={busy() ? 'Steer OMP' : 'Send message'} title={busy() ? 'Steer OMP' : 'Send message'} disabled={composerEmpty() || sessionConnecting() || sessionOffline()} onClick={() => void submit()}><ArrowUp size={17} /></Button></div></div></div><div class="composer-hint"><Show when={sessionConnecting()} fallback={<Show when={sessionOffline()} fallback={<Show when={draftImages().length > 0} fallback={<><span>Enter to send</span><i>·</i><span>Shift + Enter for a new line</span></>}><span>Enter to send</span><i>·</i><span>Shift + Enter for new line</span><i>·</i><span>{draftImages().length} image{draftImages().length !== 1 ? 's' : ''} attached</span></Show>}><span class="composer-hint__offline"><AlertCircle size={11} /><span>OMP is offline for this session — click it again in the sidebar to retry</span></span></Show>}><span class="composer-hint__connecting"><Loader2 size={11} class="spin" /><span>Connecting to OMP… the conversation above is the stored transcript</span></span></Show></div></div><Dialog open={Boolean(newProjectParent())} title="New project" onClose={() => setNewProjectParent('')} actions={<><Button onClick={() => setNewProjectParent('')}>Cancel</Button><Button variant="solid" tone="accent" disabled={!newProjectName().trim() || projectPending()} onClick={() => void confirmNewProject()}>Create</Button></>}><label class="new-project-field"><span>Project name</span><input value={newProjectName()} placeholder="my-project" onInput={event => setNewProjectName(event.currentTarget.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void confirmNewProject(); } }} /></label><p class="new-project-parent">Will be created in {newProjectParent()}</p></Dialog></section><Show when={rightPanelOpen()}><WorkspaceRightRail /></Show></div>;
}
