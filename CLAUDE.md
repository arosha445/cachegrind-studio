# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

**Cachegrind Studio** — a web-based analyzer for PHP Xdebug profiles (`cachegrind.out` files). A replacement for Webgrind and KCachegrind, plus an MCP server so agents can read profiles.

Read `README.md` for user-facing context and the roadmap. This file covers how to work in the codebase.

## Repository layout

```
packages/
  parser/       ✅ Framework-free TypeScript. Callgrind bytes → columnar typed arrays.
  web/          ✅ React 19 SPA. Canvas flame graph. (React Flow graphs land in v0.2.)
  mcp/          ⬜ Node MCP server. Imports packages/parser.            (v0.4)
  php-server/   ⬜ ~300 lines, PHP 7.4+. Discovery, streaming, preflight. (v0.15)
apps/
  playground/   ⬜ Hosted demo with sample profiles.                    (v1.0)
fixtures/       ✅ Real cachegrind files used by the test suite. Do not delete.
```

✅ exists today; ⬜ is planned and the directory is not there yet. Do not assume a
package exists because this file names it.

pnpm workspaces. Run commands from the repo root unless noted.

## Commands

```bash
pnpm install
pnpm dev                     # web UI on :5173
pnpm test                    # vitest, all packages
pnpm test --project parser   # single package (NOT --filter; vitest projects, not pnpm filters)
pnpm bench                   # parser benchmarks
pnpm typecheck
pnpm lint
pnpm build                   # static SPA into packages/web/dist
pnpm fixtures:generate       # re-run the PHP workload under Xdebug, refresh fixtures/callgrind
```

`pnpm fixtures:generate` needs a local PHP with Xdebug 3 on `PATH`. It is the only
command that does; everything else is Node-only.

There is no `composer test` / `composer analyse` yet — `packages/php-server` does not
exist. Add them with the package in v0.15.

Run `pnpm typecheck`, `pnpm test` and `pnpm lint` before considering a change complete.
Run `pnpm bench` for anything touching `packages/parser`, the flame-graph builder, or the
canvas renderer.

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

The flame graph has its own, much larger ceiling (`maxNodes`, 200,000) because it draws to canvas rather than to React Flow. Do not confuse the two numbers. What matters in both cases is that hitting the ceiling **stops the traversal**, not just the emission: an earlier flame builder kept walking a dense call graph after the ceiling and spent 18 s visiting 88 million subtrees. `pnpm bench` has a dense-graph case guarding this.

**5. The PHP server never parses profile data.**
It lists files, streams raw bytes, serves source files, and reports environment state. If a task seems to need parsing in PHP, it belongs in the parser package instead.

**6. The drop-in must work with zero tooling.**
No Composer autoloader, no `node_modules`, no build step at install time. `packages/php-server` uses plain `require`. Target **PHP 7.4**, not 8.1 — XAMPP/WAMP installs lag badly, and that audience is the primary distribution target.

## Format gotchas

Xdebug's Callgrind output has sharp edges. Most parser bugs are one of these:

