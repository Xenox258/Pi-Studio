# OMP Studio startup latency

## Reproduce

Environment: Linux 6.12 x86_64, OMP 17.2.1 at `/home/teob/.local/bin/omp`, branch `feat/commit-features` at `d9c6b7e`. The default profile has six enabled packages. `omp models --json` exceeded 25 seconds and blocked the application shell. `omp --profile omp-studio-benchmark-empty --mode rpc` reached `ready` in 1435.5 ms.

## Isolate

Fresh isolated profiles with copied model/auth state and one linked package produced these observed first-run totals/readiness: pr-review 2235.4 ms, bigpowers 2393.0 ms, context-mode 2887.3 ms, pi-lens 5647.3 ms, pi-mcp-adapter ready 10940.0 ms, pi-subagents ready 7771.7 ms. The installed OMP loader imports extension modules sequentially.

## Hypothesize

1. Main GUI delay: `App` awaits `omp models --json`, and this metadata-only command auto-loads every enabled extension. Falsification: run the same command with OMP 17.2.1 `--no-extensions`.
2. Backend delay: pi-mcp-adapter, pi-subagents, and pi-lens execute eager import/factory/session-start work. Falsification: isolated one-extension RPC profiles.
3. OMP core itself is slow. Falsification: measure RPC ready with no extensions and compare to the 3–5 second target.
4. GUI respawns OMP per message/tab. Falsification: trace `OmpProcessManager::start` and frontend single-flight maps.

## Verify

Hypothesis 1 confirmed: `omp --no-extensions models --json` returned the same 34-model catalog in 1244.8 ms; default `omp models --json` timed out after 25 seconds. Hypothesis 2 confirmed by isolated costs and source inspection: pi-mcp-adapter may perform a 30-second npm cache population before connecting MCP servers; pi-lens awaits LSP/scanner bootstrap; pi-subagents restores watchers/artifacts. Hypothesis 3 rejected: extension-free OMP RPC ready is about 1.4 seconds. Hypothesis 4 rejected: processes are keyed and reused by session, starts are single-flight, and prompts reuse the existing child.

Confirmed root cause: unnecessary extension loading in the metadata-only model bootstrap is the application-launch blocker; eager third-party extension initialization is the remaining first-session backend cost.

## After fix

A real optimized release launch under Hyprland mapped the window in 310.43 ms. Native backend setup completed in 1 ms at 255.61 ms; extension-free model discovery completed in 1587 ms at 2031.38 ms. Three direct metadata runs averaged 1258.26 ms. Extension-free RPC measured 2157.25 ms first and 2747.06 ms subsequent. The complete extension set remains 18102.63 ms mean, but is no longer loaded for application/model bootstrap and is deferred until a conversational session actually starts.

Validation: production web build, TypeScript check, 35 frontend assertions, 106 integration assertions, 40 Rust tests, optimized Tauri build, live Hyprland launch, failing-extension isolation, process-group cleanup, and browser-rendered workspace all passed. No lint script is configured; `npm run lint --if-present` exited successfully without running a linter.
