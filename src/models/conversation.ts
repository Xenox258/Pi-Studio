import type {
  ActivitySummary,
  AdvisorMessageItem,
  ConversationRun,
  ImageAttachment,
  OmpMessage,
  ToolActivityItem,
  ToolActivityStatus,
  UserMessageItem,
} from '../types';

const inlineOutputLimit = 12 * 1024;
const outputCacheLimit = 512 * 1024;
const maxCachedOutputs = 32;
const cachedOutputs = new Map<string, { text: string; bytes: number }>();
let cachedOutputBytes = 0;

const searchTools: Record<string, true> = { grep: true, glob: true, search: true, find: true };
const readTools: Record<string, true> = { read: true, cat: true, open_file: true };
const editTools: Record<string, true> = { edit: true, patch: true, apply_patch: true, delete: true, remove: true, move: true, rename: true };
const writeTools: Record<string, true> = { write: true, create_file: true };
const commandTools: Record<string, true> = { bash: true, shell: true, exec: true, command: true, run: true };
const pendingTerms = /\b(confirm|confirmation|permission|approval|authorize|authorise)\b/i;
const importantTerms = /\b(permission denied|timed out|timeout|failed|failure|error|crash|panic|deleted?|removed?|modified|applied)\b/i;
const destructiveCommand = /(?:^|\s)(?:rm\s+-rf|rm\s+-r|git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f|drop\s+(?:table|database)|truncate\s+table)(?:\s|$)/i;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function serializePayload(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2) ?? String(value ?? ''); } catch { return String(value ?? ''); }
}

function cacheOutput(id: string, value: unknown): { output: unknown; outputTruncated: boolean } {
  if (value === undefined) return { output: undefined, outputTruncated: false };
  const text = serializePayload(value);
  if (text.length <= inlineOutputLimit) return { output: value, outputTruncated: false };
  const bytes = new TextEncoder().encode(text).byteLength;
  const previous = cachedOutputs.get(id);
  if (previous) cachedOutputBytes -= previous.bytes;
  cachedOutputs.delete(id);
  cachedOutputs.set(id, { text, bytes });
  cachedOutputBytes += bytes;
  while (cachedOutputs.size > maxCachedOutputs || cachedOutputBytes > outputCacheLimit) {
    const oldest = cachedOutputs.entries().next().value as [string, { text: string; bytes: number }] | undefined;
    if (!oldest) break;
    cachedOutputs.delete(oldest[0]);
    cachedOutputBytes -= oldest[1].bytes;
  }
  return { output: `${text.slice(0, inlineOutputLimit)}\n…`, outputTruncated: true };
}

export function getCachedToolOutput(toolId: string): string | undefined {
  return cachedOutputs.get(toolId)?.text;
}

export function readableToolText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(readableToolText).filter(Boolean).join('\n');
  if (!value || typeof value !== 'object') return '';
  const item = record(value);
  for (const key of ['content', 'text', 'output', 'stdout', 'stderr', 'message', 'error']) {
    const text = readableToolText(item[key]);
    if (text) return text;
  }
  return '';
}

function shortSummary(value: unknown, fallback: string): string {
  const text = readableToolText(value) || (value === undefined ? '' : serializePayload(value));
  const line = text.split(/\r?\n/).map(part => part.trim()).find(part => part && !/^\.{1,4}$/.test(part));
  return line ? `${line.slice(0, 220)}${line.length > 220 ? '…' : ''}` : fallback;
}

function basename(path: unknown): string | undefined {
  if (typeof path !== 'string') return;
  return path.split(/[\\/]/).filter(Boolean).at(-1);
}

export function getToolDisplayName(toolName: string, input: unknown): string {
  const name = toolName.toLowerCase();
  const args = record(input);
  const file = basename(args.path ?? args.filePath ?? args.file);
  if (name === 'grep' || name === 'search') return 'Searching files';
  if (name === 'glob' || name === 'find') return 'Finding matching files';
  if (readTools[name]) return file ? `Reading ${file}` : 'Reading file';
  if (editTools[name]) return file ? `Editing ${file}` : 'Editing file';
  if (writeTools[name]) return file ? `Writing ${file}` : 'Writing file';
  if (commandTools[name]) return 'Running command';
  return toolName.replace(/[_-]+/g, ' ').replace(/^./, value => value.toUpperCase());
}

export function summarizeRunActivity(tools: ToolActivityItem[]): ActivitySummary {
  const summary: ActivitySummary = { total: tools.length, completed: 0, failed: 0, cancelled: 0, searches: 0, reads: 0, edits: 0, writes: 0, commands: 0, other: 0 };
  for (const tool of tools) {
    if (tool.status === 'completed') summary.completed += 1;
    else if (tool.status === 'failed') summary.failed += 1;
    else if (tool.status === 'cancelled') summary.cancelled += 1;
    const name = tool.toolName.toLowerCase();
    if (searchTools[name]) summary.searches += 1;
    else if (readTools[name]) summary.reads += 1;
    else if (editTools[name]) summary.edits += 1;
    else if (writeTools[name]) summary.writes += 1;
    else if (commandTools[name]) summary.commands += 1;
    else summary.other += 1;
  }
  return summary;
}

