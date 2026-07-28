# OMP Studio

Lightweight desktop interface for Oh My Pi, built with Tauri 2, Rust, SolidJS, and TypeScript. OMP remains the source of truth for sessions, providers, models, usage, resets, plugins, and agent events.

## Requirements

- Node.js 24+, npm 11+
- Rust 1.85+
- OMP 17+ available on `PATH`
- Linux: WebKitGTK 4.1 and GTK 3 development/runtime packages

## Development

```bash
npm ci
npm run tauri:dev
```

Validation commands:

```bash
npm run build
npm run test:rust
npm run benchmark
```

`npm run benchmark` measures the built `dist/` directory and fails above 350 KB JavaScript, 150 KB CSS, or 2 MB total frontend assets.

## Architecture

- `src/`: lazy-routed SolidJS UI, typed Tauri command client, virtualized sessions/conversation/catalog lists.
- `src-tauri/src/omp/`: one supervised `omp --mode rpc` child per active session, JSONL framing, correlated requests, timeouts, and shutdown cleanup.
- `src-tauri/src/usage/`: CLI/RPC usage normalization with per-account limits and explicit reset outcomes.
- `src-tauri/src/services/`: capability, Git, GitHub, and OMP catalog adapters with bounded TTL caches.
- `src-tauri/src/storage/`: versioned SQLite schema for projects, sessions, settings, cache metadata, diagnostics, and idempotent reset attempts.

Economy, Balanced, and Parallel policies cap live OMP processes at 1, 2, and 4. The selected policy is restored at startup. GitHub data is fetched only while the repository rail is mounted; usage polling honors visibility and the background-suspension setting.

## Security

- Provider credentials stay in OMP's broker and are never returned to the webview.
- Tauri exposes domain commands only; there is no arbitrary shell or unrestricted filesystem command.
- Project and file paths are canonicalized and constrained to the opened project.
- Provider, role, model, scope, package, and idempotency inputs are validated before process execution or persistence.
- The webview capability grants only core defaults and directory-open dialog access; CSP denies remote scripts and content.
- Saved rate-limit resets require an explicit destructive confirmation and a UUID idempotency key. Never exercise a real reset during testing without the account owner's approval.
- Runtime logs rotate at 4 MB and do not include credential values.

## Packaging

Tauri bundle targets are configured for AppImage, deb, rpm, NSIS, MSI, dmg, and app bundles; each target must be built on its supported host OS.

```bash
npm run package:linux    # AppImage, deb, rpm on Linux
npm run package:windows  # NSIS, MSI on Windows
npm run package:macos    # dmg, app on macOS
```

`packaging/PKGBUILD` builds an Arch package from the local checkout and installs the executable, icon, and desktop entry. Release Rust uses fat LTO, one codegen unit, abort-on-panic, and symbol stripping.

## Compatibility

Linux is the primary target. Windows and macOS use the same Tauri command contract but require native bundle verification on those platforms. Unsupported OMP commands are detected and surfaced through the capabilities/diagnostics UI instead of being simulated.
