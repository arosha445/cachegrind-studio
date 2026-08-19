import { describe, expect, it } from 'vitest';
import { parseProfile } from '../src/parse.js';
import { toMilliseconds } from '../src/format.js';
import { FunctionKind } from '../src/types.js';
import { edge, fixtureBytes, fnId, fnIdMatching, lineCost, parseFixture } from './fixtures.js';

describe('real Xdebug 3 output (Windows)', () => {
  it('reads the header and states the time unit from the events line', async () => {
    const profile = await parseFixture('xdebug3-windows.out');

    expect(profile.meta.version).toBe('1');
    expect(profile.meta.creatorTool).toBe('xdebug');
    expect(profile.meta.creatorMajor).toBe(3);
    expect(profile.meta.events).toEqual(['Time_(10ns)', 'Memory_(bytes)']);
    expect(profile.meta.timeUnit).toBe('10ns');
    expect(profile.meta.timeUnitSource).toBe('event-name');
    expect(profile.meta.timeToMs).toBeCloseTo(1e-5, 12);
    expect(profile.meta.compressed).toBe(false);
  });

  it('converts times correctly, checked against a calibrated 500 ms usleep', async () => {
    // The workload calls usleep(500000). Any unit mistake shows up here as a
    // factor of 100 or 1000 -- this is webgrind#132 as an assertion.
    const profile = await parseFixture('xdebug3-windows.out');
    const usleep = fnId(profile, 'php::usleep');
    const millis = toMilliseconds(profile, profile.functions.selfTime[usleep]!);
    expect(millis).toBeGreaterThan(450);
    expect(millis).toBeLessThan(750);
  });

  it('keeps Windows paths intact, spaces, backslashes and drive letter', async () => {
    const profile = await parseFixture('xdebug3-windows.out');
    const workload = profile.files.find((file) => file.endsWith('workload.php'));
    expect(workload).toBeDefined();
    expect(workload).toMatch(/^D:\\/);
    expect(workload).toContain('php profiler');
    expect(workload).toContain('\\');
  });

  it('finds {main} as the entry point', async () => {
    const profile = await parseFixture('xdebug3-windows.out');
    expect(profile.entryFnId).toBe(fnId(profile, '{main}'));
    expect(profile.functions.kind[profile.entryFnId]).toBe(FunctionKind.Main);
  });

  it('classifies internal functions, includes and userland code', async () => {
    const profile = await parseFixture('xdebug3-windows.out');
    expect(profile.functions.kind[fnId(profile, 'php::usleep')]).toBe(FunctionKind.Internal);
    expect(profile.functions.kind[fnId(profile, 'fib')]).toBe(FunctionKind.User);
    expect(profile.functions.kind[fnId(profile, 'Widget->add')]).toBe(FunctionKind.User);
    expect(profile.functions.kind[fnIdMatching(profile, 'require::')]).toBe(FunctionKind.Include);
  });

  it('records recursion as a self-edge rather than losing it', async () => {
    const profile = await parseFixture('xdebug3-windows.out');
    const fib = fnId(profile, 'fib');
    const selfEdge = edge(profile, fib, fib);
    expect(selfEdge.callCount).toBeGreaterThan(0);
    expect(profile.functions.invocations[fib]).toBeGreaterThan(1);
  });

  it('agrees with the header summary', async () => {
    const profile = await parseFixture('xdebug3-windows.out');
    expect(profile.summary.source).toBe('header');

    // Xdebug's `summary:` runs slightly *above* the sum of self costs -- it
    // measures the whole request, including work outside any function record.
    // On this fixture the residual is ~0.02%. Verified against an independent
    // recount of the raw file, so treat closeness, not equality, as correct.
    let totalSelf = 0;
    for (let fn = 0; fn < profile.functions.count; fn++) {
      totalSelf += profile.functions.selfTime[fn]!;
    }
    expect(totalSelf).toBeLessThanOrEqual(profile.summary.time);
    expect(totalSelf / profile.summary.time).toBeGreaterThan(0.999);
    expect(profile.warnings.map((w) => w.code)).not.toContain('summary-mismatch');
  });

  it('derives inclusive cost as self plus outgoing calls', async () => {
    const profile = await parseFixture('xdebug3-windows.out');
    const main = fnId(profile, '{main}');
    // Same ~0.02% residual as above: {main} accounts for everything the
    // profiler attributed to a function, which is just under the header total.
    expect(profile.functions.inclTime[main]! / profile.summary.time).toBeGreaterThan(0.999);
    expect(profile.functions.inclTime[main]).toBeLessThanOrEqual(profile.summary.time);

    const calibration = fnId(profile, 'calibrationSleep');
    const usleep = fnId(profile, 'php::usleep');
    const call = edge(profile, calibration, usleep);
    expect(profile.functions.inclTime[calibration]).toBeCloseTo(
      profile.functions.selfTime[calibration]! + call.inclTime,
      6,
    );
  });

  it('separates self cost from the inclusive cost of a call on the same line', async () => {
    const profile = await parseFixture('xdebug3-windows.out');
    const busyLoop = fnId(profile, 'busyLoop');
    const sqrt = fnId(profile, 'php::sqrt');

    // busyLoop's own loop overhead must not include the time spent inside sqrt.
    expect(profile.functions.selfTime[busyLoop]).toBeGreaterThan(0);
    expect(profile.functions.inclTime[busyLoop]).toBeGreaterThan(
      profile.functions.selfTime[busyLoop]!,
    );
    expect(edge(profile, busyLoop, sqrt).callCount).toBeGreaterThan(100);
  });

  it('produces no warnings on a well-formed profile', async () => {
    const profile = await parseFixture('xdebug3-windows.out');
    expect(profile.warnings).toEqual([]);
  });
});