export function classifyToolImportance(tool: ToolActivityItem): boolean {
  if (tool.status === 'failed' || tool.status === 'cancelled') return true;
  const name = tool.toolName.toLowerCase();
  if (editTools[name] || writeTools[name]) return true;
  const input = serializePayload(tool.input ?? '');
  const output = serializePayload(tool.output ?? tool.summary ?? '');
  return pendingTerms.test(`${name} ${input}`) || importantTerms.test(output) || destructiveCommand.test(input);
}

export function hasPendingToolConfirmation(tool: ToolActivityItem): boolean {
  return tool.status === 'running' && pendingTerms.test(`${tool.toolName} ${serializePayload(tool.input ?? '')} ${tool.summary ?? ''}`);
}

export function createToolActivity(toolId: string, toolName: string, input: unknown, startedAt: string, status: ToolActivityStatus = 'running'): ToolActivityItem {
  const compactInput = serializePayload(input).length > inlineOutputLimit ? `${serializePayload(input).slice(0, inlineOutputLimit)}\n…` : input;
  const tool: ToolActivityItem = { id: toolId, toolName, displayName: getToolDisplayName(toolName, input), status, input: compactInput, startedAt, important: false };
  tool.important = classifyToolImportance(tool);
  return tool;
}

export function updateToolActivity(tool: ToolActivityItem, frame: Record<string, unknown>, status: ToolActivityStatus, completedAt?: string): ToolActivityItem {
  const outputValue = frame.result ?? frame.partialResult ?? frame.output ?? frame.error;
  const cached = cacheOutput(tool.id, outputValue);
  const next: ToolActivityItem = {
    ...tool,
    status,
    output: cached.output ?? tool.output,
    outputTruncated: cached.outputTruncated || tool.outputTruncated,
    summary: shortSummary(outputValue, status === 'failed' ? 'Tool failed' : status === 'cancelled' ? 'Tool cancelled' : status === 'completed' ? 'Completed' : tool.summary ?? 'Running'),
    completedAt,
  };
  next.important = classifyToolImportance(next);
  return next;
}

function extractImages(message: OmpMessage): ImageAttachment[] {
  if (!Array.isArray(message.content)) return [];
  return message.content.flatMap((entry, index) => {
    const block = record(entry);
    if (block.type !== 'image') return [];
    const source = record(block.source);
    if (source.type !== 'base64' || typeof source.data !== 'string' || typeof source.media_type !== 'string') return [];
    return [{ id: `${String(message.id ?? 'msg')}:img:${index}`, dataUrl: `data:${source.media_type};base64,${source.data}`, mediaType: source.media_type }];
  });
}
function messageText(message: OmpMessage): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap(entry => {
    const block = record(entry);
    return block.type === 'text' && typeof block.text === 'string' ? [block.text] : [];
  }).join('\n');
}

function timestamp(value: unknown, fallbackIndex: number): string {
  const date = typeof value === 'number' || typeof value === 'string' ? new Date(value) : new Date(fallbackIndex);
  return Number.isNaN(date.valueOf()) ? new Date(0).toISOString() : date.toISOString();
}

function displayTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.valueOf()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fingerprint(value: unknown): string {
  const text = serializePayload(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(36);
}

function messageId(message: OmpMessage, index: number, suffix = ''): string {
  return typeof message.id === 'string' ? `${message.id}${suffix}` : `history:${fingerprint({ message, index, suffix })}`;
}

function blankRun(sessionId: string, id: string, startedAt: string, userMessage?: UserMessageItem): ConversationRun {
  const user = userMessage ?? { id: `${id}:user`, kind: 'user', title: 'You', body: '', timestamp: displayTime(startedAt), sequence: 0 };
  return {
    id,
    sessionId,
    userMessage: user,
    activity: { id: `${id}:activity`, runId: id, tools: [], expanded: false, autoCollapsed: true, hasErrors: false, hasPendingConfirmation: false, userOpenedDuringRun: false },
    advisorMessages: [],
    assistantMessages: [],
    status: 'completed',
    startedAt,
    completedAt: startedAt,
  };
}

function storedToolCalls(message: OmpMessage): Record<string, unknown>[] {
  if (!Array.isArray(message.content)) return [];
  return message.content.flatMap(entry => {
    const block = record(entry);
    const type = String(block.type ?? '').toLowerCase();
    return type === 'toolcall' || type === 'tool_call' || type === 'tool_use' ? [block] : [];
  });
}

function advisorItems(message: OmpMessage, index: number, sequence: number): AdvisorMessageItem[] {
  const details = record(message.details);
  const notes = Array.isArray(details.notes) ? details.notes : [];
  if (!notes.length) {
    const body = messageText(message);
    return body ? [{ id: messageId(message, index), kind: 'advisor', title: 'Advisor', body, timestamp: displayTime(timestamp(message.timestamp, index)), sequence }] : [];
  }
  return notes.flatMap((entry, noteIndex) => {
    const note = record(entry);
    if (typeof note.note !== 'string') return [];
    const severity = note.severity === 'nit' || note.severity === 'concern' || note.severity === 'blocker' ? note.severity : undefined;
    const advisor = typeof note.advisor === 'string' && note.advisor !== 'default' ? ` · ${note.advisor}` : '';
    return [{ id: messageId(message, index, `:note:${noteIndex}`), kind: 'advisor' as const, title: `Advisor${advisor}`, body: note.note, severity, timestamp: displayTime(timestamp(message.timestamp, index)), sequence: sequence + noteIndex }];
  });
}

export function reconstructConversationRuns(messages: OmpMessage[], sessionId = 'restored', assistantName = 'Assistant'): ConversationRun[] {
  const runs: ConversationRun[] = [];
  let active: ConversationRun | undefined;
  let sequence = 0;
  const toolLocations = new Map<string, { run: ConversationRun; index: number }>();

  const ensureRun = (message: OmpMessage, index: number) => {
    if (active) return active;
    const startedAt = timestamp(message.timestamp, index);
    active = blankRun(sessionId, `run:${fingerprint({ sessionId, index, startedAt })}`, startedAt);
    runs.push(active);
    return active;
  };

  messages.forEach((message, index) => {
    const role = String(message.role ?? '');
    const startedAt = timestamp(message.timestamp, index);
    if (role === 'user') {
      const images = extractImages(message);
      const userMessage: UserMessageItem = { id: messageId(message, index), kind: 'user', title: 'You', body: messageText(message), timestamp: displayTime(startedAt), sequence: sequence++, ...(images.length ? { images } : {}) };
      active = blankRun(sessionId, `run:${messageId(message, index)}`, startedAt, userMessage);
      runs.push(active);
      return;
    }
    const run = ensureRun(message, index);
    if (role === 'custom' && message.customType === 'advisor') {
      const advisors = advisorItems(message, index, sequence);
      run.advisorMessages.push(...advisors);
      sequence += advisors.length;
      return;
    }
    if (role === 'assistant') {
      for (const call of storedToolCalls(message)) {
        const toolId = String(call.id ?? call.toolCallId ?? `tool:${fingerprint({ call, index })}`);
        if (toolLocations.has(toolId)) continue;
        const toolName = String(call.name ?? call.toolName ?? 'OMP');
        const tool = createToolActivity(toolId, toolName, call.arguments ?? call.input, startedAt, 'running');
        run.activity.tools.push(tool);
        toolLocations.set(toolId, { run, index: run.activity.tools.length - 1 });
      }
      const body = messageText(message);
      if (body) run.assistantMessages.push({ id: messageId(message, index), kind: message.stopReason === 'error' ? 'error' : 'assistant', title: assistantName, body, status: message.stopReason === 'error' ? 'failed' : undefined, timestamp: displayTime(startedAt), sequence: sequence++ });
      run.completedAt = startedAt;
      return;
    }
    if (role === 'toolResult' || role === 'tool') {
      const toolId = String(message.toolCallId ?? message.toolUseId ?? message.id ?? `tool:${fingerprint({ message, index })}`);
      let location = toolLocations.get(toolId);
      if (!location) {
        const toolName = String(message.toolName ?? 'OMP');
        run.activity.tools.push(createToolActivity(toolId, toolName, undefined, startedAt, 'running'));
        location = { run, index: run.activity.tools.length - 1 };
        toolLocations.set(toolId, location);
      }
      const existing = location.run.activity.tools[location.index];
      const failed = message.isError === true || Boolean(message.error);
      location.run.activity.tools[location.index] = updateToolActivity(existing, { result: message.content, error: message.error }, failed ? 'failed' : 'completed', startedAt);
    }
  });

  for (const run of runs) {
    run.activity.tools = run.activity.tools.map(tool => tool.status === 'running' ? { ...tool, status: 'cancelled', important: true, completedAt: run.completedAt ?? run.startedAt, summary: tool.summary ?? 'No result recorded' } : tool);
    run.activity.hasErrors = run.activity.tools.some(tool => tool.status === 'failed');
    run.activity.hasPendingConfirmation = run.activity.tools.some(hasPendingToolConfirmation);
    run.activity.expanded = false;
    run.activity.autoCollapsed = true;
    run.status = run.assistantMessages.some(message => message.kind === 'error') ? 'failed' : 'completed';
    run.completedAt ??= run.assistantMessages.at(-1)?.timestamp || run.startedAt;
  }
  return runs;
}
