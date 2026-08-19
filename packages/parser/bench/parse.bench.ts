import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bench, describe } from 'vitest';
import { parseProfile } from '../src/parse.js';
import { scanCallgrind } from '../src/scan.js';
import { buildFlameGraph } from '../src/tree.js';
import { synthesizeCallgrind } from './synthetic.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, '..', '..', '..', 'fixtures', 'callgrind');

function fixture(name: string): Uint8Array {
  const buffer = readFileSync(join(fixtureDir, name));
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

const realPlain = fixture('xdebug3-windows.out');
const realGzipped = fixture('xdebug3-windows.out.gz');

// Sized so a run stays quick while still being large enough that per-call
// overhead is noise. Multiply the reported MB/s out to 200 MB to check the
// v0.1 target.
const synthetic8 = synthesizeCallgrind({ targetBytes: 8 << 20 });
const synthetic32 = synthesizeCallgrind({ targetBytes: 32 << 20 });

describe('scan (decompressed bytes -> columnar profile)', () => {
  bench('real Xdebug profile, 28 KB', () => {
    scanCallgrind(realPlain, false);
  });

  bench('synthetic, 8 MB', () => {
    scanCallgrind(synthetic8, false);
  });

  bench('synthetic, 32 MB', () => {
    scanCallgrind(synthetic32, false);
  });
});

describe('parse (includes gzip)', () => {
  bench('gzipped real profile', async () => {
    await parseProfile(realGzipped);
  });
});

describe('flame graph', () => {
  const profile = scanCallgrind(synthetic8, false);

  bench('build from an 8 MB profile', () => {
    buildFlameGraph(profile);
  });

  // A dense random call graph: thousands of functions, high out-degree after
  // merging. This is the shape that made an earlier build walk ~88 million
  // subtrees past the node ceiling and take 18 s. It must stay bounded by
  // maxNodes, not by the size of the graph.
  const dense = scanCallgrind(
    synthesizeCallgrind({ targetBytes: 12 << 20, functionCount: 4000, callsPerRecord: 4 }),
    false,
  );

  bench('build from a dense 12 MB profile (node ceiling)', () => {
    buildFlameGraph(dense);
  });
});
