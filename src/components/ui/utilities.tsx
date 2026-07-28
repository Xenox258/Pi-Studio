import type { JSX } from 'solid-js';

export function Skeleton(props: { lines?: number; class?: string }) {
  return <div class={`skeleton ${props.class ?? ''}`} aria-label="Loading" aria-busy="true">{Array.from({ length: props.lines ?? 3 }, (_, index) => <span style={{ width: `${92 - index * 13}%` }} />)}</div>;
}

export function ResizablePanel(props: { children: JSX.Element; side?: 'left' | 'right'; class?: string }) {
  return <section class={`resizable-panel resizable-panel--${props.side ?? 'right'} ${props.class ?? ''}`}>{props.children}</section>;
}

export function Tooltip(props: { label: string; children: JSX.Element }) {
  return <span class="tooltip" data-tooltip={props.label}>{props.children}</span>;
}
