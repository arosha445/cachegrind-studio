<div align="center">

# Cachegrind Studio   &middot; [![License](https://img.shields.io/github/license/arosha445/cachegrind-studio)](https://github.com/arosha445/cachegrind-studio/blob/main/LICENSE)



**Turn Xdebug profiles into answers.**

A modern, web-based profiler analyzer for PHP. Drag in a `cachegrind.out` file, get a flame graph.
No Qt, no desktop install, no crashed browser tabs.

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

Not built yet: everything under [Things the free tools don't do](#features) — diffing,
the drop-in zip, the preflight page, graph views, and the MCP server. See the roadmap.

## Why this exists

Profiling PHP with Xdebug produces a `cachegrind.out` file. Reading that file is where everyone gets stuck.

**Webgrind** is the default choice, and it's unmaintained. It parses in PHP, ships the whole result to the browser as JSON, and renders it into DOM nodes — so it hangs or crashes on large files. [Its issue about a 60 MB file freezing the browser](https://github.com/jokkedk/webgrind/issues/3) was opened in 2009 and is still open. It has no flame graph, silently ignores memory data, and gets Xdebug 3's time units wrong.

**KCachegrind** is genuinely excellent — and it's a KDE/Qt desktop application. On Windows, where a large share of PHP developers work, it means hunting for an unofficial build. In practice, most of those developers never profile at all.

**Everything good is a paid SaaS.** Blackfire and Tideways have diffing, N+1 detection, and CI assertions. They also send your code somewhere else and start at real money per month.

Cachegrind Studio is the free, local, open-source middle: KCachegrind's depth, Webgrind's install experience, a UI from this decade, and an MCP server so your coding agent can read profiles too.

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
- **Drop-in folder for XAMPP and WAMP** — unzip, open a browser, done
- **Preflight page** that tells you exactly why you have no profile files yet, with copy-paste fixes
- Works fully offline; your code and profiles never leave your machine

**Agent integration**
- MCP server exposing hotspots, diffs, call trees, and environment diagnostics to Claude Code, Cursor, and other MCP clients

## Quick start

> **None of the install routes below exist yet.** There is no release, no Composer package,
> no Docker image and no hosted app — they are the v0.15 and v0.2 deliverables. Today the
> only way to run this is from source:
>
> ```bash
> pnpm install
> pnpm dev          # then open http://localhost:5173 and drag a profile in
> ```

### XAMPP / WAMP (recommended, planned for v0.15)

1. Download `cachegrind-studio.zip` from [Releases](../../releases)
2. Extract into your web root:
   - XAMPP → `C:\xampp\htdocs\cachegrind-studio`
   - WAMP → `C:\wamp64\www\cachegrind-studio`
   - macOS XAMPP → `/Applications/XAMPP/htdocs/cachegrind-studio`
3. Open **http://localhost/cachegrind-studio**
4. The preflight page checks your setup and gives you the exact config to paste

No Composer. No Node. No terminal.

### Composer

```bash
composer require --dev cachegrind-studio/cachegrind-studio
./vendor/bin/cachegrind-studio
```

### Docker

```bash
docker run -p 8080:80 -v /tmp:/profiles cachegrindstudio/cachegrind-studio
```

### No install at all

Open [cachegrind.studio/app](https://cachegrind.studio/app) and drag a `cachegrind.out` file onto the page. Parsing happens in your browser — nothing is uploaded.

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

> **Planned for v0.4.** The tool list below is the design, not a shipped interface. The
> parser it will reuse is built and tested; the server is not.

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
│  ├─ web/          ✅ React 19 SPA. Canvas flame graph. React Flow graphs in v0.2.
│  ├─ mcp/          ⬜ Node MCP server. Imports packages/parser directly.
│  └─ php-server/   ⬜ ~300 lines, PHP 7.4+. Discovery, streaming, preflight.
└─ apps/playground/ ⬜ Hosted demo with sample profiles.
```

✅ built · ⬜ planned.

**Parsing runs in a Web Worker, in TypeScript.** The file is read as an `ArrayBuffer` and scanned byte-wise — never decoded into one giant string. Function and file names are interned to integer IDs; costs land in `Int32Array`/`Float64Array` columns and transfer to the main thread zero-copy. Gzip is handled with `DecompressionStream`. An `fflate` fallback is deliberately not bundled — it would be the parser's only runtime dependency, and every browser the app targets ships the platform API.

The PHP server never parses anything. It lists files, streams bytes, serves source, and reports environment state.

**Two rules that keep it fast:**

1. **Frames are never DOM nodes.** The flame graph draws to canvas; the function table is virtualized. React Flow graph views are the one exception, and only because they're hard-capped at a few hundred curated nodes.
2. **`packages/parser` never imports from `packages/web`.** It's shared by the browser, the MCP server, and any future CLI. An ESLint boundary rule enforces this.

**Stack in use today:** React 19 · TypeScript · Vite · TanStack Virtual · Tailwind · Web Workers

**Planned:** TanStack Router (v0.2, with the lazy-loaded graph route) · React Flow + Dagre/ELK (v0.2) · DuckDB-WASM (v0.3) · MCP TypeScript SDK (v0.4) · PHP 7.4+ (v0.15)

## Roadmap

| Version | Status | Theme | Scope |
|---|---|---|---|
| **v0.1** | ✅ done | Read a profile without crashing | Worker parser (gzip, Xdebug 2/3 unit handling, columnar output) · canvas flame graph + icicle · function table · source annotation · drag-and-drop · static web app |
| **v0.15** | 🚧 next | Reach the people who can't profile today | XAMPP/WAMP drop-in zip · PHP 7.4+ thin server · preflight status page with generated ini snippets and re-verify loop · Windows path handling |
| **v0.2** |  | Navigate a profile properly | Call tree · caller/callee panel · focused call graph (React Flow) · regex filtering · self-contained HTML export · Composer + Docker distribution |
| **v0.3** |  | Answer "did my change help?" | Profile diffing · delta flame graph · diff call graph · DuckDB-WASM query layer |
| **v0.4** |  | Let agents in | MCP server (reusing `packages/parser`) · `.xt` trace ingestion · time-order timeline view |
| **v0.5** |  | Understand the shape of the request | Framework-aware grouping · framework layer graph · include/require dependency graph · N+1 and smell detection · N+1 cluster view · memory view |
| **v1.0** |  | Fits into a team's workflow | GitHub Action · PR comment bot · performance budgets · multi-run aggregation · docs, playground, agentic demo |

**Beyond v1.0 (unscheduled):** additional input formats (speedscope JSON, folded stacks, XHProf) · Electron/Tauri desktop build · hosted team edition with profile history and CI dashboards.

### Success criteria

- **v0.1** — a 100–200 MB gzipped profile opens in under ~5 seconds with no tab freeze.
  **Met:** a 120 MB profile (2.5 M call edges) renders 2.16 s after the drop, with the main
  thread never blocked for more than 34 ms.
- **v0.15** — a Windows XAMPP user with Xdebug not yet configured reaches a rendered flame graph without leaving the tool or searching the web
- **v1.0** — a regression is caught by CI and explained in a PR comment before a human looks at it

## Known limitations

**Xdebug's profiler distorts what it measures.** Overhead is significant and uneven across function types — enough that absolute wall-clock numbers from a profiled run should not be quoted as real-world timings. Trust relative self-cost and call counts. Cachegrind Studio shows this caveat in the UI rather than letting you forget it.

**Memory data is approximate.** Xdebug reports memory deltas per function, so functions that free memory can show as zero. Useful for spotting allocation hotspots; not an allocation profiler.

**Xdebug 2 and 3 use different time units.** Cachegrind Studio detects the creator version and normalizes. If numbers look wrong by orders of magnitude, that's the first thing to check — and please file an issue.

**Self cost lands on a function's declaration line.** Xdebug charges a function's own
cost to the `function foo()` line rather than spreading it across the body, so the source
view shows a second number per line — the inclusive cost of the calls made *from* that
line, which is what usually points at the slow statement.

**Cachegrind files are aggregated, not chronological.** Time-ordered views require `.xt` traces (v0.4), not `cachegrind.out`.

**The drop-in exposes source code.** It's a local development tool. Never deploy it to a public-facing server.

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
