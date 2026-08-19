<?php
// Deliberately exercises the parser's sharp edges:
//  - user functions, methods, static methods, closures
//  - internal functions (fl=php:internal / fn=php::name)
//  - require / include_once pseudo-functions
//  - recursion (a cycle in the call graph)
//  - the same function called from several call sites, and the same call site
//    hit repeatedly (repeated cost lines that must be summed, not overwritten)
//  - a calibrated usleep so the Time cost unit can be verified empirically
//
// argv[1] scales the loop counts; argv[2] is the fib depth.

require __DIR__ . '/helper.php';
include_once __DIR__ . '/helper.php'; // already required — records an include_once

function fib(int $n): int
{
    return $n < 2 ? $n : fib($n - 1) + fib($n - 2);
}

function busyLoop(int $iterations): float
{
    $acc = 0.0;
    for ($i = 1; $i <= $iterations; $i++) {
        $acc += sqrt($i) / $i;
    }
    return $acc;
}

function allocate(int $count): array
{
    $data = [];
    for ($i = 0; $i < $count; $i++) {
        $data[] = str_repeat('x', 64);
    }
    return $data;
}

function calibrationSleep(): void
{
    // Exactly 500 ms of wall clock. Pins down the Time cost unit.
    usleep(500000);
}

$scale = isset($argv[1]) ? max(1, (int) $argv[1]) : 100;
$fibDepth = isset($argv[2]) ? (int) $argv[2] : 10;

$mapper = static function (int $v): int {
    return $v * $v;
};

calibrationSleep();

fib($fibDepth);
busyLoop($scale * 4);
busyLoop($scale);          // second call site for the same function
helperWork($scale);
helperWork((int) ($scale / 4));

$widget = Widget::make('demo');
foreach (range(1, $scale) as $n) {
    $widget->add($mapper($n));
}
$total = $widget->total();

$blob = allocate($scale);
unset($blob);

echo "total={$total}\n";
