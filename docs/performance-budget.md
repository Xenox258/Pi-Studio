# Performance budget

Measured on 2026-07-20 on Linux 6.12, x86_64, with the optimized Tauri release profile and no active OMP session. Memory is proportional set size (PSS), which avoids counting shared WebKitGTK pages once per process.

| Metric | Budget | Observed | Status |
| --- | ---: | ---: | --- |
| WebKit process spawn after native launch | < 800 ms window-visible target | 240 ms | Proxy only; window visibility was not instrumented |
| Idle memory, Tauri process tree | 150 MB maximum | 205.3 MB PSS | Over budget |
| Idle CPU, 10 s sample | < 1% | 0.0% | Pass |
| Hydrated workspace DOM | 1,500 nodes | 170 nodes | Pass |
| JavaScript bundle | 350,000 bytes | 136,559 bytes | Pass |
| CSS bundle | 150,000 bytes | 32,066 bytes | Pass |
| Total frontend assets | 2,000,000 bytes | 240,329 bytes | Pass |

## Memory analysis

The steady-state 200–205 MB PSS is dominated by the native WebKitGTK baseline, not the document tree:

- OMP Studio process: 72.3 MB PSS
- WebKit network process: 18.3 MB PSS
- WebKit web process: 109.5 MB PSS
- hydrated workspace: 170 DOM nodes

Restricting Manrope to four Latin WOFF2 files reduced frontend assets from 581,793 to 240,329 bytes and measured idle PSS from 221.8 to 205.3 MB. The 150 MB maximum remains unmet on this workstation; hiding UI or removing application behavior would not remove the WebKitGTK process baseline.

## Reproduction

```bash
npm run build
npm run benchmark
npm run tauri:build -- --bundles deb
./src-tauri/target/release/omp-studio
npm run benchmark:runtime -- --pid=<desktop-pid> --url=http://127.0.0.1:1420/
```

`benchmark:runtime` waits 10 seconds, samples the full native process tree for 10 seconds, renders the supplied URL in Chromium, and fails when RAM, CPU, or DOM budgets are exceeded. Run `npm run dev -- --host 127.0.0.1 --port 1420` when the benchmark URL is not already available.
