# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

**Cachegrind Studio** — an analyzer for PHP Xdebug profiles (`cachegrind.out` files) that installs into a PHP project as a dev dependency. A replacement for Webgrind and KCachegrind, with a browser UI, a headless CI mode, and an MCP server so agents can read profiles.

Read `README.md` for user-facing context and the roadmap. This file covers how to work in the codebase.

## Repository layout

```
packages/
  parser/       ✅ Framework-free TypeScript. Callgrind bytes → columnar typed arrays.
  web/          ✅ React 19 SPA. Canvas flame graph. Front-end #1: the UI.
  cli/          ⬜ Node. Front-end #2: headless JSON report + exit code.   (v0.3)
  mcp/          ⬜ Node. Front-end #3: stdio MCP server.                   (v0.25)
  php-server/   ⬜ ~300 lines, PHP 7.4+. Discovery, streaming, preflight,
                   run store. Never parses.                               (v0.15)
apps/
  playground/   ⬜ Hosted demo with sample profiles.                       (v1.0)
fixtures/       ✅ Real cachegrind files used by the test suite. Do not delete.
research/       ✅ Measurements behind design decisions. Re-run before overturning one.
```

✅ exists today; ⬜ is planned and the directory is not there yet. Do not assume a
package exists because this file names it.

pnpm workspaces. Run commands from the repo root unless noted.

## The shape of the product

Since v0.15 the tool is something you **install into a PHP project**, not a standalone
viewer you feed a file to. That changes what belongs where, so it is worth being explicit:

**One core, three front-ends.** `packages/parser` computes everything. `web`, `cli` and
`mcp` are thin adapters over the same `bytes → columnar profile` interface. A number in the
flame graph, a number asserted in CI, and a number an agent reads must be the *same* number
from the *same* code. Analysis that lands in one front-end and not the others is a design
mistake — push it down into the parser.

**The run store is what makes the project-installed version worth having.** A raw cachegrind
file has no identity: `cmd:` is the entry script, which for any framework is the same
`index.php` for every request. Diffing, history, aggregation and budgets all need a run that
knows its commit, branch and route. That metadata can only come from outside the file, which
is the whole argument for living in the repo. It is a directory of plain files
(`.cachegrind-studio/runs/`, raw bytes plus a small JSON manifest per run) — no daemon, no
migrations, and a run can be committed or uploaded as a CI artifact as-is.

**Two distributions, one codebase.** The Composer dev-dependency and the XAMPP/WAMP drop-in
zip are the same PHP server and the same built SPA, packaged differently. The drop-in is not
deprecated by the Composer route — it reaches people who have no Composer and no terminal,
and that audience is why the project exists. Anything that only works in one of the two is
a bug unless it is inherently project-scoped (per-package attribution, git metadata).

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

```bash
bash research/xdebug-overhead/run.sh   # reproduce the per-test instrumentation numbers
```

`pnpm fixtures:generate` and the research scripts need a local PHP with Xdebug 3 on
`PATH`. They are the only things that do; everything else is Node-only.

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
The parser is shared by the browser UI, the CLI and the MCP server — all three front-ends. It must stay free of React, DOM APIs, and Node-only APIs. An ESLint boundary rule enforces this; if you find yourself wanting to relax it, the abstraction is wrong somewhere else.

**3. Parsing happens in a Web Worker, over bytes.**
Read `ArrayBuffer`/`Uint8Array` and scan byte-wise. Never `TextDecoder` the whole file into a string, never `.split('\n')` on the full contents — that is the memory blowup. Decode only name payloads, via `TextDecoder` on subslices. Intern names to integer IDs. Costs go into `Int32Array`/`Float64Array` columns. Transfer results with `postMessage(payload, [transferables])`.

**4. Graph views are capped and curated.**
Subgraphs are built in the Worker over the columnar edge table and returned with ≤300 nodes. Enforce a hard ceiling (400) with a "raise the cost threshold" message rather than letting a pathological profile lock the tab. Layout (Dagre/ELK) also runs in a Worker — layout is what janks, not rendering.

