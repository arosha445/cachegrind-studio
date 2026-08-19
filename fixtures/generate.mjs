#!/usr/bin/env node
/**
 * Regenerates the real-Xdebug fixtures in fixtures/callgrind/.
 *
 * Requires a local PHP with Xdebug 3 on PATH. The committed fixtures were
 * produced on Windows deliberately: backslash paths, drive letters and spaces
 * in paths are part of what the parser has to survive.
 *
 *   node fixtures/generate.mjs
 *
 * Note: xdebug.use_compression is a no-op on some Windows builds, so the
 * gzipped fixture is compressed here rather than by Xdebug. The bytes a parser
 * sees are identical either way — a gzip member is a gzip member.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, copyFileSync, mkdirSync, rmSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'callgrind');
const workload = join(here, 'generator', 'workload.php');

mkdirSync(outDir, { recursive: true });

/** Run the workload under the profiler and return the raw profile bytes. */
function profile(scale, fibDepth) {
  const scratch = mkdtempSync(join(tmpdir(), 'cgs-fixture-'));
  try {
    execFileSync(
      'php',
      [
        '-d', 'xdebug.mode=profile',
        '-d', 'xdebug.start_with_request=yes',
        '-d', 'xdebug.use_compression=0',
        '-d', `xdebug.output_dir=${scratch}`,
        '-d', 'xdebug.profiler_output_name=profile.out',
        workload,
        String(scale),
        String(fibDepth),
      ],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    );
    const produced = readdirSync(scratch);
    if (produced.length !== 1) {
      throw new Error(`expected one profile in ${scratch}, got ${produced.join(', ')}`);
    }
    return readFileSync(join(scratch, produced[0]));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function emit(name, bytes) {
  const dest = join(outDir, name);
  writeFileSync(dest, bytes);
  console.log(`${name.padEnd(28)} ${statSync(dest).size.toLocaleString()} bytes`);
}

const small = profile(40, 8);
emit('xdebug3-windows.out', small);
emit('xdebug3-windows.out.gz', gzipSync(small, { level: 6 }));
