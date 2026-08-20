<?php

declare(strict_types=1);

/**
 * What Xdebug actually permits at runtime, and what each mode costs.
 *
 *   php capabilities.php            # run under the mode you want to price
 *   bash run.sh                     # runs it across every mode
 *
 * Three questions this answers, each of which constrains the design:
 *   1. Can the profiler be started/stopped per test?  (no)
 *   2. Which modes expose the function monitor?        (develop only)
 *   3. Can the monitor log be flushed mid-run?         (no)
 */

// ini_get() reports an empty string for `off` on some builds, so prefer the
// mode the caller asked for when it is passed in.
$mode = isset($argv[1]) && $argv[1] !== '--verbose' ? (string) $argv[1] : (string) ini_get('xdebug.mode');
if ($mode === '') {
    $mode = 'off';
}

// --- 1. Can profiling be toggled at runtime? -------------------------------
$profilerFns = array_values(array_filter(
    get_extension_funcs('xdebug') ?: [],
    static function (string $fn): bool {
        return strpos($fn, 'profil') !== false;
    }
));
$canToggleMode = @ini_set('xdebug.mode', 'profile') !== false;
@ini_restore('xdebug.mode');

// --- 2. Is the function monitor available in this mode? --------------------
$monitorWorks = false;
if (function_exists('xdebug_start_function_monitor')) {
    try {
        @xdebug_start_function_monitor(['cgs_probe']);
        cgs_probe();
        cgs_probe();
        $log = @xdebug_get_monitored_functions();
        @xdebug_stop_function_monitor();
        $monitorWorks = is_array($log) && count($log) >= 2;
    } catch (Throwable $e) {
        $monitorWorks = false;
    }
}

function cgs_probe(): void
{
}

// --- 3. CPU cost in this mode ----------------------------------------------
// Pure in-language arithmetic: no function calls, so this prices Xdebug's
// per-opcode instrumentation rather than its per-call hook.
$startedAt = microtime(true);
$sum = 0.0;
for ($i = 1; $i < 3000000; $i++) {
    $sum += $i / ($i + 1);
}
$cpu = microtime(true) - $startedAt;

printf(
    "%-20s monitor=%-3s  runtime_mode_change=%-3s  cpu=%6.3f s\n",
    $mode,
    $monitorWorks ? 'YES' : 'no',
    $canToggleMode ? 'YES' : 'no',
    $cpu
);

if (in_array('--verbose', $argv, true)) {
    echo '  profiler start/stop functions exposed: ',
        $profilerFns === [] ? '(none)' : implode(', ', $profilerFns), "\n";

    // --- 4. Is the monitor log flushable? ---------------------------------
    if ($monitorWorks) {
        xdebug_start_function_monitor(['cgs_probe']);
        for ($i = 0; $i < 50000; $i++) {
            cgs_probe();
        }
        $first = count(xdebug_get_monitored_functions());
        xdebug_stop_function_monitor();
        gc_collect_cycles();

        xdebug_start_function_monitor(['cgs_probe']);
        cgs_probe();
        $second = count(xdebug_get_monitored_functions());
        xdebug_stop_function_monitor();

        printf(
            "  log after 50k calls: %d; after stop()+start()+1 call: %d  => %s\n",
            $first,
            $second,
            $second <= 2 ? 'FLUSHABLE' : 'NOT flushable (cumulative for the process lifetime)'
        );
        printf(
            "  materialising the log cost %.1f MB of PHP heap\n",
            memory_get_peak_usage(true) / 1048576
        );
    }
}
