# Fixtures

Real and hand-written Callgrind files backing the parser test suite. **Do not delete these** — several encode a specific documented bug, and the comment explaining why is the test, not the file.

Regenerate the Xdebug-produced ones with:

```bash
pnpm fixtures:generate
```

That needs a local PHP with Xdebug 3 on `PATH`. It runs `generator/workload.php` under the profiler and copies the result into `callgrind/`.

## The corpus

| File | What it pins down |
|---|---|
| `xdebug3-windows.out` | Real Xdebug 3.5.1 output, generated on Windows. Backslash paths, a drive letter and a space in the directory name are all deliberate — POSIX-only path handling breaks silently on this. Contains a calibrated `usleep(500000)`, so the time unit can be checked against ground truth rather than assumed. |
| `xdebug3-windows.out.gz` | The same profile, gzipped. Xdebug 3.1+ compresses by default and still names the file `cachegrind.out.*`, so the parser sniffs magic bytes rather than the extension. |
| `xdebug2-timeunit.out` | Xdebug 2 output shape: `creator: xdebug 2.9.8` with a bare `events: Time Memory`, where Time is microseconds. Reading it as Xdebug 3 units inflates every number ~100x — this is [webgrind#132](https://github.com/jokkedk/webgrind/issues/132). |
| `xdebug3-bare-time-event.out` | Xdebug 3 that has not yet labelled its unit in the events line. Forces the fallback from event name to `creator:` version. |
| `no-cfl.out` | `cfn=` with no `cfl=`, per [Xdebug bug #489](https://bugs.xdebug.org/view.php?id=489). The callee's file has to come from the callee's own `fn=` record. |
| `no-summary.out` | No `summary:` line. Without a computed fallback every row renders as `0.00%` — [webgrind#125](https://github.com/jokkedk/webgrind/issues/125). Totals here are hand-checkable: self costs sum to 1100. |
| `repeated-positions.out` | The same position emitted several times across several records, plus two calls to one callee from one line. Repeats must be **summed**, not overwritten. |
| `subpositions.out` | Relative subposition compression (`+5`, `-3`, `*`) from the Callgrind spec, which Xdebug never emits but the format allows. Also has no `creator:` line at all, exercising the "unit unknown, say so" path. |
| `truncated.out` | Ends mid-record, as if the process was killed. Must warn, not throw. |
| `empty.out` | Zero bytes. Must warn, not throw. |

## Generating a large profile

Nothing above is big. Committing a 100 MB profile is not reasonable, so size-dependent work uses a synthesiser instead:

- `packages/parser/bench/synthetic.ts` builds a realistically-shaped profile at any target size. It mirrors what actually makes real profiles large — Xdebug writes one record per *invocation*, over a small set of compressed names.

To produce a large real one locally, raise the workload scale:

```bash
php -d xdebug.mode=profile -d xdebug.start_with_request=yes \
    -d xdebug.output_dir=/tmp \
    fixtures/generator/workload.php 20000 25
```

Keep large profiles out of git — `fixtures/large/` is gitignored for this.

## Adding a fixture

When you fix a parser bug, add the smallest file that reproduces it and say in this table what it pins down. A fixture whose expected values cannot be worked out by hand is hard to trust later; the hand-written ones above all have totals that add up on paper.
