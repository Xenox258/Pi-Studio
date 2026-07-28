import { For, Show, splitProps } from 'solid-js';
import type { JSX } from 'solid-js';
import { AlertCircle, CheckCircle2, X } from 'lucide-solid';
export { Skeleton, ResizablePanel, Tooltip } from './utilities';
export { default as VirtualList } from './VirtualList';
export { Popover, DataTable } from './advanced';

type Tone = 'default' | 'accent' | 'success' | 'warning' | 'danger';

export function Panel(props: { children: JSX.Element; class?: string; title?: string }) {
  return <section class={`panel ${props.class ?? ''}`}>{props.title && <h2 class="panel-title">{props.title}</h2>}{props.children}</section>;
}

export function Button(props: JSX.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone; variant?: 'solid' | 'outline' | 'ghost' }) {
  const [local, rest] = splitProps(props, ['class', 'tone', 'variant', 'children']);
  return <button class={`button button--${local.variant ?? 'outline'} button--${local.tone ?? 'default'} ${local.class ?? ''}`} {...rest}>{local.children}</button>;
}

export function IconButton(props: JSX.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  const [local, rest] = splitProps(props, ['class', 'label', 'children']);
  return <button class={`icon-button ${local.class ?? ''}`} aria-label={local.label} title={local.label} {...rest}>{local.children}</button>;
}

export function Badge(props: { children: JSX.Element; tone?: Tone }) {
  return <span class={`badge badge--${props.tone ?? 'default'}`}>{props.children}</span>;
}

export function Toggle(props: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={props.checked} aria-label={props.label} class={`toggle ${props.checked ? 'is-on' : ''}`} onClick={() => props.onChange(!props.checked)}><span /></button>;
}

export function Select(props: { value: string; options: Array<string | { value: string; label: string }>; onChange?: (value: string) => void; label: string }) {
  return <label class="select-wrap"><span class="sr-only">{props.label}</span><select value={props.value} onChange={(event) => props.onChange?.(event.currentTarget.value)}><For each={props.options}>{option => typeof option === 'string' ? <option value={option}>{option}</option> : <option value={option.value}>{option.label}</option>}</For></select></label>;
}

export function Tabs(props: { items: { id: string; label: string; count?: number }[]; value: string; onChange: (id: string) => void; wide?: boolean }) {
  return <div class={`tabs ${props.wide ? 'tabs--wide' : ''}`} role="tablist"><For each={props.items}>{item => <button role="tab" aria-selected={item.id === props.value} class={item.id === props.value ? 'is-active' : ''} onClick={() => props.onChange(item.id)}>{item.label}{item.count !== undefined && <span class="tab-count">{item.count}</span>}</button>}</For></div>;
}

export function ProgressBar(props: { value: number; tone?: Tone; label: string }) {
  const value = () => Math.min(100, Math.max(0, props.value));
  return <div class="progress" role="progressbar" aria-label={props.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value()}><span class={`progress__bar progress__bar--${props.tone ?? 'accent'}`} style={{ width: `${value()}%` }} /></div>;
}

export function Dialog(props: { open: boolean; title: string; children: JSX.Element; onClose: () => void; actions?: JSX.Element }) {
  return <Show when={props.open}><div class="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && props.onClose()}><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><header><h2 id="dialog-title">{props.title}</h2><IconButton label="Close dialog" onClick={props.onClose}><X size={17} /></IconButton></header><div class="dialog__body">{props.children}</div>{props.actions && <footer>{props.actions}</footer>}</section></div></Show>;
}

export function EmptyState(props: { title: string; message: string; action?: JSX.Element }) {
  return <div class="state-message"><AlertCircle size={28} /><h2>{props.title}</h2><p>{props.message}</p>{props.action}</div>;
}

export function SuccessLine(props: { children: JSX.Element }) {
  return <span class="success-line"><CheckCircle2 size={15} />{props.children}</span>;
}
