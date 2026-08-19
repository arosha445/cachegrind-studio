# Building a Modern Web-Based PHP Xdebug Profiler Analyzer: Project Plan & Brainstorm

*Revision 2 — parsing strategy changed from Rust/WASM to TypeScript in a Web Worker.*

## TL;DR
- **Build a client-side-first React + TypeScript cachegrind analyzer** that opens Xdebug profiles by drag-and-drop, renders flame graph / icicle / sandwich / call-tree / source-annotation views instantly, and does what Webgrind and KCachegrind can't: profile diffing, multi-run aggregation, framework-aware grouping, and shareable HTML reports.
- **The two decisions that actually fix Webgrind's crash problem** are (1) parse in a **Web Worker into typed arrays** instead of shipping a huge JSON blob to the main thread, and (2) render the flame graph to **canvas, not DOM**. Language choice is secondary to both.
- **Ship a thin PHP companion server** (~300 lines, PHP 7.4+, no parsing) that lists `xdebug.output_dir`, streams raw bytes, and hosts the built UI. Distribute it primarily as a **XAMPP/WAMP drop-in zip** — unzip into `htdocs`, open `localhost/profiler`, no Composer, no Node, no terminal. That community is the largest local-PHP population and is completely unserved by KCachegrind.
- **Make the preflight environment page the landing screen.** Detect PHP/Xdebug versions, the real `php.ini` path, `xdebug.mode`, `output_dir` writability, and profile-file presence — each with a copy-paste fix. "Why are there no profile files?" is the actual first-run failure, and no existing tool answers it.
- **The MCP/agentic angle is the genuine differentiator.** Expose `get_hotspots`, `compare_profiles`, `find_n_plus_one`, `suggest_optimizations` so Claude Code / Cursor can run a closed-loop "profile → diagnose → patch → re-profile" workflow. No PHP profiler does this today.
- **Recommended license: Apache-2.0** for parser + UI (lets you freely borrow speedscope's MIT ideas), with a **clean-room implementation of KCachegrind's algorithms** (KCachegrind is GPL-2.0 — read its *format docs*, not its code). MVP in ~6–10 weeks.

## Key Findings

**The format is simple, stable, and well-documented — parsing is a solved problem you can do better.** Xdebug's profiler emits Callgrind-format `cachegrind.out.*` files: an ASCII header (`version: 1`, `creator: xdebug ...`, `cmd:`, `part: 1`, `positions: line`, `events: Time Memory`) followed by cost lines grouped under `fl=`/`fn=` position specs, with `cfn=`/`calls=` for call relationships and a `summary:` line for totals. Name compression (`fn=(1) name` then `fn=(1)`) and the `php::`/`include::`/`require::` naming conventions are the only real quirks. The whole spec fits on one page.

**Existing tools each have one fatal flaw.** Webgrind is written in PHP and chokes/crashes the browser on large files — its own Issue #3 (reported 12 Mar 2009) reads: *"Trying to load a 60MB cachegrind file, my browser got stuck because of the amount of data returned."* Note what that quote actually blames: the *amount of data returned to the browser*, not PHP's parsing. It also has no flame graph, weak filtering, and reads only the first event (Time), silently ignoring Memory. KCachegrind/QCachegrind is feature-rich (treemap, call graph, callee/caller maps, source annotation, recursive cycle handling) but is a Qt/KDE desktop app that is painful to install on macOS/Windows, has a dated UI, and can't produce shareable web reports. Nobody in the free/OSS PHP space combines a modern web UI, flame graphs, diffing, and AI integration.

**The web-profiler UX patterns are already established — copy the best.** speedscope (MIT) is the gold standard: Time Order / Left Heavy / Sandwich views, canvas rendering that handles 60 MB profiles smoothly, keyboard search, minimap zoom/pan. Critically for this plan, **speedscope is written in TypeScript and does its parsing in JS** — it is direct evidence that a JS-based profile viewer handles large files fine when the architecture is right. Firefox Profiler, Perfetto, Pyroscope, and Sentry add diff flame graphs, timeline correlation, and multi-sample aggregation.

**Observability vendors have already bet on MCP; a PHP profiler MCP is a clear gap.** Grafana's official `grafana/mcp-grafana` server (3,000+ stars, 40+ tools, Go, Apache-2.0), Sentry (`get_profile_details`, Seer AI root-cause), Datadog, and Chrome DevTools MCP all exist. None targets Xdebug/PHP dev-time profiling. Chrome DevTools MCP exposes exactly three performance tools — `performance_start_trace`, `performance_stop_trace`, and `performance_analyze_insight` — and the agentic "measure → diagnose → fix → re-measure" loop it demonstrates maps perfectly onto profile diffing.

## Details

### 1. Technical Foundation

**How Xdebug generates profiles (Xdebug 3.x).** Set `xdebug.mode=profile` in `php.ini` (this setting cannot be changed at runtime via `ini_set` or `.htaccess` — only in `php.ini`/`99-xdebug.ini` or via the `XDEBUG_MODE` env var). Files are written to `xdebug.output_dir` (default `/tmp`), named per `xdebug.profiler_output_name` (default `cachegrind.out.%p`, where `%p` = PID). For `profile` mode, `xdebug.start_with_request` defaults to `yes`; set it to `trigger` to profile selectively via the `XDEBUG_TRIGGER` (or legacy `XDEBUG_PROFILE`) GET/POST/COOKIE/env variable, optionally gated by `xdebug.trigger_value`. When profiling, Xdebug adds an `X-Xdebug-Profile-Filename` HTTP response header naming the output file. Since Xdebug 3.1, `xdebug.use_compression` (default on) gzips output — QCacheGrind can't read gzipped files but KCachegrind and PhpStorm can, so a new tool **must handle gzip transparently**. The helper `xdebug_get_profiler_filename()` returns the active filename.

**The Callgrind/cachegrind format** (authoritative spec: kcachegrind.github.io/html/CallgrindFormat.html and valgrind.org/docs/manual/cl-format.html):
- **Header**: `# callgrind format` (optional marker), then `key: value` lines. `events:` (required) names the cost columns; `positions:` (optional, defaults to `line`) names the position columns.
- **Cost lines**: subpositions followed by 64-bit event counters, e.g. `16 400` = line 16, cost 400. Regular cost lines are always **self (exclusive)** cost; repeated lines for the same position are summed.
- **Position specs**: `fl=` (file), `fn=` (function) set context for following cost lines. `ob=` (ELF object) is unused by PHP.
- **Call associations**: `cfn=` (called function), `cfl=`/`cfi=` (called file), then `calls=<count> <target-pos>` and a cost line giving the **inclusive** cost of the call.
- **Name compression**: `fn=(1) main` defines ID 1; later `fn=(1)` references it. Separate ID namespaces per spec type. Essential for performance — intern these into integer IDs.
- **Summary/misc**: `summary: <total>` gives the full-run cost (enables percentage calc and progress bars); `event: Ir : Instruction Fetches` gives long names; `event: Sum = Ir + Dr` defines derived events.

**A real Xdebug cachegrind file looks like this:**
```
version: 1
creator: xdebug 3.x (PHP 8.x)
cmd: /var/www/public/index.php
part: 1
positions: line
events: Time Memory
fl=php:internal
fn=php::mysql_query
...
fl=/var/www/public/index.php
fn={main}
summary: 4823
0 4823
```
Two Xdebug-specific gotchas a parser must handle: **(1)** internal PHP functions use `fl=php:internal` / `fn=php::functionname`; includes/requires appear as pseudo-functions `require::/path`, `include_once::/path`. **(2)** Xdebug does **not** emit `cfl=` for `cfn=` call lines (Xdebug bug #489), so the called file must be resolved from the callee's own `fn=` definition. Also critical: **Xdebug 3 changed the Time cost unit/resolution vs Xdebug 2**. Webgrind Issue #132 documents it: *"the total inclusive / self cost (in milliseconds) appears to be hyper inflated. For instance, I have a call that in total, takes 16.66 seconds to run. Loading it into webgrind, it appears that the call takes 1095246 milliseconds… I tested the same thing on Xdebug 2 and did not have this issue."* Unit handling must be version-aware. Memory: modern Xdebug (2.6+) records both Time and Memory columns, though the memory numbers are quirky (functions that free memory can show as 0).

**Other Xdebug outputs worth integrating.** Xdebug's `trace` mode writes `.xt` function traces (human-readable or computerized `xdebug.trace_format=1`). Since **Xdebug 3.3+, trace mode has native flame-graph output formats** via `xdebug.trace_options` bit flags (`0x04` = cost flamegraph, `0x08` = memory flamegraph) that feed into Brendan Gregg's `flamegraph.pl` (see xdebug.org/docs/flamegraphs). Community tools `xtrace2fg` and `stackcollapse-xdebug.php` already convert `.xt` → folded stacks. **Strategic opportunity: a single tool that ingests both cachegrind (aggregate call graph) AND `.xt` traces (true time-ordered timeline) beats every existing tool**, because cachegrind loses temporal order while `.xt` preserves it — enabling speedscope's "Time Order" view that Webgrind/KCachegrind fundamentally cannot show.

**Existing parsers to reference.** `callgrind-reader` (npm, MIT, TypeScript) — closest existing JS parser, and a good starting point or reference; `nodegrind` (npm) writes the format; Webgrind's `Preprocessor.php` (streams line-by-line, rewrites into a fixed-width binary `.webgrind` file for random access, with an optional ~20× faster C++ preprocessor — a genuinely smart design worth studying regardless of language); `pyprof2calltree`/`gprof2dot` (Python) for conversion patterns; `callgrind_annotate` (Perl) for the annotation algorithm. Profilerpedia catalogs six readers of the format.

---

### 1a. Parsing Strategy: Why TypeScript in a Web Worker

This section replaces the earlier Rust/WASM recommendation. The reasoning:

**Why not PHP (for parsing).** Three concrete problems, none of which is "PHP is slow at strings":
1. **Memory representation.** A PHP array element costs roughly 36–80 bytes once you count the zval, hashtable bucket, and string overhead. A 200 MB cachegrind file may hold 5–10 million cost lines; parsed naively into nested arrays that's several GB, against a default `memory_limit` of 128M. Webgrind works around this with its on-disk binary index — meaning you end up hand-rolling serialization instead of just filling a `Float64Array`.
2. **No long-lived process.** Classic PHP-FPM discards the parsed profile at the end of every request, so every sort, filter, or drill-down re-reads from disk. This is why Webgrind feels sluggish *during interaction*, not just on load. FrankenPHP/Swoole/RoadRunner fix it, but add a runtime dependency to your install story.
3. **No threads, no SIMD**, and raw scanning throughput roughly 10–30× below a compiled parser. Matters at 100 MB+, less at 5 MB.

**Why not Rust/WASM (for now).** Realistically it buys ~2–4× on parse time — the difference between roughly 3 s and 1 s on a large file. Nice, not decisive. Against that: your users *and contributors* are PHP developers. Requiring a Rust toolchain and `nom` familiarity to fix a parser bug removes most of your potential contributor pool. For an OSS project that is a real cost, not a footnote.

**Why TypeScript in a Web Worker wins.** The format is line-oriented ASCII integers, which JS handles well when you avoid the naive path. Read the file as an `ArrayBuffer`, scan bytes directly (not `split('\n')` on a decoded megastring), intern names into a `Map<string, number>`, and write costs into `Int32Array`/`Float64Array` columns. You get the same compact columnar memory layout Rust would give you, with no toolchain, and speedscope is existence proof that this scales. Running it in a Worker keeps the main thread responsive and lets you post progress events (using `summary:` for a real percentage) and transfer the typed arrays back zero-copy.

**Implementation notes that actually matter:**
- Parse from `ArrayBuffer`/`Uint8Array`, not strings. Decode only the name payloads (via `TextDecoder` on subslices), never the numeric body.
- Intern every `fl=`/`fn=` name once into an integer ID; store a parallel `string[]` for display. Name compression makes this nearly free.
- Store costs columnar: `fnId: Int32Array`, `line: Int32Array`, `timeSelf: Float64Array`, `memSelf: Float64Array`, and a separate edge table for calls. Grow with a doubling strategy or two-pass count-then-fill.
- Transfer results to the main thread with `postMessage(payload, [buffer1, buffer2, ...])` so the typed arrays move without copying.
- Gunzip in the Worker via `DecompressionStream('gzip')` where available, with `fflate` as fallback.
- Stream via `Blob.stream()` so you can start parsing before the whole file is in memory, and show progress.

**Keep the parser behind a narrow interface** — `bytes → columnar profile` — so if real-world benchmarks on 200 MB+ files show parsing dominates and users complain, you can swap in a WASM implementation later without touching the UI. Don't pay that cost on day one against a hypothetical.

**Querying.** Once data is columnar, **DuckDB-WASM** runs analytical SQL (`GROUP BY`, aggregations, joins for diffing) over millions of rows in-browser, keeps data local, and ingests Arrow-shaped typed arrays cleanly. SQLite-WASM is a lighter alternative (~400 KB vs ~3.5 MB) if simpler queries suffice. For the MVP, plain typed-array scans plus a sort index may be enough — add the SQL layer when diffing and aggregation arrive (v0.3).

**Rendering.** Draw the flame graph to **canvas/WebGL**, never DOM nodes. This single decision matters more for perceived performance than the parser language does, and it is the actual fix for the crash everyone complains about.

**The PHP that remains.** A thin dev-server (~300 lines): list `xdebug.output_dir`, expose file metadata, stream raw bytes (gzip passthrough), serve source files for the annotation view, and host the built static UI. No parsing, no memory pressure, no `memory_limit` tuning — and it makes the tool feel native to the PHP ecosystem via `composer require --dev`.

---

### 2. Competitive Landscape

| Tool | Strengths | Documented weaknesses |
|---|---|---|
| **Webgrind** (jokkedk, PHP) | Trivial install, Docker image, cross-platform, reads gzip | Browser hangs on large files (Issue #3, 60 MB); no flame graph; ignores Memory column (#51); Xdebug 3 timing scale bug (#132); missing-summary → all costs 0.00 (#125); dated UI; call-graph needs python+dot |
| **KCachegrind/QCachegrind** (GPL-2.0) | Best-in-class: treemap, call graph, callee/caller maps, source+asm annotation, recursive cycle handling, derived events | Desktop-only Qt/KDE; painful macOS/Windows install; dated UI; no web/shareable reports; no diffing; QCacheGrind can't read gzip |
| **PhpStorm profiler viewer** | Built-in, reads gzip | Basic tabular views only; no flame graph; IDE-locked |
| **php-spx** (GPL-3.0, C ext) | Modern built-in web UI, timeline + flamegraph + flat profile, 22 metrics, CLI support, no SaaS | Requires compiling a C extension; limited platform support; self-described "not production ready"; separate from Xdebug ecosystem |
| **XHProf/XHGui** | Low overhead, production-safe sampling, aggregation, run comparison, waterfall | Loses full call stack (aggregates caller/callee pairs → no true flame graph/timeline); MongoDB ops burden; DB bloat |
| **Blackfire** (SaaS) | Zero-code activation, sample aggregation, diffing, SQL/N+1 detection, CI assertions | Proprietary SaaS; data leaves your infra; call graph only on free tier |
| **Tideways** (SaaS) | Low overhead, production, timeline, N+1 & bootstrap detection | Paid — Flex from €69/mo (5M requests); XHProf-derived call-graph limitation |
| **Excimer** (Wikimedia) | Sampling, production-safe, powers ArcLamp flame graphs | Sampling misses fast/frequent fns; function-only context |

**Modern web UIs to learn from:** **speedscope** (MIT — 3 views, canvas rendering, handles 60 MB, search, minimap; also the proof that TS parsing scales), **Firefox Profiler** (timeline, marker correlation, diffing), **Perfetto** (huge-trace handling, SQL query engine), **Pyroscope/Grafana Phlare** (diff flame graphs), **Sentry** (profiling UI + AI). UX patterns to adopt: flame graph + icicle, sandwich view, left-heavy aggregation, time-order (from `.xt`), diff flame graphs with red/blue delta coloring, focus/zoom, search highlighting, keyboard nav.

**Licensing implications.** speedscope is **MIT** — freely study, reimplement, or copy with attribution. KCachegrind is **GPL-2.0** — do **not** copy its code into an Apache/MIT project; reimplement from the separately-published Callgrind format spec and documented view behavior (clean-room). Algorithms aren't copyrightable; specific source expression is. The `.folded` format and Brendan Gregg's FlameGraph are permissively usable.

### 3. Gaps & Pain Points to Solve

1. **Huge files / browser crashes** — Webgrind Issue #3; the #1 problem. → Worker parsing into typed arrays + canvas rendering.
2. **No diffing between runs** — absent from Webgrind & KCachegrind; only paid tools have it. → First-class diff view.
3. **Poor reporting/export** — no shareable reports, no CI integration, no HTML export. → Self-contained HTML report + permalink.
4. **No aggregation across requests** — cachegrind is per-request; only XHGui aggregates. → Multi-file drop → merged view.
5. **Hard to correlate with source & frameworks** — raw function names, no Laravel/Symfony/WordPress layer grouping. → Framework-aware grouping + source annotation.
6. **No N+1 / autoloading / regex / serialization detection.** → Heuristic "smells" analyzer (repeated identical SQL call signatures = N+1; heavy `Composer\Autoload\*` = autoloading overhead; hot `preg_*`; `serialize`/`unserialize` cost).
7. **Overhead distortion** — Xdebug's profiler has high, non-uniform overhead (Tideways: Xdebug overhead makes PHP 7 as slow as PHP 5.6). → Communicate prominently; steer users to *relative* self-cost and call counts, not absolute wall time.
8. **No memory profiling visualization** — Webgrind ignores it. → Dual time/memory axis with caveats about free-memory=0 artifacts.
9. **No CI/CD regression detection.** → GitHub Action + PR-comment bot with configurable thresholds.

### 4. The MCP / Agentic AI Angle

**MCP essentials.** The **2025-11-25** revision is current stable; **2026-07-28** is the release candidate. Servers expose **Tools** (JSON-Schema functions), **Resources** (URI-addressed data), and **Prompts**. Transports: **stdio** (local dev tools — ideal here) and **streamable HTTP** (remote, now OAuth Resource Servers requiring RFC 8707 Resource Indicators). A profiler MCP server runs locally over stdio alongside the dev environment.

**Concrete tool design:**
```json
{
  "name": "compare_profiles",
  "description": "Diff two Xdebug profiles and return functions with the largest self-cost regressions/improvements.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "baseline_id": { "type": "string", "description": "Profile ID of the 'before' run" },
      "current_id":  { "type": "string", "description": "Profile ID of the 'after' run" },
      "metric": { "type": "string", "enum": ["time", "memory", "calls"], "default": "time" },
      "top_n": { "type": "integer", "default": 15 },
      "min_delta_pct": { "type": "number", "default": 5.0 }
    },
    "required": ["baseline_id", "current_id"]
  }
}
```
Full surface: `check_environment` (the preflight report — lets an agent diagnose and fix a broken Xdebug setup), `list_profiles`, `get_profile_summary`, `get_hotspots`, `get_call_tree`, `get_callers`/`get_callees`, `compare_profiles`, `explain_regression`, `find_n_plus_one`, `detect_smells`, `get_source_for_hotspot` (annotated source with per-line cost), `suggest_optimizations`, `trigger_profile`.

**Implementation bonus of the TS decision:** the MCP server can be a Node process that **imports the exact same parser module** as the browser UI — one parser, two consumers, no FFI boundary, no duplicated format edge-case handling. This was awkward under the Rust/WASM plan and is a real argument for TypeScript.

**The closed-loop workflow** (mirroring Chrome DevTools MCP): agent calls `trigger_profile` on a slow endpoint → `get_hotspots` → `get_source_for_hotspot` on the top function → proposes a patch → re-runs `trigger_profile` → `compare_profiles` to verify, iterating until a budget is met. This is the killer demo.

**LLM-friendly representation.** A raw 100k-node call tree overwhelms any context window. Return **top-N hotspots by self cost** with percentages, **collapse frames below a threshold** (<1% → "and 340 other functions"), **semantically group** vendor/framework namespaces, and emit compact structured JSON (function, self%, inclusive%, calls, file:line) rather than prose. For diffs, return only functions crossing `min_delta_pct`.

**Risks & mitigations.** (1) **Hallucinated optimization advice** — ground every suggestion in measured cost lines and real source; label AI output advisory. (2) **Source leaking to third-party LLMs** — AI features **opt-in**, support **local models (Ollama)**, keep the core fully client-side/offline. (3) **Prompt injection** via function names and file paths in profile data — sanitize tool outputs (Grafana's "GrafanaGhost" CVE is the cautionary tale). (4) Explicit consent before `trigger_profile` executes anything.

### 5. Product / Feature Brainstorm

**Core views (v1):** flame graph + icicle toggle (canvas); call tree (expand/collapse, inclusive+self); caller/callee panel driven from selection; sortable function list (self/inclusive/calls/self-per-call) with regex filter; source annotation with per-line cost gutter; **interactive node-graph call visualization** (React Flow — see 5c).

**Differentiators (v1.x–v2):** **zero-install XAMPP/WAMP drop-in** (see 5a); **preflight environment check** (see 5b); **interactive node-graph views** — framework layer flow, include/require dependency graph, N+1 clusters, diff graphs (see 5c); profile **diffing** (side-by-side + delta flame graph); **multi-run aggregation**; **request timeline** from `.xt` traces; **dual time+memory** axis; **framework-aware grouping** (Laravel/Symfony/WordPress presets); **SQL/IO & N+1 detection**; **"wall of shame"** report; **performance budgets**; **GitHub Action + PR-comment bot**; **shareable permalink / self-contained HTML report**; **drag-and-drop**; **client-side privacy mode vs optional server mode**; the **MCP server**.

**Architecture recommendation.** Default: **pure client-side React SPA, parsing in a TypeScript Web Worker into typed arrays, rendering to canvas**, with DuckDB-WASM added for querying once diffing lands. Layer on an **optional thin PHP dev-server** for file discovery, byte streaming, and source access — and, for team mode, a small persistent backend (PHP or Go) for cross-run storage, CI ingestion, and permalinks. Distribute as:
- (a) a **XAMPP/WAMP drop-in folder** — unzip into `htdocs/` or `www/`, visit `localhost/profiler`. **This is the primary distribution, not a fallback** (see 5a),
- (b) a **static web app** (host anywhere / open `index.html`, works offline, GitHub Pages–able),
- (c) a **`composer require --dev` package** shipping the built UI plus the thin server (`./vendor/bin/profiler-ui`),
- (d) a **Docker image**,
- (e) optionally an **Electron/Tauri desktop build** as a KCachegrind replacement,
- (f) **dev-environment integrations** (Laravel Herd, DDEV, Lando, Docker) that auto-discover `xdebug.output_dir`.

Because the parser is client-side, (a)–(c) come from one codebase with no duplicated logic.

---

### 5a. Zero-Install Drop-In for XAMPP / WAMP

**Why this is the primary distribution, not a nice-to-have.** XAMPP and WAMP are how the largest share of PHP developers run PHP locally — students, WordPress developers, agency devs, and the entire "learning PHP on Windows" pipeline. This audience is systematically underserved by every existing profiler:

- **KCachegrind is effectively unavailable to them.** It's a KDE/Qt app; on Windows it means hunting an unofficial build or WSL. Realistically, they never profile at all.
- **Composer is not universal here.** A meaningful share of XAMPP/WAMP users have never run `composer require`, and many projects on these stacks have no `composer.json` at all. Making Composer the entry point silently excludes them.
- **Webgrind actually got this right** — unzip into `htdocs`, open in a browser — and that single decision is a large part of why it remains the default despite being unmaintained and crash-prone. **Match its install experience, then beat everything else about it.**

**The install story, in full:**
1. Download `profiler.zip`, extract into `C:\xampp\htdocs\` (or `C:\wamp64\www\`)
2. Open `http://localhost/profiler`
3. The preflight page (5b) reports what's configured and what isn't, with copy-paste fixes
4. Click "Restart Apache" instructions, reload, profile

No CLI. No Node. No Composer. No terminal at all.

**Technical constraints this imposes** — these are real design costs and worth accepting deliberately:

- **PHP floor drops to 7.4.** XAMPP and WAMP installations lag badly; many are still on PHP 7.4 or 8.0. The thin server must target **7.4+**, not 8.1+. (The parser is client-side TypeScript, so this constrains only ~300 lines of PHP.) Detect and warn rather than fatally erroring on old versions.
- **Ship pre-built assets.** `dist/` with the compiled SPA committed to the release zip. No build step, no `node_modules`.
- **No Composer autoloader.** The PHP server must work with plain `require` — a `composer.json` can exist for the Packagist distribution, but the drop-in must not depend on `vendor/autoload.php` existing.
- **Windows path handling throughout.** Backslashes, drive letters, `C:\xampp\tmp` as default `output_dir`, case-insensitive comparisons, and `realpath()` differences. This is where naive Unix-assuming code breaks.
- **Bundled `.htaccess`** denying access to everything except the entry point, plus a loud warning that this tool exposes source code and must never be deployed to a public server.
- **`zlib` for gzip fallback** — if `DecompressionStream` is missing in an older bundled browser, the PHP side can `gzopen` and stream decompressed bytes instead.

**Auto-discovery of `output_dir`** should try, in order: `ini_get('xdebug.output_dir')` → `xdebug_info()` → `sys_get_temp_dir()` → known defaults (`C:\xampp\tmp`, `C:\wamp64\tmp`, `/tmp`, `/Applications/XAMPP/xamppfiles/temp`). Show which one it picked and let the user override it in the UI, persisted to a local config file.

**A deliberate scope note:** the drop-in is a *dev tool that reads local files*. Do not add upload, authentication, or multi-user features to it — that's the team/server edition's job. Keeping the drop-in dumb keeps it safe and keeps it a single folder.

---

### 5b. Preflight / Environment Status Page

**This is the landing page**, shown before any profile is opened, and reachable afterwards from a persistent status chip in the header. Its purpose is to answer the question every first-time profiler user actually has — *"why are there no profile files?"* — before they conclude the tool is broken.

Existing tools handle this badly: Webgrind shows an empty dropdown and no explanation, which sends people to StackOverflow rather than to a fix. **Diagnosing the environment is a genuine differentiating feature, not scaffolding.**

**Checks to run**, each rendered as pass / warn / fail with a specific, copy-pasteable remedy:

| Check | Failure message should include |
|---|---|
| PHP version | Detected version, and a warning if <7.4 |
| PHP SAPI & `php.ini` path | The **actual resolved path** from `php_ini_loaded_file()` — the single most useful fact, since XAMPP users routinely edit the wrong ini |
| Xdebug installed | If missing: link to the Xdebug installation wizard, plus the exact DLL/architecture note for Windows (thread-safe vs non-thread-safe, x64 vs x86 — the #1 XAMPP install failure) |
| Xdebug version | Warn on Xdebug 2.x (different ini keys *and* different time units — see the #132 unit bug); offer 2.x-specific config snippets |
| `xdebug.mode` | Show current value; flag if `profile` is absent. Note it **cannot** be set via `ini_set()` — only `php.ini` or the `XDEBUG_MODE` env var |
| `xdebug.start_with_request` | Explain `yes` (profiles everything, will fill the disk) vs `trigger` (recommended), and show the trigger URL/cookie to use |
| `xdebug.output_dir` | Resolved absolute path, **exists?**, **writable?** — with the Windows permission caveat |
| `xdebug.profiler_output_name` | Warn if it lacks `%p`/`%t`/`%r`, since a static name means runs overwrite each other and diffing becomes impossible |
| `xdebug.use_compression` | Note gzip is on by default since 3.1 and that this tool reads it fine (unlike QCacheGrind) |
| Profile files found | Count, newest timestamp, total size |
| Other profilers loaded | Warn if XHProf/Tideways/SPX is also active — they conflict |
| OPcache | Note that OPcache affects what gets profiled and may hide include costs |
| Disk space | Warn when `output_dir`'s volume is low, since `start_with_request=yes` fills disks fast |

**Design details that make this actually useful:**

- **Generate a ready-to-paste ini block** from the detected state, showing the exact `php.ini` path to edit and only the lines that need changing. Include a copy button.
- **Distinguish "not configured" from "configured but no runs yet."** These need completely different guidance and are the two states users confuse most.
- **A "Verify" button** that re-runs the checks after the user edits `php.ini`, with an explicit "you must restart Apache" step — this loop is where XAMPP users get stuck.
- **Show the trigger mechanism concretely:** the literal URL (`?XDEBUG_TRIGGER=1`), the cookie, and a bookmarklet, rather than describing them abstractly.
- **Degrade gracefully.** In pure static/offline mode there's no PHP to introspect, so the page should say so plainly and pivot to drag-and-drop, rather than showing a wall of failed checks.
- **Copy diagnostics as markdown** — a one-click block users can paste into a GitHub issue or forum post. This cuts your support burden substantially.
- Implement as a single JSON endpoint (`/api/preflight`) consumed by a React status view, so the same data feeds the header chip, the MCP server, and a future `--doctor` CLI flag.

**MCP tie-in:** expose the same data as an MCP tool (`check_environment`) so an agent can diagnose and *fix* a broken Xdebug setup — reading the report, editing `php.ini`, and prompting for the restart. That's a compelling second agentic demo alongside the optimization loop.

---

### 5c. Interactive Node-Graph Views (React Flow)

**The rendering split, stated precisely.** The project's "never render frames as DOM" rule is about *unbounded* data. React Flow mounts a real DOM element per node, which is the right trade when node count is small and bounded, and fatal when it isn't. So:

| View | Renderer | Why |
|---|---|---|
| Flame graph / icicle | **Canvas** | Unbounded — 100k+ frames. DOM is not an option |
| Function table | **Virtualized DOM** (TanStack Virtual) | Bounded to the viewport |
| Call graph, dependency graphs | **React Flow** | Deliberately capped at ~150–300 nodes |

The cap is not a limitation to apologize for — it's the correct UX. KCachegrind limits call-graph depth and node count too, because a 5,000-node hairball conveys nothing. **Every graph view must therefore be a curated subgraph around a focus point, never "the whole profile as a graph."**

**Why React Flow is a good fit here** (beyond looking modern): nodes are React components, so each one can render live data — a mini cost bar, call count, self-vs-inclusive split, a sparkline, a "jump to source" button. That is genuinely hard with Graphviz/dot output (Webgrind shells out to `python` + `dot` and gets a static image) and awkward with raw SVG. Built-in pan/zoom, minimap, selection, and edge routing come free. It's MIT-licensed (xyflow core; only Pro add-ons are paid), which fits the Apache-2.0 plan.

**Layout is the part React Flow does not do.** It positions nodes where you tell it to. For directed call graphs you need a layered/hierarchical layout:

- **ELK.js** (`elkjs`, `layered` algorithm) — best edge routing and layering quality for call graphs, handles back-edges from recursion sanely. Heavier, and **must run in a Web Worker** (`elk-worker.min.js`) or it blocks the main thread on graphs of any size.
- **Dagre** — lighter, faster, simpler API, adequate for graphs under ~100 nodes. Good first implementation; swap to ELK if quality disappoints.
- **d3-force** — only for the exploratory/clustered views (N+1 clusters), not for call hierarchies, where layered reads far better.

Recommendation: start with Dagre for v1, keep layout behind an interface, evaluate ELK once real graphs are on screen.

**The graph views worth building:**

1. **Focused call graph** (v1) — the primary one. Pick a function; show N levels of callers above and callees below, ranked by cost, with everything below a cost threshold collapsed into a single "42 more callers (3.1%)" node that expands on click. Edge thickness = call count or inclusive cost; edge label = calls × cost. Double-click any node to re-focus the graph on it. This is the caller/callee panel made spatial, and it's the view KCachegrind users will recognize immediately.

2. **Framework layer graph** (v0.5) — nodes are *groups* (Vendor, Composer autoload, Framework core, App code, Database, Templating), edges are aggregate cost flowing between them. This is a Sankey-flavored architectural summary and is the single most screenshot-worthy view for the README, because it says something a flame graph can't at a glance: *where your request's time structurally goes*.

3. **Include/require dependency graph** (v0.5) — `require::`/`include_once::` pseudo-functions already encode file load order and cost. Rendered as a graph, autoloading overhead becomes visually obvious. Nothing else in the PHP world shows this.

4. **N+1 cluster view** (v0.5) — force-directed clustering of repeated call signatures; a query executed 340 times renders as one heavy node with a fat edge from its caller. Pairs naturally with `find_n_plus_one`.

5. **Diff graph** (v0.3) — the focused call graph with delta coloring, edges thickened by cost change. Nodes appearing only in the "after" run get a distinct border. Answers "what changed *structurally*", not just which functions got slower.

6. **Recursion / cycle view** — cycles are where call graphs get genuinely confusing and where KCachegrind's cycle detection is a real feature. Detect strongly-connected components (Tarjan) and collapse each into a single expandable node, since otherwise inclusive cost double-counts and the layout tangles.

**Implementation notes that will bite otherwise:**

- **Build the subgraph in the Worker, not the UI.** Given a focus function, depth, and cost threshold, the Worker does the traversal over the columnar edge table and returns ≤300 nodes. The main thread never touches the full graph.
- **Compute layout in a Worker too**, then hand React Flow pre-positioned nodes. Layout, not rendering, is the thing that janks.
- **Use `nodeTypes` sparingly and memoize node components** — React Flow re-renders nodes aggressively; unmemoized custom nodes are the usual cause of sluggish pan/zoom.
- **Guard the cap in code.** A hard ceiling (say 400 nodes) with a "graph too large — raise the cost threshold" message, rather than letting a pathological profile lock the tab. This is the same failure Webgrind has; don't reintroduce it in a new place.
- **Export as SVG/PNG** — graph views are what people paste into PRs and tickets, so make export a first-class button.
- Persist focus function, depth, and threshold in the URL so graph views are shareable via permalink.

**Bundle-size caveat:** React Flow plus a layout engine adds meaningfully to the bundle. **Lazy-load the whole graph module** via a route-level dynamic import so the drop-in's first paint — flame graph and function table — stays fast for the XAMPP audience on modest hardware.

---

**Tech stack:** React 19 + TypeScript + Vite; TanStack Router + TanStack Query; Tailwind + shadcn/ui; **custom canvas/WebGL flame-graph renderer** (not d3-DOM, for scale) with TanStack Virtual for the function table; **React Flow (`@xyflow/react`, MIT) + Dagre or ELK.js** for bounded node-graph views, lazy-loaded and laid out in a Worker; **Web Workers** for parsing (`DecompressionStream` + `fflate` fallback, transferable typed arrays) and for subgraph extraction; **DuckDB-WASM** (or SQLite-WASM) for queries from v0.3; MCP server in **TypeScript (`@modelcontextprotocol/sdk`)** reusing the same parser package; **PHP 7.4+** (not 8.1+) for the thin dev-server, dependency-free and autoloader-free so it works as a bare drop-in on XAMPP/WAMP.

Suggested monorepo shape: `packages/parser` (framework-free TS, the shared core), `packages/web` (React UI), `packages/mcp` (Node MCP server), `packages/php-server` (Composer package).

**Naming ideas & positioning:**
- **Flamewatch** — "Modern flame-graph profiling for PHP."
- **Grindstone** — "Turn Xdebug profiles into answers."
- **Pyre** — "Read your PHP flame graphs in the browser. No install, no Qt, no crashes."
- **Cachegrind Studio** — **selected**. Descriptive, searchable by people already looking for a cachegrind viewer, and unambiguous about what it opens.
- Also considered: **Hotpath**, **Emberglass**, **Xprofile**, **Flamewatch**, **Grindstone**, **Pyre**
- Tagline: **"The web-based PHP profiler KCachegrind wishes it was — with an AI copilot. Drag in a cachegrind file, get a flame graph, diff two runs, and let your coding agent close the loop."**

### 6. Go-to-Market / OSS Strategy

**License:** **Apache-2.0** (or MIT) for parser + UI — maximizes adoption, lets you freely reuse speedscope's MIT ideas, friendliest for the `composer require --dev` audience; Apache-2.0 adds an explicit patent grant. **Avoid GPL/AGPL for the core** — it creates one-directional incompatibility with the MIT projects you want to borrow from and deters corporate contribution. If you later add a hosted edition, consider AGPL or BSL for the *server* component only, keeping the client analyzer permissive.

**Bootstrapping contributors.** The PHP performance community lives on r/PHP, PHP Mastodon/Bluesky, the PHP Foundation, Symfony/Laravel Discords, phparch.com, and conferences (SymfonyCon, Laracon, PHP[tek], Dutch PHP Conference — Derick Rethans's home turf). **The TypeScript decision helps here too**: a PHP developer can plausibly fix a TS parser bug; far fewer will learn Rust to do it. Launch with a killer demo GIF (drag file → flame graph), a live playground with a sample profile, and a Show HN / r/PHP post. Court Derick Rethans early and align with Xdebug 3.3+'s flame-graph formats.

**Sustainability: open core.** Free forever: client-side analyzer, parser, local MCP server. Paid: hosted/team edition (profile history, cross-request aggregation, CI dashboards, org permalinks, SSO) and/or GitHub Sponsors. Mirrors how Blackfire/Tideways monetize the server side while your client side stays free and beats Webgrind.

**Roadmap:**
- **v0.1 (MVP, ~6–10 weeks):** TS Worker parser (gzip-aware, Xdebug 3 unit-aware, columnar output); canvas flame graph + function table + source annotation; drag-and-drop; static web app. *Success metric: opens a 100 MB file without freezing the tab; parse under ~5 s.*
- **v0.15 (the adoption release):** **XAMPP/WAMP drop-in zip** (PHP 7.4+ thin server, pre-built `dist/`, no Composer, Windows path handling) + **preflight status page** with generated ini snippets and re-verify loop. *This ships before advanced views on purpose — a user who can't produce a profile file gets nothing from a better flame graph. Success metric: a Windows XAMPP user with no Xdebug configured reaches a rendered flame graph without leaving the tool or searching the web.*
- **v0.2:** call tree + caller/callee panel; regex filter; self-contained HTML export; Docker + `composer require --dev` distribution.
- **v0.3:** profile diffing + delta flame graph; **diff call graph** with delta-coloured nodes/edges; DuckDB-WASM query layer.
- **v0.4:** MCP server (reusing `packages/parser`); `.xt` trace ingestion + time-order view.
- **v0.5:** framework-aware grouping; N+1 / smells detection; memory view; **framework layer graph, include/require dependency graph, and N+1 cluster view** (React Flow).
- **v1.0:** GitHub Action + PR bot + performance budgets; multi-run aggregation; polished docs, playground, closed-loop agentic demo.

**Key risks.** (1) **Xdebug's shrinking relevance** for *production* profiling vs sampling profilers — mitigate by positioning as the *dev-time* deep profiler and supporting **multiple input formats** (cachegrind, `.xt`, speedscope JSON, folded stacks, ideally XHProf) so you aren't Xdebug-locked. This is the single most important strategic hedge. (2) **Parser performance on pathological files** — mitigate by benchmarking real 200 MB+ profiles early and keeping the parser interface swappable (WASM remains an option, not a prerequisite). (3) **Maintenance burden** of a custom canvas renderer — mitigate with strong tests and a small, focused core. (4) **Derick Rethans's roadmap** — Xdebug is actively maintained (3.5.x in 2026, native path mapping, new flame-graph formats) and his focus is the extension, not the analyzer, leaving this niche wide open. (5) Competing with free speedscope for generic flame graphs — differentiate via PHP-native features (source annotation, framework grouping, N+1, MCP) speedscope will never build.

## Recommendations

1. **Start with the client-side MVP**: TypeScript Worker parser + canvas flame graph + function table + source view. The highest-value, lowest-risk win is simply "Webgrind that doesn't crash and has a flame graph." Benchmark target: 100–200 MB gzipped cachegrind in under ~5 s with no tab freeze.
2. **Keep the parser as a standalone, framework-free package** with a `bytes → columnar profile` interface. It's what makes the web UI, the MCP server, and any future CLI share one implementation — and it's what makes a later WASM swap cheap if benchmarks demand it.
3. **Treat the XAMPP/WAMP drop-in and the preflight page as v0.15, ahead of advanced views.** Webgrind's durability despite being unmaintained is almost entirely an install-experience story; match it, then win on everything else. Accept the PHP 7.4 floor and the Windows path work as the price of reaching the largest local-PHP audience. Test on a real Windows XAMPP box, not WSL — WSL hides exactly the path and DLL-architecture problems this audience hits.
4. **Make multi-format ingestion a v0.x priority, not a v2 afterthought** — cachegrind + `.xt` + speedscope JSON + folded stacks. Decouples survival from Xdebug's fortunes. Threshold to expand: if >20% of issues request a format, add it.
5. **Build the MCP server once the query layer exists (v0.4)** and lead marketing with the closed-loop "agent optimizes PHP" demo — the defensible differentiator no competitor has.
6. **License Apache-2.0, clean-room from the Callgrind spec, never copy KCachegrind (GPL) code.** Freely borrow speedscope's (MIT) interaction patterns.
7. **Communicate the overhead caveat prominently in the UI** — a persistent "Xdebug profiling inflates absolute times; trust relative self-cost and call counts" note. Builds trust and prevents wrong conclusions.
8. **Court Derick Rethans and the PHP perf community early**; align with Xdebug 3.3+ flame-graph formats; launch on r/PHP + Show HN with a live playground.
9. **Keep the core free (open core); monetize only the hosted team/CI edition later.** Don't gate the analyzer.

## Caveats
- **Exact modern event-header string is inferred, not source-verified.** Real captures confirm `events: Time` and that modern Xdebug carries both Time and Memory; verify the precise two-token literal and whether `summary:` carries one or two values against Xdebug's `src/profiler/profiler.c` before finalizing the parser. Xdebug's memory numbers are documented as unreliable (freed memory shows as 0).
- **Xdebug 2 vs 3 time units differ** (Webgrind #132; a 16.66 s call rendered as 1,095,246 ms); detect version and normalize or absolute times will be wrong.
- **Parser performance targets are estimates.** The ~2–4× Rust-over-JS figure and the "under 5 s for 100 MB" goal are engineering judgment, not measured results for this specific workload. Benchmark a real large profile in week one — if TS parsing turns out to dominate interaction time, revisit WASM. The swappable-interface recommendation exists precisely because this number is unverified.
- **Some competitive/MCP figures come from secondary sources** (star counts, tool counts, pricing) and shift quickly; re-verify before publishing marketing claims.
- **MCP spec is a moving target** (2025-11-25 stable, 2026-07-28 RC); build against the SDK and pin a protocol version.
- **DuckDB-WASM performance claims** come from vendor/blog benchmarks; validate against real cachegrind workloads, as parsing/interning may dominate over query time.
- This is a project plan, not a guarantee of adoption; the space has several abandoned web-UI attempts, and execution quality — especially big-file rendering — will determine success.
