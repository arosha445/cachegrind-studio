import { describe, expect, it } from 'vitest';
import { FLAME_FLAG_PRUNED, FLAME_FLAG_RECURSIVE, buildFlameGraph } from '../src/tree.js';
import {
  callSiteCostsForFile,
  callersOf,
  calleesOf,
  collectTransferables,
  selfLinesForFile,
  selfLinesForFunction,
} from '../src/queries.js';
import { fnId, parseFixture } from './fixtures.js';

describe('flame graph construction', () => {
  it('roots at {main} with its full inclusive cost', async () => {
    const profile = await parseFixture('xdebug3-windows.out');
    const flame = buildFlameGraph(profile);

    expect(flame.count).toBeGreaterThan(0);
    expect(flame.rootFnId).toBe(profile.entryFnId);
    expect(flame.fnId[0]).toBe(profile.entryFnId);
    expect(flame.depth[0]).toBe(0);
    expect(flame.start[0]).toBe(0);
    expect(flame.value[0]).toBe(profile.functions.inclTime[profile.entryFnId]);
    expect(flame.total).toBe(flame.value[0]);
  });

  it('lays children out inside the parent without overlap', async () => {
    const profile = await parseFixture('xdebug3-windows.out');
    const flame = buildFlameGraph(profile);

    const childrenOf = new Map<number, number[]>();
    for (let node = 1; node < flame.count; node++) {
      const parent = flame.parent[node]!;
      const list = childrenOf.get(parent);
      if (list === undefined) childrenOf.set(parent, [node]);
      else list.push(node);
    }

    for (const [parent, children] of childrenOf) {
      const parentStart = flame.start[parent]!;
      const parentEnd = parentStart + flame.value[parent]!;
      let cursor = parentStart;
      let attributed = 0;
      for (const child of children) {
        expect(flame.depth[child]).toBe(flame.depth[parent]! + 1);
        expect(flame.start[child]).toBeCloseTo(cursor, 6);
        cursor += flame.value[child]!;
        attributed += flame.value[child]!;
        expect(cursor).toBeLessThanOrEqual(parentEnd + 1e-6);
      }
      // Whatever is not attributed to a child is the function's own work.
      expect(flame.selfValue[parent]).toBeCloseTo(flame.value[parent]! - attributed, 6);
    }
  });

  it('orders siblings largest first', async () => {
    const profile = await parseFixture('xdebug3-windows.out');
    const flame = buildFlameGraph(profile);
    for (let node = 1; node < flame.count; node++) {
      const parent = flame.parent[node]!;
      const previous = node - 1;
      if (previous >= 1 && flame.parent[previous] === parent) {
        expect(flame.value[previous]).toBeGreaterThanOrEqual(flame.value[node]!);
      }
    }
  });

  it('terminates on recursion and flags where it stopped', async () => {
    const profile = await parseFixture('xdebug3-windows.out');
    const flame = buildFlameGraph(profile, { minFraction: 0 });
    const fib = fnId(profile, 'fib');

    const recursiveFib = [...flame.fnId.slice(0, flame.count)].some(
      (fn, node) => fn === fib && (flame.flags[node]! & FLAME_FLAG_RECURSIVE) !== 0,
    );
    expect(recursiveFib).toBe(true);
    expect(flame.maxDepth).toBeLessThanOrEqual(128);

    // Nothing below a recursion stop should have been expanded.
    for (let node = 0; node < flame.count; node++) {
      if ((flame.flags[node]! & FLAME_FLAG_RECURSIVE) === 0) continue;
      const hasChildren = [...flame.parent.slice(0, flame.count)].includes(node);
      expect(hasChildren).toBe(false);
    }
  });

  it('respects the node ceiling and reports that it pruned', async () => {
    const profile = await parseFixture('xdebug3-windows.out');
    const flame = buildFlameGraph(profile, { minFraction: 0, maxNodes: 5 });
    expect(flame.count).toBeLessThanOrEqual(5);
    expect(flame.prunedNodes).toBeGreaterThan(0);
    expect(flame.flags.some((flag) => (flag & FLAME_FLAG_PRUNED) !== 0)).toBe(true);
  });

  it('respects the depth cap', async () => {
    const profile = await parseFixture('xdebug3-windows.out');
    const flame = buildFlameGraph(profile, { minFraction: 0, maxDepth: 2 });
    expect(flame.maxDepth).toBeLessThanOrEqual(2);
  });

  it('builds a memory flame graph from the second event column', async () => {
    const profile = await parseFixture('xdebug3-windows.out');
    const flame = buildFlameGraph(profile, { metric: 'memory' });
    expect(flame.metric).toBe('memory');
    expect(flame.total).toBe(profile.functions.inclMemory[profile.entryFnId]);
  });

  it('returns an empty graph rather than throwing on an empty profile', async () => {
    const profile = await parseFixture('empty.out');
    const flame = buildFlameGraph(profile);
    expect(flame.count).toBe(0);
    expect(flame.total).toBe(0);
  });

  it('splits a shared callee proportionally between its call sites', async () => {
    // busyLoop is called twice from {main} with different costs; sqrt sits
    // under it. The sqrt rectangle must scale with the branch it hangs from.
    const profile = await parseFixture('xdebug3-windows.out');
    const flame = buildFlameGraph(profile, { minFraction: 0 });
    const sqrt = fnId(profile, 'php::sqrt');

    let sqrtTotal = 0;
    for (let node = 0; node < flame.count; node++) {
      if (flame.fnId[node] === sqrt) sqrtTotal += flame.value[node]!;
    }
    expect(sqrtTotal).toBeCloseTo(profile.functions.inclTime[sqrt]!, 4);
  });
});