The flame graph has its own, much larger ceiling (`maxNodes`, 200,000) because it draws to canvas rather than to React Flow. Do not confuse the two numbers. What matters in both cases is that hitting the ceiling **stops the traversal**, not just the emission: an earlier flame builder kept walking a dense call graph after the ceiling and spent 18 s visiting 88 million subtrees. `pnpm bench` has a dense-graph case guarding this.

**5. The PHP server never parses profile data.**
It lists files, streams raw bytes, serves source files, reports environment state, and maintains the run store. If a task seems to need parsing in PHP, it belongs in the parser package instead. Parsing in PHP is exactly what makes Webgrind fall over.

**6. The drop-in must work with zero tooling, and the Composer package must add zero weight.**
Two constraints on the same code:

- *Drop-in:* no Composer autoloader, no `node_modules`, no build step at install time. `packages/php-server` uses plain `require`. Target **PHP 7.4**, not 8.1 — XAMPP/WAMP installs lag badly, and that audience is the one that cannot profile at all today.
- *Composer package:* **zero runtime Composer dependencies.** Not "no framework dependencies" — zero. As a dev dependency it sits in the consumer's dependency graph, and anything it requires can conflict with the host application. The PHP 7.4 floor also stops being merely a target and becomes a compatibility promise: the projects most in need of profiling are the old ones.

The built JS bundle ships *inside* the released package, so release tooling has to build assets. `dist/` stays gitignored; it is a release artifact, not a source file.

**7. Everything that runs in a user's project is dev-only, and enforces it.**
It serves source code and profile data. `composer require --dev`, never `require` — and do not rely on the user getting that right. Bind to loopback only, refuse to start when a production environment is detected, and never auto-register routes into the host application via a service provider. This is cheap to build in now and very awkward to retrofit after someone has shipped it to production.

**8. Per-test counts come from the function monitor, and the log is read once.**
Measured in `research/xdebug-overhead/` — read that before touching this area.

- The profiler **cannot** produce per-test data. There is no `xdebug_start_profiling()`, `xdebug.mode` is `PHP_INI_SYSTEM` so it cannot be flipped at runtime, and one cachegrind file is written per *process* — meaning one per suite run, not one per test. Counts come from `xdebug_start_function_monitor()`, the only per-test-capable runtime API, which works in `develop` mode only.
- A suite-wide profile is not a substitute. It attributes a test's *direct* calls exactly, but any call reached through a shared intermediate has its edges merged across tests and is unrecoverable. Queries are always several layers deep.
- **Read the monitor log exactly once, at the end of the run.** `xdebug_get_monitored_functions()` returns the entire cumulative log on every call, so reading per test is quadratic: 12.8 s versus 0.49 s at 2,000 tests, and a hard OOM at 8,000. Delimit tests by calling a monitored no-op marker between them and split the log on the marker in one linear pass. Records carry no timestamp, so a marker is the only way to recover boundaries. `research/xdebug-overhead/verify_sentinel.php` proves this is exact; keep it passing.
- The log cannot be flushed — it is cumulative for the process lifetime, ~0.7 KB per record. Keep the monitored function list tight, and rely on per-process chunking for large suites.
- Never instrument the whole test suite by default. Xdebug's overhead is **per-opcode, not per-call** (50,000 calls and 1 call over the same work both cost ~100x), so it cannot be optimised away by restructuring code. Real-world cost ranges from 1x for I/O-bound time to ~7x for typical app code. A dedicated, opt-in performance suite is the supported shape.

**9. CI assertions are on counts, never on wall time.**
Xdebug's overhead is large and uneven (see the profiling-accuracy note below), and CI runners add their own variance on top. A wall-clock budget over Xdebug data fails on unrelated pull requests, and a check that cries wolf gets disabled within a fortnight — at which point the feature is worse than not shipping it. Assert on what is stable run to run: query counts, autoload counts, function call counts, allocation counts. Those are also what actually regresses. Report wall time alongside as advisory, clearly marked, never as a gate. If a request arrives to "just add a time threshold", this is the reason to push back.

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
- **The file carries no usable run identity.** `cmd:` is the entry script, so every request in a framework app reports the same `index.php`. There is no route, no commit, no test name, and no request time beyond the filename. Anything that compares two runs has to get identity from outside the file — the run store, or `xdebug.profiler_output_name` format specifiers (`%t` timestamp, `%p` pid, and others worth verifying against the Xdebug docs before relying on them). Do not invent identity by hashing the profile contents: two runs of the same route legitimately differ.

