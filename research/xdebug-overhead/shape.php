<?php

declare(strict_types=1);

/**
 * Xdebug's overhead multiplier depends on the *shape* of the work, not on how
 * many function calls it makes. This script produces the evidence.
 *
 *   php shape.php <shape>
 *
 * Shapes:
 *   many-calls   50,000 calls x 400 in-language iterations
 *   one-call          1 call x 20,000,000 in-language iterations
 *                (same total arithmetic — if overhead were per *call*, the
 *                 second would be nearly free under Xdebug. It is not.)
 *   internals    heavy use of internal PHP functions (strings, arrays)
 *   io           blocking I/O, standing in for database round trips
 *
 * Run each under `php -n` and under `-d xdebug.mode=develop` and compare.
 */

$shape = isset($argv[1]) ? (string) $argv[1] : 'many-calls';

$startedAt = microtime(true);

switch ($shape) {
    case 'many-calls':
        $work = static function (): float {
            $sum = 0.0;
            for ($i = 1; $i < 400; $i++) {
                $sum += $i / ($i + 1);
            }
            return $sum;
        };
        $acc = 0.0;
        for ($i = 0; $i < 50000; $i++) {
            $acc += $work();
        }
        break;

    case 'one-call':
        $work = static function (): float {
            $sum = 0.0;
            for ($i = 1; $i < 20000000; $i++) {
                $sum += $i / ($i + 1);
            }
            return $sum;
        };
        $acc = $work();
        break;

    case 'internals':
        $acc = 0;
        for ($i = 0; $i < 60000; $i++) {
            $parts = explode(',', 'alpha,beta,gamma,delta,' . $i);
            sort($parts);
            $acc += strlen(implode('|', array_unique($parts)));
            $acc += strlen(str_pad((string) $i, 12, '0', STR_PAD_LEFT));
        }
        break;

    case 'io':
        $read = static function (): void {
            usleep(200);
        };
        for ($i = 0; $i < 2000; $i++) {
            $read();
        }
        $acc = 0;
        break;

    default:
        fwrite(STDERR, "unknown shape: {$shape}\n");
        exit(1);
}

printf("%.4f\n", microtime(true) - $startedAt);
unset($acc);