describe('queries', () => {
  it('returns per-line self cost for source annotation', async () => {
    const profile = await parseFixture('repeated-positions.out');
    const tick = fnId(profile, 'tick');
    const lines = selfLinesForFunction(profile, tick);
    expect(lines).toEqual([
      { line: 5, time: 300, memory: 48 },
      { line: 6, time: 50, memory: 0 },
    ]);
  });

  it('merges per-line cost across every function in a file', async () => {
    const profile = await parseFixture('repeated-positions.out');
    const fileId = profile.files.indexOf('/app/loop.php');
    const byLine = selfLinesForFile(profile, fileId);
    expect(byLine.get(5)?.time).toBe(300);
    expect(byLine.get(1)?.time).toBe(40); // {main}, same file
  });

  it('attributes call cost to the calling line, not the declaration line', async () => {
    // Xdebug charges a function's self cost to its `function foo()` line, so
    // self cost alone puts every number in the wrong place. busyLoop's own
    // work lands on its declaration; the sqrt calls land on the loop body.
    const profile = await parseFixture('xdebug3-windows.out');
    const busyLoop = fnId(profile, 'busyLoop');
    const fileId = profile.functions.fileId[busyLoop]!;

    const selfByLine = selfLinesForFile(profile, fileId);
    const callsByLine = callSiteCostsForFile(profile, fileId);

    const declarationLine = [...selfByLine.values()].find(
      (cost) => cost.time === profile.functions.selfTime[busyLoop],
    );
    expect(declarationLine).toBeDefined();

    // 200 sqrt calls, all from one line inside the loop.
    const sqrtLine = [...callsByLine.values()].find((cost) => cost.callCount === 200);
    expect(sqrtLine).toBeDefined();
    expect(sqrtLine!.line).not.toBe(declarationLine!.line);
    expect(sqrtLine!.inclTime).toBeGreaterThan(0);
  });

  it('lists callers and callees', async () => {
    const profile = await parseFixture('xdebug3-windows.out');
    const sqrt = fnId(profile, 'php::sqrt');
    const busyLoop = fnId(profile, 'busyLoop');

    expect(callersOf(profile, sqrt).map((e) => e.callerFnId)).toContain(busyLoop);
    expect(calleesOf(profile, busyLoop).map((e) => e.calleeFnId)).toContain(sqrt);
    expect(callersOf(profile, profile.entryFnId)).toEqual([]);
  });

  it('collects every column buffer for a zero-copy postMessage', async () => {
    const profile = await parseFixture('xdebug3-windows.out');
    const transferables = collectTransferables(profile);
    expect(transferables.length).toBeGreaterThan(0);
    expect(new Set(transferables).size).toBe(transferables.length);
    expect(transferables).toContain(profile.functions.selfTime.buffer);
    expect(transferables).toContain(profile.calls.inclTime.buffer);
  });
});
