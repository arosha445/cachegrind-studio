# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

**Cachegrind Studio** — a web-based analyzer for PHP Xdebug profiles (`cachegrind.out` files). A replacement for Webgrind and KCachegrind, plus an MCP server so agents can read profiles.

Read `README.md` for user-facing context and the roadmap. This file covers how to work in the codebase.

## Repository layout

```
packages/
  parser/       Framework-free TypeScript. Callgrind bytes → columnar typed arrays.
  web/          React 19 SPA. Canvas flame graph, React Flow graphs.
  mcp/          Node MCP server. Imports packages/parser.
  php-server/   ~300 lines, PHP 7.4+. File discovery, byte streaming, preflight.
apps/
  playground/   Hosted demo with sample profiles.
fixtures/       Real cachegrind files used by the test suite. Do not delete.
```

pnpm workspaces. Run commands from the repo root unless noted.

## Commands

```bash
pnpm install
pnpm dev                    # web UI on :5173
pnpm test                   # vitest, all packages
pnpm test --filter parser   # single package
pnpm bench                  # parser benchmarks
pnpm typecheck
pnpm lint
pnpm build                  # builds dist/ consumed by php-server and the drop-in zip

# PHP side
composer test               # phpunit
composer analyse            # phpstan level 8
```

Run `pnpm typecheck` and `pnpm test` before considering a change complete. Run `pnpm bench` for anything touching `packages/parser` or the canvas renderer.

## Invariants

These are load-bearing. Breaking them causes the exact failures this project exists to fix.

**1. Frames are never DOM nodes.**
The flame graph draws to canvas. The function table is virtualized (TanStack Virtual). The call tree renders only what's visible. Rendering N frames as N DOM elements is what makes Webgrind crash — do not reintroduce it. React Flow graph views are the single exception, and only because they are hard-capped at a few hundred curated nodes (see invariant 4).

**2. `packages/parser` never imports from `packages/web`.**
The parser is shared by the browser, the MCP server, and any future CLI. It must stay free of React, DOM APIs, and Node-only APIs. An ESLint boundary rule enforces this; if you find yourself wanting to relax it, the abstraction is wrong somewhere else.

**3. Parsing happens in a Web Worker, over bytes.**
Read `ArrayBuffer`/`Uint8Array` and scan byte-wise. Never `TextDecoder` the whole file into a string, never `.split('\n')` on the full contents — that is the memory blowup. Decode only name payloads, via `TextDecoder` on subslices. Intern names to integer IDs. Costs go into `Int32Array`/`Float64Array` columns. Transfer results with `postMessage(payload, [transferables])`.

**4. Graph views are capped and curated.**
Subgraphs are built in the Worker over the columnar edge table and returned with ≤300 nodes. Enforce a hard ceiling (400) with a "raise the cost threshold" message rather than letting a pathological profile lock the tab. Layout (Dagre/ELK) also runs in a Worker — layout is what janks, not rendering.

**5. The PHP server never parses profile data.**
It lists files, streams raw bytes, serves source files, and reports environment state. If a task seems to need parsing in PHP, it belongs in the parser package instead.

**6. The drop-in must work with zero tooling.**
No Composer autoloader, no `node_modules`, no build step at install time. `packages/php-server` uses plain `require`. Target **PHP 7.4**, not 8.1 — XAMPP/WAMP installs lag badly, and that audience is the primary distribution target.

## Format gotchas

Xdebug's Callgrind output has sharp edges. Most parser bugs are one of these:

- **Name compression.** `fn=(1) name` defines ID 1; a later bare `fn=(1)` references it. Separate ID namespaces per spec type (`fl`, `fn`, `cfl`, `cfn`). Missing this produces wrong-but-plausible output.
- **Xdebug omits `cfl=`** on call lines ([Xdebug bug #489](https://bugs.xdebug.org/view.php?id=489)). Resolve the called file from the callee's own `fn=` definition.
- **Xdebug 2 vs 3 time units differ.** Detect the `creator:` header and normalize. Symptom of getting this wrong: times inflated by orders of magnitude (a 16s call showing as 1,095,246ms). See webgrind#132.
- **Regular cost lines are self (exclusive) cost.** The cost line following `calls=` is inclusive cost of that call. Conflating them corrupts every view.
- **Repeated cost lines for the same position must be summed**, not overwritten.
- **`summary:` may be absent.** Fall back to computing totals; do not divide by zero and render everything as 0.00% (webgrind#125).
- **Internal functions** are `fl=php:internal` / `fn=php::name`. Includes are pseudo-functions: `require::/path`, `include_once::/path`.
- **Files are gzipped by default** since Xdebug 3.1. Use `DecompressionStream('gzip')`, fall back to `fflate`.
- **Memory is a second event column.** Do not assume a single cost value per line. Freed memory legitimately reads as 0.

When fixing a parser bug, add a fixture to `fixtures/` reproducing it.

## Conventions

- TypeScript strict, `noUncheckedIndexedAccess` on. No `any` in `packages/parser`.
- Prefer plain functions and typed arrays over classes in the parser hot path.
- Node components in React Flow views must be memoized — React Flow re-renders aggressively.
- The graph module is lazy-loaded via route-level dynamic import. Keep it that way; first paint matters for the XAMPP audience on modest hardware.
- PHP: PSR-12, PHPStan level 8, no framework dependencies.
- Windows paths are first-class. Backslashes, drive letters, `C:\xampp\tmp`, case-insensitive comparison. Do not assume POSIX.

## Testing

- Parser changes need a fixture-based test. `fixtures/` holds real cachegrind files — small ones are committed, large ones are fetched by `pnpm fixtures:download`.
- Performance-sensitive changes need a `pnpm bench` before/after in the PR description.
- E2E (Playwright) loads a fixture and asserts the flame graph renders. Run it for renderer changes.
- Preflight logic needs tests against synthetic `phpinfo`-style inputs covering: Xdebug absent, Xdebug 2.x, mode misconfigured, `output_dir` missing, `output_dir` unwritable, no profile files present.

## When working on this project

**Ask before:** changing the parser's public interface (`bytes → columnar profile`), adding a dependency to `packages/parser`, raising the PHP version floor, or adding anything to the drop-in that requires a build step.

**Don't:** copy code from KCachegrind (GPL-2.0 — this project is a clean-room implementation from the published format spec). speedscope is MIT and may be referenced with attribution.

**Do:** benchmark before optimizing. The assumption that parsing is the bottleneck is unverified — rendering and layout are equally likely culprits. If TypeScript parsing genuinely dominates on 200MB+ files, the parser interface is deliberately narrow enough to swap for WASM without touching the UI. That decision should follow measurements, not precede them.

**On profiling accuracy:** Xdebug's profiler overhead is significant and uneven. The UI must not present absolute wall-clock times as real-world performance. Keep the caveat visible; do not remove it to make a view look cleaner.

## Current focus

See the roadmap table in `README.md`. Present milestone: **v0.1** — Worker parser, canvas flame graph, function table, source annotation, drag-and-drop, static web app. Success criterion: a 100–200MB gzipped profile opens in under ~5 seconds with no tab freeze.
