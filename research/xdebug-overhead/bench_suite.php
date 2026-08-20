<?php

declare(strict_types=1);

/**
 * Cost of per-test Xdebug instrumentation, over a workload shaped like a real
 * PHPUnit suite.
 *
 *   php bench_suite.php <mode> [tests] [monitoredCallsPerTest]
 *
 * Modes:
 *   none              workload only (still runs under whatever xdebug.mode the
 *                     caller set, so loading Xdebug can be priced separately)
 *   count             xdebug_get_function_count() delta per test — cheapest
 *                     possible signal, but no call sites
 *   monitor           function monitor, reading the log after every test
 *   monitor-slice     same, and keeping the new records so call sites survive
 *   monitor-once      monitor active, log read only at the end — isolates the
 *                     cost of monitoring from the cost of retrieval
 *   monitor-sentinel  monitor active, a marker call delimits each test, one
 *                     read at the end, partitioned in a single linear pass
 *
 * The `monitor` / `monitor-slice` modes are quadratic by construction:
 * xdebug_get_monitored_functions() returns the whole cumulative log every
 * call. They are here to demonstrate that, not as a suggestion.
 *
 * See README.md for results.
 */

// ------------------------------------------------------------------ workload

final class Row
{
    /** @var string */
    public $name;
    /** @var int */
    public $value;

    public function __construct(string $name, int $value)
    {
        $this->name = $name;
        $this->value = $value;
    }

    public function label(): string
    {
        return strtoupper($this->name) . ':' . $this->value;
    }
}

/**
 * A no-op whose only purpose is to appear in the monitored log as a marker, so
 * the cumulative log can be partitioned per test in one pass at the end.
 */
function cgs_boundary(): void
{
}

/** Stands in for PDOStatement::execute — the kind of call a suite would monitor. */
function db_query(string $sql, int $seed): array
{
    return ['id' => $seed, 'sql' => $sql];
}

function repository_find(int $id): Row
{
    // Reached through an intermediate on purpose: this is the case an
    // aggregated cachegrind profile cannot attribute back to an individual
    // test, because the caller->callee edge is shared across tests.
    $row = db_query('SELECT * FROM rows WHERE id = ?', $id);

    return new Row('row' . $row['id'], $row['id'] * 3);
}

function service_layer(int $id): string
{
    return repository_find($id)->label();
}

/** One test: object churn, string and array work, plus some monitored calls. */
function run_one_test(int $index, int $queries): int
{
    $acc = 0;
    $rows = [];
    for ($i = 0; $i < $queries; $i++) {
        $rows[] = service_layer($index * 100 + $i);
    }
    foreach ($rows as $label) {
        $acc += strlen($label);
    }
    $words = [];
    for ($i = 0; $i < 40; $i++) {
        $words[] = str_pad((string) ($index + $i), 6, '0', STR_PAD_LEFT);
    }
    sort($words);
    $acc += count(array_unique($words));
    $acc += strlen(implode(',', array_slice($words, 0, 10)));

    return $acc;
}

// ------------------------------------------------------------------- harness

$mode = isset($argv[1]) ? (string) $argv[1] : 'none';
$tests = isset($argv[2]) ? (int) $argv[2] : 2000;
$queries = isset($argv[3]) ? (int) $argv[3] : 20;

$monitored = ['db_query', 'PDO::exec', 'PDOStatement::execute', 'mysqli_query'];
if ($mode === 'monitor-sentinel') {
    $monitored[] = 'cgs_boundary';
}

$usesMonitor = strpos($mode, 'monitor') === 0;

$perTest = [];
$seenSoFar = 0;
$acc = 0;

$startedAt = microtime(true);

if ($usesMonitor) {
    xdebug_start_function_monitor($monitored);
}

for ($t = 0; $t < $tests; $t++) {
    if ($mode === 'count') {
        $before = xdebug_get_function_count();
        $acc += run_one_test($t, $queries);
        $perTest[$t] = xdebug_get_function_count() - $before;
        continue;
    }

    if ($mode === 'monitor') {
        $acc += run_one_test($t, $queries);
        $all = xdebug_get_monitored_functions();
        $perTest[$t] = count($all) - $seenSoFar;
        $seenSoFar = count($all);
        continue;
    }

    if ($mode === 'monitor-slice') {
        $acc += run_one_test($t, $queries);
        $all = xdebug_get_monitored_functions();
        $fresh = array_slice($all, $seenSoFar);
        $seenSoFar = count($all);
        $sites = [];
        foreach ($fresh as $record) {
            $key = $record['function'] . '@' . $record['lineno'];
            $sites[$key] = isset($sites[$key]) ? $sites[$key] + 1 : 1;
        }
        $perTest[$t] = $sites;
        continue;
    }

    if ($mode === 'monitor-sentinel') {
        cgs_boundary();
        $acc += run_one_test($t, $queries);
        continue;
    }

    $acc += run_one_test($t, $queries);
}

if ($usesMonitor) {
    $log = xdebug_get_monitored_functions();
    xdebug_stop_function_monitor();

    if ($mode === 'monitor-sentinel') {
        // One linear pass over the whole log, split on the marker.
        $current = -1;
        foreach ($log as $record) {
            if ($record['function'] === 'cgs_boundary') {
                $current++;
                $perTest[$current] = [];
                continue;
            }
            if ($current < 0) {
                continue;
            }
            $key = $record['function'] . '@' . $record['lineno'];
            $perTest[$current][$key] = isset($perTest[$current][$key])
                ? $perTest[$current][$key] + 1
                : 1;
        }
    }
}

printf(
    "%-18s %8.3f s   peak_mem %7.1f MB   tests=%d calls/test=%d  (checksum %d)\n",
    $mode,
    microtime(true) - $startedAt,
    memory_get_peak_usage(true) / 1048576,
    $tests,
    $queries,
    $acc % 100000
);
