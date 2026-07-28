import { For, Match, Show, Switch, createMemo, type JSX } from 'solid-js';

type Block =
  | { kind: 'paragraph'; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'heading'; level: 1 | 2 | 3 | 4; text: string }
  | { kind: 'list'; ordered: boolean; items: string[]; start?: number }
  | { kind: 'code'; code: string; language?: string }
  | { kind: 'table'; headers: string[]; rows: string[][] }
  | { kind: 'rule' };

type InlineKind = 'code' | 'link' | 'strong' | 'strike' | 'emphasis';
type InlineMatch = { kind: InlineKind; index: number; match: RegExpExecArray };

const inlinePatterns: { kind: InlineKind; expression: RegExp }[] = [
  { kind: 'code', expression: /`([^`\n]+)`/ },
  { kind: 'link', expression: /\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/ },
  { kind: 'strong', expression: /(?:\*\*|__)(.+?)(?:\*\*|__)/ },
  { kind: 'strike', expression: /~~(.+?)~~/ },
  { kind: 'emphasis', expression: /(?:^|\s)(\*|_)([^*_\n]+)\1(?=$|[\s.,;:!?])/ },
];

function safeHref(value: string): string | undefined {
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : undefined;
  } catch {
    return;
  }
}

function nextInlineMatch(source: string): InlineMatch | undefined {
  let selected: InlineMatch | undefined;
  for (const pattern of inlinePatterns) {
    const match = pattern.expression.exec(source);
    if (match && (!selected || match.index < selected.index)) selected = { kind: pattern.kind, index: match.index, match };
  }
  return selected;
}

function inline(source: string, depth = 0): JSX.Element[] {
  if (!source || depth > 6) return source ? [source] : [];
  const token = nextInlineMatch(source);
  if (!token) return [source];
  const before = source.slice(0, token.index);
  const after = source.slice(token.index + token.match[0].length);
  const content = token.kind === 'emphasis' ? token.match[2] : token.match[1];
  let element: JSX.Element;
  switch (token.kind) {
    case 'code': element = <code>{content}</code>; break;
    case 'strong': element = <strong>{inline(content, depth + 1)}</strong>; break;
    case 'strike': element = <del>{inline(content, depth + 1)}</del>; break;
    case 'emphasis': {
      const leadingSpace = token.match[0].startsWith(' ') ? ' ' : '';
      element = <>{leadingSpace}<em>{inline(content, depth + 1)}</em></>;
      break;
    }
    case 'link': {
      const href = safeHref(token.match[2]);
      element = href ? <a href={href} target="_blank" rel="noreferrer">{inline(content, depth + 1)}</a> : <>{token.match[0]}</>;
      break;
    }
  }
  return [...inline(before, depth + 1), element, ...inline(after, depth + 1)];
}

function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
}

function isTableDivider(line: string): boolean {
  const cells = tableCells(line);
  return cells.length > 1 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
}

function listMatch(line: string) {
  return /^\s*([-+*]|(\d+)[.)])\s+(.+)$/.exec(line);
}

function isBlockStart(lines: string[], index: number): boolean {
  const line = lines[index] ?? '';
  return /^\s*```/.test(line)
    || /^\s{0,3}#{1,4}\s+/.test(line)
    || /^\s*>/.test(line)
    || /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)
    || Boolean(listMatch(line))
    || (line.includes('|') && isTableDivider(lines[index + 1] ?? ''));
}

function blocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const output: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }

    const fence = /^\s*```([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index])) code.push(lines[index++]);
      if (index < lines.length) index += 1;
      output.push({ kind: 'code', code: code.join('\n'), language: fence[1] || undefined });
      continue;
    }

    const heading = /^\s{0,3}(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      output.push({ kind: 'heading', level: heading[1].length as 1 | 2 | 3 | 4, text: heading[2] });
      index += 1;
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { output.push({ kind: 'rule' }); index += 1; continue; }

    if (line.includes('|') && isTableDivider(lines[index + 1] ?? '')) {
      const headers = tableCells(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) rows.push(tableCells(lines[index++]));
      output.push({ kind: 'table', headers, rows });
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) quote.push(lines[index++].replace(/^\s*>\s?/, ''));
      output.push({ kind: 'quote', text: quote.join(' ') });
      continue;
    }

    const firstListItem = listMatch(line);
    if (firstListItem) {
      const ordered = Boolean(firstListItem[2]);
      const items: string[] = [];
      const start = ordered ? Number(firstListItem[2]) : undefined;
      while (index < lines.length) {
        const item = listMatch(lines[index]);
        if (!item || Boolean(item[2]) !== ordered) break;
        items.push(item[3]);
        index += 1;
      }
      output.push({ kind: 'list', ordered, items, start });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines, index)) paragraph.push(lines[index++].trim());
    if (paragraph.length) output.push({ kind: 'paragraph', text: paragraph.join(' ') });
    else index += 1;
  }
  return output;
}

function Heading(props: { level: 1 | 2 | 3 | 4; text: string }) {
  if (props.level === 1) return <h1>{inline(props.text)}</h1>;
  if (props.level === 2) return <h2>{inline(props.text)}</h2>;
  if (props.level === 3) return <h3>{inline(props.text)}</h3>;
  return <h4>{inline(props.text)}</h4>;
}

export default function Markdown(props: { source: string }) {
  const parsed = createMemo(() => blocks(props.source));
  return <div class="markdown"><For each={parsed()}>{block => <Switch>
    <Match when={block.kind === 'paragraph'}><p>{inline((block as Extract<Block, { kind: 'paragraph' }>).text)}</p></Match>
    <Match when={block.kind === 'heading'}><Heading {...block as Extract<Block, { kind: 'heading' }>} /></Match>
    <Match when={block.kind === 'quote'}><blockquote>{inline((block as Extract<Block, { kind: 'quote' }>).text)}</blockquote></Match>
    <Match when={block.kind === 'rule'}><hr /></Match>
    <Match when={block.kind === 'code'}><pre data-language={(block as Extract<Block, { kind: 'code' }>).language}><code>{(block as Extract<Block, { kind: 'code' }>).code}</code></pre></Match>
    <Match when={block.kind === 'list'}>{(() => { const list = block as Extract<Block, { kind: 'list' }>; return <Show when={list.ordered} fallback={<ul><For each={list.items}>{item => <li>{inline(item)}</li>}</For></ul>}><ol start={list.start}><For each={list.items}>{item => <li>{inline(item)}</li>}</For></ol></Show>; })()}</Match>
    <Match when={block.kind === 'table'}>{(() => { const table = block as Extract<Block, { kind: 'table' }>; return <div class="markdown-table"><table><thead><tr><For each={table.headers}>{cell => <th>{inline(cell)}</th>}</For></tr></thead><tbody><For each={table.rows}>{row => <tr><For each={table.headers}>{(_, column) => <td>{inline(row[column()] ?? '')}</td>}</For></tr>}</For></tbody></table></div>; })()}</Match>
  </Switch>}</For></div>;
}
