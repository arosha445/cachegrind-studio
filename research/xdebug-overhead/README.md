# Per-test Xdebug instrumentation: what it costs, and what is even possible

Measured before committing to the "profiling assertions inside the test suite"
direction, because three of the assumptions behind it turned out to be wrong.

```bash
bash research/xdebug-overhead/run.sh          # reproduces everything below
```

Needs a PHP with Xdebug 3 on `PATH`. Numbers below are from **PHP 8.3.29 /
Xdebug 3.5.1, Windows 11, best of 3**. Absolute times are machine-specific;
the *multipliers* and the *shapes* are what matter.

---

## What is possible at all

| Question | Answer |
|---|---|
| Start/stop the profiler per test? | **No.** No `xdebug_start_profiling()` exists — only `get_profiler_filename`. |
| Change `xdebug.mode` at runtime? | **No.** It is `PHP_INI_SYSTEM`; `ini_set()` returns `false`. |
| One profile per test? | **No.** One cachegrind file per *process*, so one per suite run. |
| Which modes expose the function monitor? | **`develop` only.** |
| Flush the monitor log mid-run? | **No.** Cumulative for the process lifetime. |

Consequence: **per-test cost data cannot come from the profiler.** It has to
come from `xdebug_start_function_monitor()`, which is the only per-test-capable
runtime API.

## Why the profiler cannot substitute

A suite-wide cachegrind file attributes a test's *direct* calls perfectly,
because the caller is part of the edge key. It cannot attribute anything
reached through a shared intermediate, because those edges merge:

```
testMemberCheckout -> sharedLeaf   calls=50   exact
testGuestCheckout  -> sharedLeaf   calls=3    exact
midLayer           -> sharedLeaf   calls=42   fused: 2 from guest + 40 from member
```

Queries are always several layers deep, so this rules out reading per-test
query counts from a profile. `verify_sentinel.php` proves the monitor-based
approach gets this case right.

## Instrumentation overhead

2,000 tests × 20 monitored calls (40,000 total):

| Configuration | Time | vs baseline |
|---|---|---|
| No Xdebug (`php -n`) | 0.020 s | 1.0× |
| Xdebug loaded, `mode=off` | 0.020 s | **1.0×** |
| `mode=develop`, no monitor | 0.338 s | 16.9× |
| + `xdebug_get_function_count()` per test | 0.336 s | 16.8× |
| + monitor, single read at end | 0.389 s | 19.4× |
| **+ monitor, sentinel split** | **0.472 s** | **23.6×** |
| + monitor, naive per-test read | 9.493 s | 474.7× |
| `mode=coverage` (reference) | 0.354 s | 17.7× |
| `mode=profile` (reference) | 0.556 s | 27.8× |

**The monitor is nearly free — Xdebug being *on* is the cost.** Monitoring adds
~15% on top of `develop`. Xdebug 3's `off` really is free, so nothing is paid
when the feature is not in use.

## Retrieval strategy is load-bearing, not an optimisation

`xdebug_get_monitored_functions()` returns the **whole cumulative log** on every
call, so reading it per test is quadratic:

| Tests | Naive per-test | Sentinel (one read) | Peak mem | Speed-up |
|---|---|---|---|---|
| 500 | 0.357 s | 0.067 s | 8 MB | 5.3× |
| 1,000 | 1.870 s | 0.199 s | 16 MB | 9.4× |
| 2,000 | 12.770 s | 0.492 s | 30 MB | 26.0× |
| 4,000 | 55.616 s | 1.123 s | 60 MB | 49.5× |
| 8,000 | **fatal: 128 MB exhausted** | — | — | — |

**The sentinel approach:** monitor a no-op marker function, call it between
tests, read the log once at the end, and split on the marker in a single linear
pass. Records carry `function`, `filename` and `lineno` but **no timestamp**, so
a marker is the only way to recover test boundaries.

## Overhead depends on workload shape, not call count

Same 20 M arithmetic operations, redistributed:

| Shape | No Xdebug | `mode=develop` | Multiplier |
|---|---|---|---|
| 50,000 calls × 400 iterations | 0.258 s | 25.759 s | 99.7× |
| 1 call × 20,000,000 iterations | 0.253 s | 25.464 s | 100.8× |

Identical. **Xdebug's instrumentation is per-opcode, not per-call.** Reducing
function calls does not reduce its cost. What actually varies the multiplier is
how much time is spent outside PHP opcodes:

| Shape | No Xdebug | `mode=develop` | Multiplier |
|---|---|---|---|
| Blocking I/O (DB round trips) | 30.553 s | 30.593 s | **1.0×** |
| Internal PHP functions (strings, arrays) | 0.025 s | 0.172 s | 6.8× |
| Pure in-language compute | 0.253 s | 25.464 s | ~100× |

A real suite sits between these. I/O-bound time is free; framework bootstrap and
ORM hydration are opcode-heavy and are not.

## Memory

The log is retained by Xdebug for the whole process and cannot be flushed
(`stop()` + `start()` does not reset it). Reading it materialises the lot:
50,000 records cost **34 MB** of PHP heap, roughly 0.7 KB each — each record
carries a full filename string.

Two levers, both design-relevant:

- **Keep the monitored function list tight.** Log size scales with matched calls, not with tests.
- **Split the run across processes.** Paratest-style chunking bounds it per worker, and most large suites already do this.

## Mode support

| `xdebug.mode` | CPU (3 M iterations) | Monitor available |
|---|---|---|
| `off` | 0.037 s | no |
| `develop` | 2.262 s | **yes** |
| `coverage` | 2.564 s | no |
| `coverage,develop` | 2.563 s | **yes** |

**`coverage,develop` costs the same as `coverage` alone.** A project already
running Xdebug coverage in CI can add count monitoring for free — which is the
cheapest adoption path available and worth designing toward.

---

## Conclusions carried into the design

1. **Per-test counts come from the function monitor, not the profiler.** The profiler stays for explaining a failure (flame graph), not for asserting.
2. **The sentinel read strategy is mandatory.** A per-test read is quadratic and dies on a real suite. Recorded as an invariant in `CLAUDE.md`.
3. **Do not instrument the whole suite.** At ~7× on app-shaped code, a 2-minute suite becomes 10–15 minutes. A dedicated, opt-in performance suite of tens-to-low-hundreds of tests keeps the overhead in seconds.
4. **Lead with the coverage-job story.** Free for anyone already paying for Xdebug coverage.
