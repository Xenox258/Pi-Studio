import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { createInterface } from 'node:readline';

const STDERR_LIMIT = 256 * 1024;
const TERMINATION_GRACE_MS = 1_000;
const KILL_GRACE_MS = 500;
const POLL_INTERVAL_MS = 25;
const VALUE_OPTIONS = new Set(['--profile', '--plugin-dir', '--runs', '--timeout-ms', '--cwd', '--label']);
const BOOLEAN_OPTIONS = new Set(['--no-extensions']);

function parseArguments(argv) {
  const options = { profiles: [], pluginDirs: [], noExtensions: false, runs: 5, timeoutMs: 30_000, cwd: process.cwd(), label: null };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const separator = argument.indexOf('=');
    const name = separator === -1 ? argument : argument.slice(0, separator);
    if (BOOLEAN_OPTIONS.has(name)) {
      if (separator !== -1) throw new Error(`${name} does not take a value`);
      options.noExtensions = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) throw new Error(`Unknown option: ${name}`);

    const inlineValue = separator === -1 ? null : argument.slice(separator + 1);
    const value = inlineValue ?? argv[++index];
    if (value === undefined || value === '') throw new Error(`Missing value for ${name}`);

    switch (name) {
      case '--profile':
        options.profiles.push(value);
        break;
      case '--plugin-dir':
        options.pluginDirs.push(value);
        break;
      case '--runs':
        options.runs = positiveInteger(name, value);
        break;
      case '--timeout-ms':
        options.timeoutMs = positiveInteger(name, value);
        break;
      case '--cwd':
        options.cwd = value;
        break;
      case '--label':
        options.label = value;
        break;
    }
  }

  return options;
}

function positiveInteger(name, value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function groupExists(child) {
  if (!child.pid) return false;
  try {
    if (process.platform === 'win32') process.kill(child.pid, 0);
    else process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    return true;
  }
}

function signalPosixGroup(child, signal) {
  if (!child.pid) return false;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function taskkillWindowsTree(pid) {
  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let taskkill;
    try {
      taskkill = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      finish({ started: false, succeeded: false });
      return;
    }
    taskkill.once('error', () => finish({ started: false, succeeded: false }));
    taskkill.once('close', exitCode => finish({ started: true, succeeded: exitCode === 0 }));
  });
}

async function waitForGroupExit(child, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (groupExists(child) && performance.now() < deadline) await delay(POLL_INTERVAL_MS);
  return !groupExists(child);
}

async function waitForChildClose(child, timeoutMs) {
  if (child.stdout.readableEnded && child.stderr.readableEnded) return;
  await new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      child.off('close', finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    child.once('close', finish);
  });
}

const terminations = new WeakMap();

function terminateGroup(child) {
  const existing = terminations.get(child);
  if (existing) return existing;

  const termination = (async () => {
    const cleanup = { sigtermSent: false, sigkillSent: false, taskkillSent: false, groupStopped: null };
    if (!child.pid) return cleanup;

    if (process.platform === 'win32') {
      if (!groupExists(child)) return cleanup;
      const taskkill = await taskkillWindowsTree(child.pid);
      cleanup.taskkillSent = taskkill.started;
      const pidStopped = await waitForGroupExit(child, KILL_GRACE_MS);
      cleanup.groupStopped = taskkill.succeeded && pidStopped;
      return cleanup;
    }

    if (!groupExists(child)) {
      cleanup.groupStopped = true;
      return cleanup;
    }
    cleanup.sigtermSent = signalPosixGroup(child, 'SIGTERM');
    if (await waitForGroupExit(child, TERMINATION_GRACE_MS)) {
      cleanup.groupStopped = true;
      return cleanup;
    }

    cleanup.sigkillSent = signalPosixGroup(child, 'SIGKILL');
    cleanup.groupStopped = await waitForGroupExit(child, KILL_GRACE_MS);
    return cleanup;
  })();

  terminations.set(child, termination);
  return termination;
}

function createStderrCapture(enabled) {
  const decoder = new StringDecoder('utf8');
  let text = '';
  let truncated = false;

  function append(value) {
    if (!enabled || value.length === 0) return;
    const available = STDERR_LIMIT - text.length;
    if (available > 0) text += value.slice(0, available);
    if (value.length > available) truncated = true;
  }

  return {
    write(chunk) { append(decoder.write(chunk)); },
    end() { append(decoder.end()); },
    result() {
      if (!enabled) return undefined;
      return {
        stderr: text,
        truncated,
        startupLogs: text.split(/\r?\n/).filter(line => line.startsWith('[startup]')),
      };
    },
  };
}

function observeStartup(child, timeoutMs) {
  return new Promise(resolve => {
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ status: 'timeout' }), timeoutMs);

    lines.on('line', line => {
      try {
        if (JSON.parse(line)?.type === 'ready') finish({ status: 'ready' });
      } catch {}
    });
    lines.once('close', () => {
      if (!settled && child.exitCode === null && child.signalCode === null) finish({ status: 'stdout_closed' });
    });
    child.stdout.once('error', error => finish({ status: 'stdout_error', message: error.message }));
    child.once('error', error => finish({ status: 'spawn_failed', message: error.message }));
    child.once('exit', (exitCode, signal) => finish({
      status: requestedSignal ? 'signal' : 'exited',
      exitCode,
      signal,
    }));
  });
}

