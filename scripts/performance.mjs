import { gzipSync } from 'node:zlib';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

const root = new URL('../dist/', import.meta.url).pathname;
const limits = { javascript: 350_000, css: 150_000, total: 2_000_000 };

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]));
  return nested.flat();
}

const paths = await files(root);
const rows = await Promise.all(paths.map(async path => { const bytes = await readFile(path); return { path: relative(root, path), bytes: (await stat(path)).size, gzip: gzipSync(bytes).length }; }));
const totals = rows.reduce((result, row) => { result.total += row.bytes; if (row.path.endsWith('.js')) result.javascript += row.bytes; if (row.path.endsWith('.css')) result.css += row.bytes; return result; }, { javascript: 0, css: 0, total: 0 });
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), limits, totals, largest: rows.sort((a, b) => b.bytes - a.bytes).slice(0, 12) }, null, 2));
const failures = Object.entries(limits).filter(([key, limit]) => totals[key] > limit);
if (failures.length) { console.error(`Bundle budget exceeded: ${failures.map(([key, limit]) => `${key} ${totals[key]}/${limit}`).join(', ')}`); process.exitCode = 1; }
