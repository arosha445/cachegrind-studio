#!/usr/bin/env bash
#
# Reproduces every number in README.md. Needs a PHP with Xdebug 3 on PATH.
#
#   bash run.sh [tests] [callsPerTest] [reps]
#
set -u
cd "$(dirname "$0")"

TESTS=${1:-2000}
CALLS=${2:-20}
REPS=${3:-3}
PROF_DIR="$(mktemp -d 2>/dev/null || echo "${TMPDIR:-/tmp}/cgs-prof")"
mkdir -p "$PROF_DIR"
trap 'rm -rf "$PROF_DIR"' EXIT

php -r 'exit(extension_loaded("xdebug") ? 0 : 1);' || {
  echo "Xdebug is not loaded. These measurements need Xdebug 3 on PATH." >&2
  exit 1
}
php -r 'printf("PHP %s, Xdebug %s%s", PHP_VERSION, phpversion("xdebug"), PHP_EOL);'
echo

# --------------------------------------------------------------- overhead
best_of() {                  # best_of <mode> <php-args...>
  local mode="$1"; shift
  local best="" out="" secs=""
  for _ in $(seq "$REPS"); do
    out=$(php "$@" bench_suite.php "$mode" "$TESTS" "$CALLS" 2>&1) || { echo "FAILED|0|0"; return; }
    secs=$(echo "$out" | awk '{print $2}')
    if [ -z "$best" ] || awk "BEGIN{exit !($secs < $best)}"; then best="$secs"; fi
  done
  echo "$best|$(echo "$out" | awk '{print $5}')"
}

row() {                      # row <label> <mode> <php-args...>
  local label="$1"; shift
  local mode="$1"; shift
  local r; r=$(best_of "$mode" "$@")
  printf "%s|%s\n" "$label" "$r"
}

echo "== instrumentation overhead =="
echo "workload: ${TESTS} tests x ${CALLS} monitored calls = $((TESTS*CALLS)) total, best of ${REPS}"
{
  row "no xdebug (php -n)"           none             -n
  row "xdebug loaded, mode=off"      none             -d xdebug.mode=off
  row "mode=develop, no monitor"     none             -d xdebug.mode=develop
  row "+ function_count per test"    count            -d xdebug.mode=develop
  row "+ monitor, read once at end"  monitor-once     -d xdebug.mode=develop
  row "+ monitor, sentinel split"    monitor-sentinel -d xdebug.mode=develop
  row "+ monitor, naive per-test"    monitor-slice    -d xdebug.mode=develop
  row "mode=coverage (reference)"    none             -d xdebug.mode=coverage
  row "mode=profile (reference)"     none             -d xdebug.mode=profile \
        -d xdebug.start_with_request=yes -d xdebug.use_compression=0 \
        -d "xdebug.output_dir=$PROF_DIR" -d xdebug.profiler_output_name=b.out
} | awk -F'|' 'NR==1{base=$2} {printf "  %-32s %8.3f s  %7.1fx   peak %s MB\n", $1, $2, $2/base, $3}'

# ------------------------------------------------------------- scaling
echo
echo "== retrieval strategy, scaling =="
printf "  %6s | %14s | %14s | %8s\n" "tests" "naive per-test" "sentinel" "speedup"
for n in 500 1000 2000 4000; do
  a=$(php -d xdebug.mode=develop bench_suite.php monitor-slice "$n" "$CALLS" | awk '{print $2}')
  b=$(php -d xdebug.mode=develop bench_suite.php monitor-sentinel "$n" "$CALLS" | awk '{print $2, $5}')
  printf "  %6d | %12.3f s | %9.3f s %s | %7.1fx\n" \
    "$n" "$a" "$(echo "$b" | awk '{print $1}')" "$(echo "$b" | awk '{printf "%5sMB", $2}')" \
    "$(awk "BEGIN{printf \"%.1f\", $a/$(echo "$b" | awk '{print $1}')}")"
done

# ------------------------------------------------------------- workload shape
echo
echo "== overhead by workload shape =="
printf "  %-34s %10s %13s %10s\n" "shape" "no xdebug" "mode=develop" "multiplier"
for s in many-calls one-call internals io; do
  a=$(php -n shape.php "$s"); b=$(php -d xdebug.mode=develop shape.php "$s")
  printf "  %-34s %8.3f s %11.3f s %9.1fx\n" "$s" "$a" "$b" \
    "$(awk "BEGIN{printf \"%.1f\", $b/$a}")"
done

# ------------------------------------------------------------- capabilities
echo
echo "== runtime capabilities by mode =="
for m in off develop coverage trace gcstats profile "coverage,develop"; do
  php -d xdebug.mode="$m" -d xdebug.start_with_request=no capabilities.php "$m" 2>&1 | tail -1 | sed 's/^/  /'
done

echo
echo "== correctness of sentinel partitioning =="
php -d xdebug.mode=develop verify_sentinel.php | sed 's/^/  /'