When fixing a parser bug, add a fixture to `fixtures/` reproducing it, and add a row to
`fixtures/README.md` saying what it pins down.

## Conventions

- TypeScript strict, `noUncheckedIndexedAccess` on. No `any` in `packages/parser`.
- Prefer plain functions and typed arrays over classes in the parser hot path.
- Node components in React Flow views must be memoized — React Flow re-renders aggressively. (React Flow arrives in v0.5, not v0.2.)
- The graph module is lazy-loaded via route-level dynamic import. Keep it that way; first paint matters for the XAMPP audience on modest hardware.
- PHP: PSR-12, PHPStan level 8, zero runtime Composer dependencies (invariant 6).
- The headless report format is a **public interface**. Once a CI pipeline depends on its shape you cannot move it, so version it from the first release and treat changes as breaking.
- Windows paths are first-class. Backslashes, drive letters, `C:\xampp\tmp`, case-insensitive comparison. Do not assume POSIX.

## Testing

- Parser changes need a fixture-based test. `fixtures/README.md` documents what each file pins down; read it before adding another.
- Fixtures are committed **byte-exact**. `.gitattributes` marks `fixtures/callgrind/**` as `-text` so line-ending normalisation cannot silently change their length between platforms. Never remove that rule.
- Large profiles are **not** committed and not downloaded either. `packages/parser/bench/synthetic.ts` generates a realistically-shaped profile at any size; use it instead of a fixture for anything size-dependent. (There is no `pnpm fixtures:download`.)
- Performance-sensitive changes need a `pnpm bench` before/after in the PR description.
- Preflight logic needs tests against synthetic `phpinfo`-style inputs covering: Xdebug absent, Xdebug 2.x, mode misconfigured, `output_dir` missing, `output_dir` unwritable, no profile files present. (Arrives with `packages/php-server` in v0.15.)
- `research/xdebug-overhead/verify_sentinel.php` must keep passing. It proves per-test call attribution is exact, including through shared intermediates; if it breaks, every count assertion built on it is silently wrong. Wire it into CI once `packages/php-server` exists.
- Run-store tests need a fixed clock and a fake git, or they will be flaky and machine-dependent. Cover: a project with no git, a detached HEAD, a dirty working tree, two runs of the same route, and retention pruning. (v0.15.)
- The headless report is a public interface — snapshot-test its shape, not just its values, so a field rename fails loudly rather than silently breaking someone's pipeline. (v0.3.)

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

**Ask before:** changing the parser's public interface (`bytes → columnar profile`), changing the run-store manifest schema or the headless report format once either has shipped, adding a dependency to `packages/parser`, adding *any* runtime Composer dependency, raising the PHP version floor, or adding anything to the drop-in that requires a build step.

**Don't:** copy code from KCachegrind (GPL-2.0 — this project is a clean-room implementation from the published format spec). speedscope is MIT and may be referenced with attribution.

**Do:** benchmark before optimizing. The assumption that parsing is the bottleneck is unverified — rendering and layout are equally likely culprits. If TypeScript parsing genuinely dominates on 200MB+ files, the parser interface is deliberately narrow enough to swap for WASM without touching the UI. That decision should follow measurements, not precede them.

**On profiling accuracy:** Xdebug's profiler overhead is significant and uneven. The UI must not present absolute wall-clock times as real-world performance. Keep the caveat visible; do not remove it to make a view look cleaner.

## Decisions already taken

Settled during v0.1. Revisit them deliberately, not by accident.

