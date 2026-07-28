import { For, Show, createMemo } from 'solid-js';

type Block = { kind: 'paragraph' | 'list' | 'code'; lines: string[] };

function blocks(source: string): Block[] {
  const output: Block[] = []; let code: string[] | null = null;
  for (const line of source.split('\n')) {
    if (line.trim().startsWith('```')) { if (code) { output.push({ kind: 'code', lines: code }); code = null; } else code = []; continue; }
    if (code) { code.push(line); continue; }
    const list = /^\s*(?:[-*]|\d+[.)])\s+(.+)$/.exec(line);
    if (list) { const last = output.at(-1); if (last?.kind === 'list') last.lines.push(list[1]); else output.push({ kind: 'list', lines: [list[1]] }); continue; }
    if (!line.trim()) continue;
    const last = output.at(-1); if (last?.kind === 'paragraph') last.lines.push(line); else output.push({ kind: 'paragraph', lines: [line] });
  }
  if (code) output.push({ kind: 'code', lines: code });
  return output;
}

export default function Markdown(props: { source: string }) {
  const parsed = createMemo(() => blocks(props.source));
  return <div class="markdown"><For each={parsed()}>{block => <Show when={block.kind !== 'code'} fallback={<pre><code>{block.lines.join('\n')}</code></pre>}><Show when={block.kind === 'list'} fallback={<p>{block.lines.join(' ')}</p>}><ol><For each={block.lines}>{line => <li>{line}</li>}</For></ol></Show></Show>}</For></div>;
}
