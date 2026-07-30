## Target

OMP Studio startup path: `src/App.tsx`, `src-tauri/src/services/models.rs`, and `src-tauri/src/omp/manager.rs`.

## Dependents (6)

- `src/App.tsx`: gates `AppShell` on the settings and model resources.
- `src/api/invoke.ts`: maps frontend model and session calls to Tauri commands.
- `src/stores/appStore.ts`: consumes the model catalog and owns session single-flight state.
- `src-tauri/src/commands/studio.rs`: exposes model discovery and session lifecycle commands.
- `src-tauri/src/lib.rs`: registers commands and shuts down managed OMP processes.
- `src-tauri/src/usage/service.rs`: shares the OMP process manager.

## Affected Stories

No release plan exists in this repository.

## Test Coverage

- `src-tauri/src/services/models.rs`: model/provider response parsing.
- `src-tauri/src/omp/manager.rs`: per-session startup single-flight.
- `scripts/frontend-smoke.mjs`: rendered startup/workspace contracts.
- Gap: real OMP ready/timeout/crash and extension matrix are not covered by deterministic unit tests.

## Risk: High

Startup crosses SolidJS, Tauri, external OMP 17.2.1, user-installed extensions, child processes, and shutdown; the public RPC protocol must remain unchanged.

## Recommended action

Keep the current per-session manager, instrument opt-in timings, bypass extensions only for metadata-only CLI commands, render the shell independently of model discovery, and verify with real cold/warm OMP runs.