- **No `fflate`.** Gzip uses the platform `DecompressionStream` only. Adding fflate would be the parser's first runtime dependency, and the support floor does not currently need lowering. `packages/parser/src/gzip.ts` has a documented seam where it would go.
- **Cost values stay in raw file units** everywhere, converted to milliseconds only at render time via `meta.timeToMs`. Summing, diffing and re-aggregating therefore never accumulate rounding error — which matters most for diffing in v0.2.
- **The flame builder does not prune by cost.** `minFraction` defaults to 0 and culling happens at draw time, where the zoom level is known. Dropping a frame at build time makes it unreachable however far the user zooms in, which is exactly when they want it. `maxNodes` is the safety valve, not the threshold.
- **No TanStack Router and no shadcn/ui yet.** v0.1 is a single view with tab state and a handful of hand-rolled Tailwind components. Router earns its place when the run-history and diff views arrive in v0.2, and again with the lazy-loaded graph route in v0.5.
- **Columns are typed as `Int32Array<ArrayBuffer>` / `Float64Array<ArrayBuffer>`** (aliases `I32`/`F64`/`U8` in `types.ts`), not the default `ArrayBufferLike`. That is what `postMessage` transfer lists require, and stating it stops a `SharedArrayBuffer` silently turning a zero-copy handoff into a structured clone.

Settled after v0.1, when the direction changed to living inside the project:

- **The run store comes before diffing, not with it.** Diffing, history, aggregation and budgets all need a run that knows its commit, branch and route. Building the store first makes four milestones straightforward; building it later means retrofitting every one of them.
- **Both distributions survive.** Composer is the primary route, the drop-in zip is not deprecated. See "Two distributions, one codebase" above.
- **CI ships in v0.3 with count assertions only.** See invariant 8. This is a deliberate narrowing of what the README used to call "performance budgets".
- **Graph views (React Flow), HTML export and DuckDB-WASM moved to v0.5.** They are good features that do not unblock anything else; the run-store path does.

Settled by measurement in `research/xdebug-overhead/` (see invariant 8):

- **Test-suite integration is the CI story, not route profiling.** A test name is a stable, unique, human-meaningful run identity that already exists in the codebase — no middleware, no route capture, no filename specifiers. Tests are also deterministic in a way dev HTTP requests are not, which is what count assertions need.
- **Assertions read the function monitor; the profiler only explains failures.** The profiler cannot produce per-test data at all. Two data sources, two jobs.
- **A dedicated opt-in performance suite, never blanket instrumentation.** Whole-suite monitoring turns a 2-minute suite into 10–15 minutes.
- **`coverage,develop` costs the same as `coverage` alone**, so projects already running Xdebug coverage get monitoring for free. That is the adoption path to design toward.

## Current focus

See the roadmap table in `README.md`, which was reordered after v0.1 shipped.

**v0.1 is complete** — Worker parser, canvas flame graph + icicle, function table, source
annotation, drag-and-drop, static web app. Its success criterion is met with headroom (see
Current baseline above).

Present milestone: **v0.15 — live in the project.** PHP 7.4+ thin server, preflight status
page with generated ini snippets and a re-verify loop, the run store, `watch` mode, and both
distributions (Composer dev-dependency and XAMPP/WAMP drop-in zip) built from the same code.
Windows path handling throughout.

Success criterion: two audiences reach a rendered flame graph without leaving the tool — a
Windows XAMPP user with Xdebug not yet configured, and a Composer user who runs one command
in an existing project.

Three things v0.1 left on the table that v0.15 should pick up:

- **Source annotation has no source.** The static build can only show line costs unless the user attaches a file by hand. `php-server` serving source files is what makes that view whole, and in a project-installed build it needs no attaching at all.
- **Run identity.** Nothing currently labels a profile. Until the store exists, every later feature is blocked on it.
- **The Playwright gap above**, which should close before the renderer grows further.

When starting v0.15, resolve these before writing much PHP: where the run store lives
relative to a project root versus a drop-in install; how the route is captured (Xdebug
filename specifiers, a trigger wrapper, or optional middleware); and what the manifest
schema is, since the CLI and MCP server both read it.
