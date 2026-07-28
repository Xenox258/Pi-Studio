import { For, Show, createEffect, createSignal, onCleanup, type JSX } from 'solid-js';

export function Popover(props: { trigger: JSX.Element; children: JSX.Element; label: string }) {
  const [open, setOpen] = createSignal(false);
  let container: HTMLSpanElement | undefined;
  createEffect(() => {
    if (!open()) return;
    const onPointerDown = (event: PointerEvent) => { if (container && !container.contains(event.target as Node)) setOpen(false); };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    onCleanup(() => { document.removeEventListener('pointerdown', onPointerDown, true); document.removeEventListener('keydown', onKeyDown); });
  });
  return <span class="popover" ref={container}><button class="popover__trigger" aria-haspopup="dialog" aria-expanded={open()} onClick={() => setOpen(!open())}>{props.trigger}</button><Show when={open()}><span class="popover__content" role="dialog" aria-label={props.label}>{props.children}</span></Show></span>;
}

export function DataTable<T>(props: { columns: { key: string; label: string; render: (item: T) => JSX.Element }[]; rows: T[]; label: string }) {
  return <div class="data-table" role="table" aria-label={props.label}><div class="data-table__head" role="row"><For each={props.columns}>{column => <span role="columnheader">{column.label}</span>}</For></div><For each={props.rows}>{row => <div class="data-table__row" role="row"><For each={props.columns}>{column => <span role="cell">{column.render(row)}</span>}</For></div>}</For></div>;
}
