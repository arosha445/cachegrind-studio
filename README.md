<div align="center">

# Cachegrind Studio   &middot; [![License](https://img.shields.io/github/license/arosha445/cachegrind-studio)](https://github.com/arosha445/cachegrind-studio/blob/main/LICENSE)



**Turn Xdebug profiles into answers.**

A profiler analyzer for PHP that lives in your project. Install it as a dev dependency, profile
a request, get a flame graph — then diff it against `main` and let CI catch the next regression.
No Qt, no desktop install, no crashed browser tabs, nothing uploaded anywhere.

[Quick start](#quick-start) · [Features](#features) · [Roadmap](#roadmap) · [Architecture](#architecture) · [Contributing](#contributing)

</div>

---

> **Status: pre-alpha, v0.1 complete, nothing released yet.** Most of this README describes
> intent. The [Roadmap](#roadmap) marks what is actually built.
> Issues and design discussion are very welcome — see [Contributing](#contributing).

### What works today

Clone it, `pnpm install`, `pnpm dev`, drag a `cachegrind.out` file onto the page:

- **Reads real Xdebug profiles** — gzipped or plain, Xdebug 2 or 3, Windows or POSIX paths
- **Flame graph and icicle view** on canvas, with click-to-zoom, drag-to-pan and filter highlighting
- **Sortable function table** with self cost, inclusive cost, call counts and memory
- **Source annotation** — per-line self cost *and* the cost of calls made from each line
- **Caller / callee lists** for the selected function

Measured on a 120 MB profile with 2.5 M call edges: **2.16 s** from drop to rendered
flame graph, worst main-thread frame 34 ms. Parser throughput is ~167 MB/s.

Not built yet: everything that needs the tool to live inside a project — the run store,
diffing, the Composer package and drop-in zip, the preflight page, CI assertions, and the
MCP server. That is what the roadmap below is now organised around.

## Why this exists

Profiling PHP with Xdebug produces a `cachegrind.out` file. Reading that file is where everyone gets stuck.

**Webgrind** is the default choice, and it's unmaintained. It parses in PHP, ships the whole result to the browser as JSON, and renders it into DOM nodes — so it hangs or crashes on large files. [Its issue about a 60 MB file freezing the browser](https://github.com/jokkedk/webgrind/issues/3) was opened in 2009 and is still open. It has no flame graph, silently ignores memory data, and gets Xdebug 3's time units wrong.

**KCachegrind** is genuinely excellent — and it's a KDE/Qt desktop application. On Windows, where a large share of PHP developers work, it means hunting for an unofficial build. In practice, most of those developers never profile at all.

**Everything good is a paid SaaS.** Blackfire and Tideways have diffing, N+1 detection, and CI assertions. They also send your code somewhere else and start at real money per month.

Cachegrind Studio is the free, local, open-source middle: KCachegrind's depth, Webgrind's install experience, a UI from this decade, and an MCP server so your coding agent can read profiles too.

The bet is that most of what the paid tools sell comes from **knowing which project the profile belongs to** — which commit, which route, which files are yours and which are `vendor/`. A cachegrind file on its own carries none of that. Installed in the repo, all of it is free, and diffing, per-package attribution and CI assertions stop being hard problems.

## Features

**Core analysis**
- Flame graph and icicle views, rendered to canvas — handles large profiles without freezing
- Call tree with inclusive and self cost
- Caller/callee panel
- Sortable function list with regex filtering
- Source annotation with per-line cost in the gutter
- Interactive node-graph call visualization

**Things the free tools don't do**
- **Profile diffing** — compare two runs, see what actually changed
- **Multi-run aggregation** across requests
- **Framework layer graph** — where time structurally goes: vendor, autoload, framework, app, database
- **Include/require dependency graph** — makes autoloading overhead visible
- **N+1 detection** and other performance smells
- **Memory alongside time**, not instead of it
- **Self-contained HTML reports** you can attach to a PR
- **Performance budgets** with a GitHub Action and PR comments

**Built for how PHP is actually run locally**
- **`composer require --dev`** into an existing project, or a **drop-in folder for XAMPP and WAMP** — unzip, open a browser, done
- **Preflight page** that tells you exactly why you have no profile files yet, with copy-paste fixes
- **`watch` mode** alongside your dev server — profile a request, the newest run opens by itself
- **Run store** keeping every profile labelled with commit, branch and route
- Works fully offline; your code and profiles never leave your machine

**Agent integration**
- MCP server exposing hotspots, diffs, call trees, and environment diagnostics to Claude Code, Cursor, and other MCP clients

## How it runs

One parser, three front-ends. Everything reads the same columnar profile out of
`packages/parser`, so a fact is computed once and reported identically everywhere.

| Mode | For | Shape |
|---|---|---|
| **UI** | Reading a profile yourself | Local browser app, served by the PHP dev server or opened as a static page |
| **Headless** | CI, pre-commit hooks, scripts | CLI that emits a JSON report and an exit code |
| **MCP** | Coding agents | Stdio server exposing hotspots, diffs and source-aware answers |

Installed in a project, it also keeps a **run store** — profiles labelled with commit,
branch and route, so "compare this against `main`" is a question you can actually ask. A
loose `cachegrind.out` file has no such identity; this is the difference between the tool
being a viewer and being a measuring instrument.

## Quick start

> **None of the install routes below exist yet.** There is no release, no Composer package,
> no Docker image and no hosted app — they are v0.15 and later. Today the only way to run
> this is from source:
>
> ```bash
> pnpm install
> pnpm dev          # then open http://localhost:5173 and drag a profile in
> ```

### Composer (planned for v0.15)

The primary route once it exists. Installs into an existing project, so it can see your
source, your `composer.json`, and your git history.

```bash
composer require --dev cachegrind-studio/cachegrind-studio

vendor/bin/cachegrind-studio doctor     # check the Xdebug setup, print the exact ini to paste
vendor/bin/cachegrind-studio watch      # follow the output dir, open each new profile
vendor/bin/cachegrind-studio ui         # browse the run store
vendor/bin/cachegrind-studio check      # headless: JSON report + exit code, for CI
```

It is a **dev dependency**, always. It serves your source code and refuses to start outside
a development environment — see [Known limitations](#known-limitations).

### XAMPP / WAMP (planned for v0.15)

Same server, same UI, packaged for people who have no Composer and no terminal. This route
is not being dropped in favour of the Composer one — it is the reason the project exists.

1. Download `cachegrind-studio.zip` from [Releases](../../releases)
2. Extract into your web root:
   - XAMPP → `C:\xampp\htdocs\cachegrind-studio`
   - WAMP → `C:\wamp64\www\cachegrind-studio`
   - macOS XAMPP → `/Applications/XAMPP/htdocs/cachegrind-studio`
3. Open **http://localhost/cachegrind-studio**
4. The preflight page checks your setup and gives you the exact config to paste

No Composer. No Node. No terminal.

### CI (planned for v0.3)

```yaml
- uses: cachegrind-studio/action@v1
  with:
    budget: .cachegrind-studio/budget.yml
```

Assertions are on deterministic counts — queries, autoloads, function calls, allocations —
not on wall-clock time. The reasoning is in [Known limitations](#known-limitations).

### Docker (planned for v1.0)

```bash
docker run -p 8080:80 -v /tmp:/profiles cachegrindstudio/cachegrind-studio
```

### No install at all (planned)

Open [cachegrind.studio/app](https://cachegrind.studio/app) and drag a `cachegrind.out` file onto the page. Parsing happens in your browser — nothing is uploaded. This route has no run store and no source, so it stays a viewer: no diffing, no per-package attribution.

## Configuring Xdebug

The preflight page generates this for you with your real `php.ini` path filled in, but for reference:

```ini
[xdebug]
zend_extension=xdebug
xdebug.mode=profile
xdebug.start_with_request=trigger
xdebug.output_dir="C:\xampp\tmp"
xdebug.profiler_output_name=cachegrind.out.%t.%p
```

Then restart Apache and add `?XDEBUG_TRIGGER=1` to any URL you want to profile.

> **`xdebug.mode` cannot be set with `ini_set()` or `.htaccess`.** It must go in `php.ini`, or the `XDEBUG_MODE` environment variable. This trips up almost everyone once.

> **Use `%t.%p` in the output name.** A static filename means every run overwrites the last one, and diffing becomes impossible.

## MCP server

> **Planned for v0.25.** The tool list below is the design, not a shipped interface. The
> parser it will reuse is built and tested; the server is not.
>
> It reads the run store rather than a directory of loose files, which is what lets an agent
> close the loop: profile, read the hotspot's real source, patch, re-profile, diff to verify.

Lets an AI agent read your profiles, diagnose regressions, and check your Xdebug setup.

```jsonc
// claude_desktop_config.json / .cursor/mcp.json
{
  "mcpServers": {
    "cachegrind-studio": {
      "command": "npx",
      "args": ["-y", "@cachegrind-studio/mcp", "--profile-dir", "/tmp"]
    }
  }
}
```

**Available tools**

| Tool | Purpose |
|---|---|
| `check_environment` | Preflight report — PHP/Xdebug versions, ini path, config problems |
| `list_profiles` | Available profile runs with timestamps and sizes |
| `get_profile_summary` | Totals, entry point, top-level breakdown |
| `get_hotspots` | Top functions by self or inclusive cost |
| `get_call_tree` | Subtree beneath a given function |
| `get_callers` / `get_callees` | Edges into and out of a function |
| `compare_profiles` | Diff two runs, ranked by delta |
| `explain_regression` | Narrowed diff focused on what got worse |
| `find_n_plus_one` | Repeated call signatures suggesting N+1 |
| `detect_smells` | Autoload overhead, regex hotspots, serialization cost |
| `get_source_for_hotspot` | Source with per-line cost annotations |
| `suggest_optimizations` | Grounded suggestions for a specific function |
| `trigger_profile` | Run a request or command with profiling enabled |

The intended loop: **profile → find hotspot → read source → patch → re-profile → diff to verify.**

## Architecture

```
cachegrind-studio/
├─ packages/
│  ├─ parser/       ✅ Framework-free TypeScript. Callgrind → columnar typed arrays.
│  ├─ web/          ✅ React 19 SPA. Canvas flame graph. Front-end #1: the UI.
│  ├─ cli/          ⬜ Node. Front-end #2: headless JSON report + exit code.   (v0.3)
│  ├─ mcp/          ⬜ Node. Front-end #3: stdio MCP server.                   (v0.25)
│  └─ php-server/   ⬜ ~300 lines, PHP 7.4+. Discovery, streaming, preflight,
│                      run store. Never parses anything.                      (v0.15)
└─ apps/playground/ ⬜ Hosted demo with sample profiles.                       (v1.0)
```

✅ built · ⬜ planned.

**The parser is the product; the three front-ends are thin.** UI, CLI and MCP all consume
the same `bytes → columnar profile` interface, so a number shown in the flame graph, a
number asserted in CI, and a number an agent reads are the same number computed by the same
code. Any analysis that lands in one front-end and not the others is a design mistake.

**Parsing runs in a Web Worker, in TypeScript.** The file is read as an `ArrayBuffer` and scanned byte-wise — never decoded into one giant string. Function and file names are interned to integer IDs; costs land in `Int32Array`/`Float64Array` columns and transfer to the main thread zero-copy. Gzip is handled with `DecompressionStream`. An `fflate` fallback is deliberately not bundled — it would be the parser's only runtime dependency, and every browser the app targets ships the platform API.

**The PHP server never parses anything.** It lists files, streams bytes, serves source, reports environment state, and maintains the run store. Parsing in PHP is what makes Webgrind fall over; if a task seems to need it, it belongs in the parser package.

**The run store is a directory, not a database.** `.cachegrind-studio/runs/` holds the raw profile bytes plus a small JSON manifest per run — commit, branch, route, label, timestamp. Plain files mean no daemon, no migrations, nothing to corrupt, and a run can be committed or attached to a CI artifact as-is.

**Two rules that keep it fast:**

1. **Frames are never DOM nodes.** The flame graph draws to canvas; the function table is virtualized. React Flow graph views are the one exception, and only because they're hard-capped at a few hundred curated nodes.
2. **`packages/parser` never imports from `packages/web`.** It's shared by the browser, the CLI and the MCP server. An ESLint boundary rule enforces this.

**Stack in use today:** React 19 · TypeScript · Vite · TanStack Virtual · Tailwind · Web Workers

**Planned:** PHP 7.4+ with zero runtime Composer dependencies (v0.15) · TanStack Router (v0.2) · MCP TypeScript SDK (v0.25) · React Flow + Dagre/ELK and DuckDB-WASM (v0.5)

## Roadmap

| Version | Status | Theme | Scope |
|---|---|---|---|
| **v0.1** | ✅ done | Read a profile without crashing | Worker parser (gzip, Xdebug 2/3 unit handling, columnar output) · canvas flame graph + icicle · function table · source annotation · drag-and-drop · static web app |
| **v0.15** | 🚧 next | Live in the project | PHP 7.4+ thin server · preflight status page with generated ini snippets and a re-verify loop · **run store** (labelled runs with commit, branch, route) · `watch` mode · Composer package **and** XAMPP/WAMP drop-in zip from the same code · Windows path handling |
| **v0.2** |  | Answer "did my change help?" | Profile diffing over the run store · delta flame graph · call tree · regex filtering · run history browser |
| **v0.25** |  | Let agents in | MCP server (reusing `packages/parser`) reading the run store · `trigger_profile` · source-aware hotspot answers, closing the profile → patch → re-profile → diff loop |
| **v0.3** |  | Catch it before review | Headless CLI with a stable JSON report and exit code · **count-based assertions** (calls, queries, autoloads, allocations) · GitHub Action · PR comment bot · wall-time reported as advisory only |
| **v0.4** |  | Understand the shape of the request | Per-package attribution from `composer.json` · framework layer graph · include/require dependency graph · N+1 and smell detection · N+1 cluster view · memory view |
| **v0.5** |  | Navigate visually and at scale | Focused call graph (React Flow + Dagre/ELK) · self-contained HTML export · DuckDB-WASM query layer · `.xt` trace ingestion + time-order timeline |
| **v1.0** |  | Fits into a team's workflow | Multi-run aggregation across a whole test suite · budgets tuned against real projects · Docker · docs, playground, agentic demo |

**Beyond v1.0 (unscheduled):** additional input formats (speedscope JSON, folded stacks, XHProf) · Electron/Tauri desktop build · hosted team edition with profile history and CI dashboards.

### Why this order

The sequence changed after v0.1 shipped, for three reasons worth stating outright.

**The run store is the load-bearing piece, so it comes first.** Diffing, history, aggregation and budgets all need the same thing: a run that knows what it is. A raw cachegrind file does not — see [run identity](#known-limitations) below. Building the store in v0.15 makes four later milestones possible instead of awkward; building it later means retrofitting every one of them.

**Being inside the project is what unlocks the differentiated features**, not just a nicer install. Source annotation stops needing hand-attached files. `vendor/` versus application code stops being a heuristic and becomes a lookup. Commit and branch come for free, which is what a diff needs to be meaningful.

**CI moved earlier but got narrower.** See the budget caveat in [Known limitations](#known-limitations): asserting on wall-clock time from an Xdebug profile produces a flaky check, and a flaky check gets switched off. Assertions are on deterministic counts instead. That is a smaller promise than "performance budgets" and a much more reliable one.

### Success criteria

- **v0.1** — a 100–200 MB gzipped profile opens in under ~5 seconds with no tab freeze.
  **Met:** a 120 MB profile (2.5 M call edges) renders 2.16 s after the drop, with the main
  thread never blocked for more than 34 ms.
- **v0.15** — two audiences reach a rendered flame graph without leaving the tool: a Windows XAMPP user with Xdebug not yet configured, and a Composer user who runs one command in an existing project
- **v0.2** — a developer can answer "is this route slower than it was on `main`?" without leaving the tool or naming a file
- **v0.3** — a pull request that introduces an N+1 query is flagged by CI, with the offending call site named, and the check does not fire on unrelated PRs
- **v1.0** — a regression is caught by CI and explained in a PR comment before a human looks at it

## Known limitations

**Xdebug's profiler distorts what it measures.** Overhead is significant and uneven across function types — enough that absolute wall-clock numbers from a profiled run should not be quoted as real-world timings. Trust relative self-cost and call counts. Cachegrind Studio shows this caveat in the UI rather than letting you forget it.

**CI assertions are on counts, not on time — deliberately.** The point above does not go away in CI; it gets worse, because shared runners add their own variance on top of the profiler's. A wall-clock budget over Xdebug data produces a check that fails on unrelated pull requests, and a check that cries wolf gets switched off within a fortnight. So budgets assert on things that are stable run to run: query counts, autoload counts, function call counts, allocation counts. Those are also what actually regresses — N+1s, autoload storms, an accidental loop. Wall time is reported alongside, as advisory, never as a gate.

**Run identity does not come from the file.** A cachegrind file records `cmd:` — the entry script — which for any framework is the same `index.php` for every request in the application. There is no route, no commit, no test name. Diffing two runs therefore needs identity attached from outside, which is exactly what the run store does and what a loose file dropped on a web page cannot have. Xdebug's `profiler_output_name` format specifiers can carry some of it into the filename; the rest comes from being installed in the project.

**Memory data is approximate.** Xdebug reports memory deltas per function, so functions that free memory can show as zero. Useful for spotting allocation hotspots; not an allocation profiler.

**Xdebug 2 and 3 use different time units.** Cachegrind Studio detects the creator version and normalizes. If numbers look wrong by orders of magnitude, that's the first thing to check — and please file an issue.

**Self cost lands on a function's declaration line.** Xdebug charges a function's own
cost to the `function foo()` line rather than spreading it across the body, so the source
view shows a second number per line — the inclusive cost of the calls made *from* that
line, which is what usually points at the slow statement.

**Cachegrind files are aggregated, not chronological.** Time-ordered views require `.xt` traces (v0.5), not `cachegrind.out`.

**It reads your source, so it is a dev dependency and nothing else.** `composer require --dev`, never `require`. It serves source files and profile data, binds to loopback only, and refuses to start when it detects a production environment. Do not deploy it to a public-facing server, and do not work around the guard.

**Profiles are large, so the run store prunes.** Runs are kept under `.cachegrind-studio/`, which belongs in `.gitignore` — with the deliberate exception of a committed baseline if you want CI to diff against one. Retention is capped; old runs are dropped rather than growing without limit.

## Contributing

Contributions are wanted, particularly from PHP developers — the parser is TypeScript specifically so that fixing a format edge case doesn't require learning a new toolchain.

**Especially useful right now:**
- **Real cachegrind files** for the test corpus, particularly large ones, unusual frameworks, and **Xdebug 2 output** — the Xdebug 2 handling is currently tested against a hand-written fixture, not a file a real Xdebug 2 produced
- **Windows XAMPP/WAMP testing.** WSL hides exactly the path and DLL-architecture problems this audience actually hits
- Parser edge cases, canvas rendering performance, graph layout quality
- **A Playwright E2E test** that loads a fixture and asserts the flame graph renders — the renderer is currently verified by hand

```bash
pnpm install
pnpm dev                     # web UI at localhost:5173
pnpm test
pnpm typecheck
pnpm lint
pnpm bench                   # parser benchmarks — please run before perf PRs
pnpm fixtures:generate       # needs a local PHP with Xdebug 3
```

`fixtures/README.md` explains what each test fixture pins down; read it before adding
another. `CLAUDE.md` documents the invariants and the format's sharp edges.

There is no `CONTRIBUTING.md` yet.

## Prior art

Built with respect for the tools that came first. [Webgrind](https://github.com/jokkedk/webgrind) got the install experience right and its streaming preprocessor was a smart design. [KCachegrind](https://kcachegrind.github.io/) defined what a profile analyzer should show — its [Callgrind format specification](https://kcachegrind.github.io/html/CallgrindFormat.html) is the basis of this parser. [speedscope](https://github.com/jlfwong/speedscope) (MIT) is the reference for flame-graph interaction, and proof that a TypeScript profile viewer scales.

KCachegrind is GPL-2.0. Cachegrind Studio is a clean-room implementation from the published format specification; no KCachegrind code is used.

And thanks to [Derick Rethans](https://derickrethans.nl/), who has maintained Xdebug for over two decades. None of this exists without it.

## License

[Apache-2.0](LICENSE)