- **Name compression.** `fn=(1) name` defines ID 1; a later bare `fn=(1)` references it. There are **two** namespaces, not one per spec type: `fl`/`fi`/`fe`/`cfl`/`cfi` share the file namespace, and `fn`/`cfn` share the function namespace. So `cfl=(2)` genuinely refers to whatever `fl=(2)` defined. Verified against real Xdebug 3.5.1 output — an earlier revision of this file claimed a separate namespace per spec type, and that is wrong.
- **`cfl=` may or may not be present** on call lines. [Xdebug bug #489](https://bugs.xdebug.org/view.php?id=489) is fixed in 3.5.1, which emits it; older versions omit it. Handle both: a function's file comes from its own `fl=`+`fn=` record, which is authoritative, and `cfl=` is only a fallback for a callee that never got its own record.
- **Xdebug 2 vs 3 time units differ.** Resolve in this order: (1) the event name, since Xdebug 3.1+ writes `events: Time_(10ns) Memory_(bytes)` and states the unit outright; (2) the `creator:` version — Xdebug 2.x is microseconds, 3.x is 10 ns; (3) neither, so assume microseconds and mark it `assumed` so the UI can say so. Symptom of getting this wrong: times inflated by orders of magnitude (a 16 s call showing as 1,095,246 ms). See webgrind#132. Note the step-2 rule for a bare `Time` under Xdebug 3.0 is inference from the 3.1+ behaviour, not verified against a 3.0 binary.
- **Regular cost lines are self (exclusive) cost.** The cost line following `calls=` is inclusive cost of that call. Conflating them corrupts every view.
- **Repeated cost lines for the same position must be summed**, not overwritten. Xdebug emits one record per *invocation*, so this is the common case, not an edge case — it is also why a large profile has millions of cost lines but only tens of thousands of distinct positions.
- **`summary:` may be absent.** Fall back to computing totals; do not divide by zero and render everything as 0.00% (webgrind#125).
- **`summary:` does not equal the sum of self costs.** It runs slightly *above* it — Xdebug times the whole request, including work outside any function record. Measured at ~0.02% on the reference fixture. Do not assert equality; the mismatch warning fires at 0.5%, which catches real truncation without firing on every healthy profile.
- **Self cost is charged to a function's declaration line**, not spread across its body. A source gutter showing self cost alone therefore puts every number on a `function foo()` line. The useful second number is the inclusive cost of calls made *from* each line, which the call table has via the caller's line (`callSiteCostsForFile`).
- **Internal functions** are `fl=php:internal` / `fn=php::name`. Includes are pseudo-functions: `require::/path`, `include_once::/path`.
- **Files are gzipped by default** since Xdebug 3.1 — but `xdebug.use_compression` is a no-op on at least some Windows builds, so do not rely on the setting or the filename. Sniff the `1f 8b` magic bytes.
- **Memory is a second event column.** Do not assume a single cost value per line. Freed memory legitimately reads as 0.

When fixing a parser bug, add a fixture to `fixtures/` reproducing it, and add a row to
`fixtures/README.md` saying what it pins down.

## Conventions

- TypeScript strict, `noUncheckedIndexedAccess` on. No `any` in `packages/parser`.
- Prefer plain functions and typed arrays over classes in the parser hot path.
- Node components in React Flow views must be memoized — React Flow re-renders aggressively.
- The graph module is lazy-loaded via route-level dynamic import. Keep it that way; first paint matters for the XAMPP audience on modest hardware.
- PHP: PSR-12, PHPStan level 8, no framework dependencies.
- Windows paths are first-class. Backslashes, drive letters, `C:\xampp\tmp`, case-insensitive comparison. Do not assume POSIX.

## Testing

- Parser changes need a fixture-based test. `fixtures/README.md` documents what each file pins down; read it before adding another.
- Fixtures are committed **byte-exact**. `.gitattributes` marks `fixtures/callgrind/**` as `-text` so line-ending normalisation cannot silently change their length between platforms. Never remove that rule.
- Large profiles are **not** committed and not downloaded either. `packages/parser/bench/synthetic.ts` generates a realistically-shaped profile at any size; use it instead of a fixture for anything size-dependent. (There is no `pnpm fixtures:download`.)
- Performance-sensitive changes need a `pnpm bench` before/after in the PR description.
- Preflight logic needs tests against synthetic `phpinfo`-style inputs covering: Xdebug absent, Xdebug 2.x, mode misconfigured, `output_dir` missing, `output_dir` unwritable, no profile files present. (Arrives with `packages/php-server` in v0.15.)

**Known gap:** there is no Playwright E2E suite yet. The v0.1 renderer was verified by
hand in a browser, including against the production build, but nothing automated asserts
that the flame graph renders. Standing up "load a fixture, assert the canvas draws" is the
first thing to add before the renderer grows.

### Current baseline

Measured on this machine, for comparison after changes:

| | |
|---|---|
| Scan throughput | ~167 MB/s (`pnpm bench`, synthetic 32 MB) |
| 120 MB profile, drop → rendered, in-browser | 2.16 s |
| Worst main-thread frame during that parse | 34 ms |
| Production bundle | 249 KB JS (78 KB gzipped) + 15 KB worker |

The v0.1 criterion was 100–200 MB in ~5 s with no tab freeze, so there is real headroom —
which is the evidence for *not* reaching for WASM yet.

## When working on this project

**Ask before:** changing the parser's public interface (`bytes → columnar profile`), adding a dependency to `packages/parser`, raising the PHP version floor, or adding anything to the drop-in that requires a build step.

**Don't:** copy code from KCachegrind (GPL-2.0 — this project is a clean-room implementation from the published format spec). speedscope is MIT and may be referenced with attribution.

**Do:** benchmark before optimizing. The assumption that parsing is the bottleneck is unverified — rendering and layout are equally likely culprits. If TypeScript parsing genuinely dominates on 200MB+ files, the parser interface is deliberately narrow enough to swap for WASM without touching the UI. That decision should follow measurements, not precede them.

**On profiling accuracy:** Xdebug's profiler overhead is significant and uneven. The UI must not present absolute wall-clock times as real-world performance. Keep the caveat visible; do not remove it to make a view look cleaner.

## Decisions already taken

Settled during v0.1. Revisit them deliberately, not by accident.

- **No `fflate`.** Gzip uses the platform `DecompressionStream` only. Adding fflate would be the parser's first runtime dependency, and the support floor does not currently need lowering. `packages/parser/src/gzip.ts` has a documented seam where it would go.
- **Cost values stay in raw file units** everywhere, converted to milliseconds only at render time via `meta.timeToMs`. Summing, diffing and re-aggregating therefore never accumulate rounding error — which matters most for v0.3 diffing.
- **The flame builder does not prune by cost.** `minFraction` defaults to 0 and culling happens at draw time, where the zoom level is known. Dropping a frame at build time makes it unreachable however far the user zooms in, which is exactly when they want it. `maxNodes` is the safety valve, not the threshold.
- **No TanStack Router and no shadcn/ui yet.** v0.1 is a single view with tab state and a handful of hand-rolled Tailwind components. Router earns its place with the lazy-loaded graph route in v0.2 — that is the moment to add it, and the moment to honour the "graph module is lazy-loaded" convention below.
- **Columns are typed as `Int32Array<ArrayBuffer>` / `Float64Array<ArrayBuffer>`** (aliases `I32`/`F64`/`U8` in `types.ts`), not the default `ArrayBufferLike`. That is what `postMessage` transfer lists require, and stating it stops a `SharedArrayBuffer` silently turning a zero-copy handoff into a structured clone.

## Current focus

See the roadmap table in `README.md`.

**v0.1 is complete** — Worker parser, canvas flame graph + icicle, function table, source
annotation, drag-and-drop, static web app. Its success criterion is met with headroom (see
Current baseline above).

Present milestone: **v0.15** — reach the people who cannot profile today. XAMPP/WAMP
drop-in zip, PHP 7.4+ thin server, preflight status page with generated ini snippets and a
re-verify loop, Windows path handling. Success criterion: a Windows XAMPP user with Xdebug
not yet configured reaches a rendered flame graph without leaving the tool or searching the
web.

Two things v0.1 left on the table that v0.15 should pick up:

- **Source annotation has no source.** The static build can only show line costs unless the user attaches a file by hand. `php-server` serving source files is what makes that view whole.
- **The Playwright gap above**, which should close before the renderer grows further.