describe('gzip', () => {
  it('transparently decompresses, yielding the same profile as the plain file', async () => {
    const plain = await parseFixture('xdebug3-windows.out');
    const gzipped = await parseFixture('xdebug3-windows.out.gz');

    expect(gzipped.meta.compressed).toBe(true);
    expect(plain.meta.compressed).toBe(false);
    expect(gzipped.meta.byteLength).toBe(plain.meta.byteLength);
    expect(gzipped.functionNames).toEqual(plain.functionNames);
    expect(gzipped.files).toEqual(plain.files);
    expect(gzipped.summary).toEqual(plain.summary);
    expect([...gzipped.functions.selfTime]).toEqual([...plain.functions.selfTime]);
    expect([...gzipped.calls.inclTime]).toEqual([...plain.calls.inclTime]);
  });
});

describe('Xdebug 2 vs 3 time units (webgrind#132)', () => {
  it('reads Xdebug 2 Time as microseconds', async () => {
    const profile = await parseFixture('xdebug2-timeunit.out');
    expect(profile.meta.creatorMajor).toBe(2);
    expect(profile.meta.timeUnit).toBe('us');
    expect(profile.meta.timeUnitSource).toBe('creator-version');
    // 504000 microseconds is 504 ms, not 504 seconds and not 5.04 ms.
    expect(toMilliseconds(profile, profile.summary.time)).toBeCloseTo(504, 6);
  });

  it('falls back to the creator version when the events line has no unit', async () => {
    const profile = await parseFixture('xdebug3-bare-time-event.out');
    expect(profile.meta.events).toEqual(['Time', 'Memory']);
    expect(profile.meta.timeUnit).toBe('10ns');
    expect(profile.meta.timeUnitSource).toBe('creator-version');
    expect(toMilliseconds(profile, profile.summary.time)).toBeCloseTo(504, 6);
  });

  it('warns rather than guessing silently when nothing states the unit', async () => {
    const profile = await parseFixture('subpositions.out');
    expect(profile.meta.timeUnit).toBe('unknown');
    expect(profile.meta.timeUnitSource).toBe('assumed');
    expect(profile.warnings.map((w) => w.code)).toContain('unknown-time-unit');
  });
});

