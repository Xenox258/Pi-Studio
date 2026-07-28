import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';

const argumentsMap = new Map(process.argv.slice(2).map(argument => {
  const [key, value = 'true'] = argument.split('=', 2);
  return [key, value];
}));
const rootPid = Number(argumentsMap.get('--pid') ?? 0);
const url = argumentsMap.get('--url') ?? 'http://127.0.0.1:1420/';
const sampleMs = Number(argumentsMap.get('--sample-ms') ?? 10000);
const warmupMs = Number(argumentsMap.get('--warmup-ms') ?? 10000);
const limits = { idleRamMb: 150, idleCpuPercent: 1, domNodes: 1500 };

async function processSnapshot() {
  const entries = await readdir('/proc', { withFileTypes: true });
  const processes = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      const [stat, memory] = await Promise.all([readFile(`/proc/${entry.name}/stat`, 'utf8'), readFile(`/proc/${entry.name}/smaps_rollup`, 'utf8')]);
      const fields = stat.trim().split(' ');
      const pssKb = Number(memory.match(/^Pss:\s+(\d+)/m)?.[1] ?? 0);
      processes.push({ pid: Number(entry.name), parent: Number(fields[3]), ticks: Number(fields[13]) + Number(fields[14]), pssKb });
    } catch {}
  }
  return processes;
}

function tree(snapshot, root) {
  const included = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of snapshot) if (included.has(process.parent) && !included.has(process.pid)) { included.add(process.pid); changed = true; }
  }
  return snapshot.filter(process => included.has(process.pid));
}

async function measureProcess() {
  if (!rootPid) return null;
  const clockTicks = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());
  await new Promise(resolve => setTimeout(resolve, warmupMs));
  const before = tree(await processSnapshot(), rootPid);
  const started = performance.now();
  await new Promise(resolve => setTimeout(resolve, sampleMs));
  const after = tree(await processSnapshot(), rootPid);
  const elapsedSeconds = (performance.now() - started) / 1000;
  const beforeTicks = new Map(before.map(process => [process.pid, process.ticks]));
  const tickDelta = after.reduce((total, process) => total + Math.max(0, process.ticks - (beforeTicks.get(process.pid) ?? process.ticks)), 0);
  return { processes: after.length, pssMb: Number((after.reduce((total, process) => total + process.pssKb, 0) / 1024).toFixed(1)), cpuPercent: Number((tickDelta / clockTicks / elapsedSeconds * 100).toFixed(2)) };
}

function measureDom() {
  const html = execFileSync('chromium', ['--headless', '--disable-gpu', '--no-sandbox', '--virtual-time-budget=3000', '--dump-dom', url], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] });
  return { url, nodes: (html.match(/<[a-z][^>]*>/gi) ?? []).length };
}

const [runtime, dom] = await Promise.all([measureProcess(), Promise.resolve().then(measureDom)]);
const failures = [];
if (runtime?.pssMb > limits.idleRamMb) failures.push(`idle proportional memory ${runtime.pssMb} MB > ${limits.idleRamMb} MB`);
if (runtime?.cpuPercent > limits.idleCpuPercent) failures.push(`idle CPU ${runtime.cpuPercent}% > ${limits.idleCpuPercent}%`);
if (dom.nodes > limits.domNodes) failures.push(`DOM nodes ${dom.nodes} > ${limits.domNodes}`);
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), limits, runtime, dom }, null, 2));
if (failures.length) { console.error(`Runtime budget exceeded: ${failures.join(', ')}`); process.exitCode = 1; }
