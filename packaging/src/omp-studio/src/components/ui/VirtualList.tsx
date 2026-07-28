import { For, type JSX } from 'solid-js';
import { createVirtualizer } from '@tanstack/solid-virtual';

export default function VirtualList<T>(props: { items: T[]; estimateSize: number; children: (item: T, index: number) => JSX.Element; class?: string }) {
  let viewport!: HTMLDivElement;
  const virtualizer = createVirtualizer({ count: props.items.length, getScrollElement: () => viewport, estimateSize: () => props.estimateSize, overscan: 6 });
  return <div ref={viewport} class={`virtual-list ${props.class ?? ''}`}><div class="virtual-list__canvas" style={{ height: `${virtualizer.getTotalSize()}px` }}><For each={virtualizer.getVirtualItems()}>{row => <div ref={virtualizer.measureElement} data-index={row.index} class="virtual-list__row" style={{ transform: `translateY(${row.start}px)` }}>{props.children(props.items[row.index], row.index)}</div>}</For></div></div>;
}