let requestedSignal = null;
let activeChild = null;

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    requestedSignal ??= signal;
    if (activeChild) void terminateGroup(activeChild);
  });
}

async function measureRun(profile, run, options, captureDiagnostics) {
  const args = ['--mode', 'rpc'];
  if (profile !== null) args.push('--profile', profile);
  if (options.noExtensions) args.unshift('--no-extensions');
  for (const pluginDir of options.pluginDirs) args.push('--plugin-dir', pluginDir);

  const started = performance.now();
  let child;
  try {
    child = spawn('omp', args, {
      cwd: options.cwd,
      detached: true,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    return {
      run,
      sequence: run === 1 ? 'first' : 'subsequent',
      status: 'spawn_failed',
      durationMs: Number((performance.now() - started).toFixed(2)),
      message: error.message,
      cleanup: { sigtermSent: false, sigkillSent: false, taskkillSent: false, groupStopped: null },
    };
  }

  activeChild = child;
  const stderr = createStderrCapture(captureDiagnostics);
  child.stderr.on('data', chunk => stderr.write(chunk));
  child.stderr.once('end', () => stderr.end());
  child.stderr.once('error', error => stderr.write(Buffer.from(`\n${error.message}`)));

  const outcome = await observeStartup(child, options.timeoutMs);
  const durationMs = Number((performance.now() - started).toFixed(2));
  const cleanup = await terminateGroup(child);
  await waitForChildClose(child, KILL_GRACE_MS);
  if (activeChild === child) activeChild = null;

  const result = {
    run,
    sequence: run === 1 ? 'first' : 'subsequent',
    ...outcome,
    durationMs,
    cleanup,
  };
  const diagnostics = stderr.result();
  if (diagnostics) result.diagnostics = diagnostics;
  return result;
}

function rounded(value) {
  return value === null ? null : Number(value.toFixed(2));
}

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarize(runs) {
  const successful = runs.filter(run => run.status === 'ready');
  const allDurations = successful.map(run => run.durationMs);
  const subsequentDurations = successful.filter(run => run.run > 1).map(run => run.durationMs);
  const first = runs.find(run => run.run === 1);

  return {
    attempted: runs.length,
    successful: successful.length,
    failed: runs.length - successful.length,
    firstRunMs: first?.status === 'ready' ? first.durationMs : null,
    subsequentRuns: {
      samples: subsequentDurations.length,
      meanMs: rounded(mean(subsequentDurations)),
      medianMs: rounded(median(subsequentDurations)),
    },
    meanMs: rounded(mean(allDurations)),
    medianMs: rounded(median(allDurations)),
  };
}

async function runBenchmark(options) {
  const captureDiagnostics = process.env.PI_DEBUG_STARTUP === '1';
  const profiles = options.profiles.length === 0 ? [null] : options.profiles;
  const benchmarks = [];

  for (const profile of profiles) {
    const runs = [];
    for (let run = 1; run <= options.runs && !requestedSignal; run += 1) {
      runs.push(await measureRun(profile, run, options, captureDiagnostics));
    }
    benchmarks.push({ profile, runs, summary: summarize(runs) });
    if (requestedSignal) break;
  }

  const attempted = benchmarks.reduce((total, benchmark) => total + benchmark.summary.attempted, 0);
  const successful = benchmarks.reduce((total, benchmark) => total + benchmark.summary.successful, 0);
  return {
    generatedAt: new Date().toISOString(),
    label: options.label,
    command: { executable: 'omp', mode: 'rpc', cwd: options.cwd },
    configuration: {
      profiles: options.profiles,
      pluginDirs: options.pluginDirs,
      noExtensions: options.noExtensions,
      runs: options.runs,
      timeoutMs: options.timeoutMs,
      piDebugStartup: captureDiagnostics,
      piTiming: process.env.PI_TIMING ?? null,
    },
    interruptedBy: requestedSignal,
    benchmarks,
    summary: { attempted, successful, failed: attempted - successful },
  };
}

let report;
try {
  const options = parseArguments(process.argv.slice(2));
  report = await runBenchmark(options);
  const failed = report.summary.failed > 0 || report.interruptedBy !== null;
  if (report.interruptedBy === 'SIGINT') process.exitCode = 130;
  else if (report.interruptedBy === 'SIGTERM') process.exitCode = 143;
  else if (failed) process.exitCode = 1;
} catch (error) {
  if (activeChild) await terminateGroup(activeChild);
  report = { generatedAt: new Date().toISOString(), error: error.message };
  process.exitCode = requestedSignal === 'SIGINT' ? 130 : requestedSignal === 'SIGTERM' ? 143 : 2;
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
