<?php

declare(strict_types=1);

/**
 * Proves that sentinel partitioning of the function-monitor log is *exact*,
 * including for calls made through a shared intermediate — the case an
 * aggregated cachegrind profile provably cannot attribute to a single test.
 *
 *   php -d xdebug.mode=develop verify_sentinel.php
 *
 * If this ever starts failing, the per-test counting strategy is broken and
 * the assertions built on it are lying.
 */

function cgs_boundary(): void
{
}

function db_query(string $sql): int
{
    return strlen($sql);
}

/** Shared by every test, so its caller->callee edge is fused in a profile. */
function through_a_shared_layer(int $times): void
{
    for ($i = 0; $i < $times; $i++) {
        db_query('via shared layer');
    }
}

xdebug_start_function_monitor(['db_query', 'cgs_boundary']);

// [direct calls, calls through the shared layer]
$plan = [
    'testGuestCheckout' => [3, 2],
    'testMemberCheckout' => [50, 40],
    'testEmptyCart' => [0, 1],
    'testNoQueries' => [0, 0],
];

$expected = [];
foreach ($plan as $name => $counts) {
    cgs_boundary();
    for ($i = 0; $i < $counts[0]; $i++) {
        db_query('direct');
    }
    through_a_shared_layer($counts[1]);
    $expected[$name] = $counts[0] + $counts[1];
}

$log = xdebug_get_monitored_functions();
xdebug_stop_function_monitor();

// Single linear pass, splitting on the marker.
$names = array_keys($plan);
$actual = [];
$current = -1;
foreach ($log as $record) {
    if ($record['function'] === 'cgs_boundary') {
        $current++;
        $actual[$names[$current]] = 0;
        continue;
    }
    if ($current >= 0) {
        $actual[$names[$current]]++;
    }
}

$ok = true;
foreach ($expected as $name => $want) {
    $got = isset($actual[$name]) ? $actual[$name] : -1;
    $pass = $want === $got;
    $ok = $ok && $pass;
    printf("  %-22s expected %-4d got %-4d %s\n", $name, $want, $got, $pass ? 'OK' : 'MISMATCH');
}

echo $ok
    ? "\nPASS: sentinel partitioning is exact, including through shared intermediates.\n"
    : "\nFAIL: per-test attribution is wrong.\n";

exit($ok ? 0 : 1);