describe('Xdebug bug #489: cfl= omitted on call lines', () => {
  it('resolves the callee file from the callee own fn= record', async () => {
    const profile = await parseFixture('no-cfl.out');
    const find = fnId(profile, 'Repo->find');
    const main = fnId(profile, '{main}');

    expect(profile.files[profile.functions.fileId[find]!]).toBe('/srv/app/src/Repo.php');
    expect(profile.files[profile.functions.fileId[main]!]).toBe('/srv/app/public/index.php');

    const call = edge(profile, main, find);
    expect(call.callCount).toBe(3);
    expect(call.inclTime).toBe(960);
    expect(profile.functions.invocations[find]).toBe(3);
  });
});

describe('missing summary (webgrind#125)', () => {
  it('computes totals instead of rendering everything as 0.00%', async () => {
    const profile = await parseFixture('no-summary.out');
    expect(profile.summary.source).toBe('computed');
    expect(profile.summary.time).toBe(1100);
    expect(profile.summary.memory).toBe(448);
    expect(profile.warnings.map((w) => w.code)).toContain('missing-summary');

    // The whole point: percentages are computable.
    const transform = fnId(profile, 'transform');
    expect(profile.functions.inclTime[transform]! / profile.summary.time).toBeCloseTo(1000 / 1100, 9);
  });
});

describe('repeated cost lines', () => {
  it('sums repeats for one position instead of overwriting', async () => {
    const profile = await parseFixture('repeated-positions.out');
    const tick = fnId(profile, 'tick');
    const main = fnId(profile, '{main}');

    // Line 5 appears three times across two records: 100 + 100 + 100.
    expect(lineCost(profile, tick, 5)).toBe(300);
    expect(lineCost(profile, tick, 6)).toBe(50);
    expect(profile.functions.selfTime[tick]).toBe(350);
    expect(profile.functions.selfMemory[tick]).toBe(48);

    // Two calls at line 9 merge into one edge; line 10 stays separate.
    expect(profile.calls.count).toBe(2);
    const merged = edge(profile, main, tick);
    expect(merged.callCount).toBe(3);
    expect(merged.inclTime).toBe(350);
    expect(profile.summary.time).toBe(390);
  });
});

describe('subposition compression', () => {
  it('resolves +n, -n and * against the previous position', async () => {
    const profile = await parseFixture('subpositions.out');
    const walker = fnId(profile, 'walker');

    expect(lineCost(profile, walker, 10)).toBe(100);
    expect(lineCost(profile, walker, 15)).toBe(200); // +5
    expect(lineCost(profile, walker, 12)).toBe(75); // -3 then *, summed
    expect(profile.functions.selfTime[walker]).toBe(375);
  });
});

describe('damaged input', () => {
  it('does not throw on a profile truncated mid-record', async () => {
    const profile = await parseFixture('truncated.out');
    expect(profile.warnings.map((w) => w.code)).toContain('truncated');
    expect(profile.functionNames).toContain('{main}');
    expect(profile.summary.time).toBeGreaterThan(0);
  });

  it('does not throw on an empty file', async () => {
    const profile = await parseFixture('empty.out');
    expect(profile.functions.count).toBe(0);
    expect(profile.calls.count).toBe(0);
    expect(profile.entryFnId).toBe(-1);
    expect(profile.summary.time).toBe(0);
    expect(profile.warnings.map((w) => w.code)).toContain('empty-input');
  });

  it('does not throw on bytes that are not a profile at all', async () => {
    const profile = await parseProfile(new TextEncoder().encode('this is not a cachegrind file'));
    expect(profile.functions.count).toBe(0);
    expect(profile.entryFnId).toBe(-1);
  });
});

describe('progress reporting', () => {
  it('reports scan and aggregate phases', async () => {
    const phases: string[] = [];
    await parseProfile(fixtureBytes('xdebug3-windows.out.gz'), {
      onProgress: (progress) => {
        phases.push(progress.phase);
      },
    });
    expect(phases).toContain('decompress');
    expect(phases).toContain('scan');
    expect(phases).toContain('aggregate');
  });
});
