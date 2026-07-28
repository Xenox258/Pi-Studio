import { For, Show, createMemo, createSignal } from 'solid-js';
import { Ban, Check, ChevronDown, ChevronRight, Circle, LoaderCircle, TriangleAlert, X } from 'lucide-solid';
import { getCachedToolOutput, summarizeRunActivity } from '../../models/conversation';
import { setRunActivityExpanded } from '../../stores/appStore';
import type { ConversationRun, ToolActivityItem } from '../../types';

function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function summaryLine(run: ConversationRun): string {
  const summary = summarizeRunActivity(run.activity.tools);
  const running = run.activity.tools.filter(tool => tool.status === 'running' || tool.status === 'queued').length;
  if (running) return `${plural(summary.total, 'action')} · ${running} running`;
  return summary.total ? `${plural(summary.total, 'action')} in this run` : 'Waiting for actions';
}

function categoryLine(tools: ToolActivityItem[]): string {
  const summary = summarizeRunActivity(tools);
  return [
    summary.searches && plural(summary.searches, 'search'),
    summary.reads && plural(summary.reads, 'file read', 'files read'),
    summary.edits && plural(summary.edits, 'file edited', 'files edited'),
    summary.writes && plural(summary.writes, 'file written', 'files written'),
    summary.commands && plural(summary.commands, 'command'),
    summary.other && plural(summary.other, 'other action'),
  ].filter(Boolean).join(' · ');
}

function elapsed(tool: ToolActivityItem): string {
  if (!tool.completedAt) return '';
  const duration = new Date(tool.completedAt).valueOf() - new Date(tool.startedAt).valueOf();
  if (!Number.isFinite(duration) || duration < 0) return '';
  return duration < 1000 ? `${duration} ms` : `${(duration / 1000).toFixed(duration < 10_000 ? 1 : 0)} s`;
}

function ToolStatusIcon(props: { tool: ToolActivityItem }) {
  if (props.tool.status === 'completed') return <Check size={15} />;
  if (props.tool.status === 'failed') return <X size={15} />;
  if (props.tool.status === 'cancelled') return <Ban size={15} />;
  if (props.tool.status === 'running') return <LoaderCircle size={15} class="spin" />;
  return <Circle size={12} />;
}

function payloadText(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function ToolActivityRow(props: { tool: ToolActivityItem }) {
  const [open, setOpen] = createSignal(props.tool.important);
  const [fullOutput, setFullOutput] = createSignal<string>();
  const hasDetails = () => props.tool.input !== undefined || props.tool.output !== undefined || Boolean(props.tool.summary);
  return <div class={`tool-activity-row tool-activity-row--${props.tool.status} ${props.tool.important ? 'is-important' : ''}`}>
    <span class="tool-activity-row__status"><ToolStatusIcon tool={props.tool} /></span>
    <button type="button" class="tool-activity-row__main" disabled={!hasDetails()} aria-expanded={open()} onClick={() => hasDetails() && setOpen(value => !value)}>
      <span><strong>{props.tool.displayName}</strong><small>{props.tool.summary}</small></span>
      <span class="tool-activity-row__meta">{elapsed(props.tool)}<em>{props.tool.status}</em>{hasDetails() && (open() ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}</span>
    </button>
    <Show when={props.tool.important}><TriangleAlert size={14} class="tool-activity-row__important" /></Show>
    <Show when={open()}><div class="tool-activity-row__details">
      <Show when={props.tool.input !== undefined}><div><b>Input</b><pre>{payloadText(props.tool.input)}</pre></div></Show>
      <Show when={props.tool.output !== undefined}><div><b>Output</b><pre>{fullOutput() ?? payloadText(props.tool.output)}</pre></div></Show>
      <Show when={props.tool.outputTruncated && !fullOutput()}><button type="button" class="button button--ghost" onClick={() => setFullOutput(getCachedToolOutput(props.tool.id) ?? 'Full output is no longer available in the bounded cache.')}>Load full output</button></Show>
    </div></Show>
  </div>;
}

export default function RunActivityCard(props: { run: ConversationRun }) {
  const importantTools = createMemo(() => props.run.activity.tools.filter(tool => tool.important));
  const visibleTools = createMemo(() => props.run.activity.expanded ? props.run.activity.tools : importantTools());
  return <Show when={props.run.status === 'running' && props.run.activity.tools.length > 0}><section class={`run-activity ${props.run.activity.expanded ? '' : 'run-activity--collapsed'} ${props.run.activity.hasErrors ? 'has-errors' : ''}`}>
    <button type="button" class="run-activity__summary" aria-expanded={props.run.activity.expanded} onClick={() => setRunActivityExpanded(props.run.id, !props.run.activity.expanded)}>
      <span class="run-activity__state">{props.run.activity.hasErrors ? <TriangleAlert size={16} /> : <LoaderCircle size={16} class="spin" />}</span>
      <span class="run-activity__copy"><strong>{summaryLine(props.run)}</strong><small>{categoryLine(props.run.activity.tools)}</small></span>
      {props.run.activity.expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
    </button>
    <Show when={visibleTools().length > 0}><div class="run-activity__details"><For each={visibleTools()}>{tool => <ToolActivityRow tool={tool} />}</For></div></Show>
  </section></Show>;
}
