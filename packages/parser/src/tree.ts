import { growF64, growI32, growU8, nextCapacity, trimF64, trimI32, trimU8 } from './growable.js';
import { createHashIndex, lookupOrInsert } from './hashindex.js';
import type { Profile } from './types.js';

/**
 * Flame graph construction.
 *
 * A cachegrind file is an *aggregated* call graph, not a recorded stack sample
 * — the temporal order is gone. A flame graph is therefore synthesised: expand
 * the call graph from the entry point, and where a callee has several callers,
 * split its inclusive cost between them in proportion to each edge.
 *
 * Output is flat typed arrays, one entry per rectangle, which is exactly what
 * the canvas renderer wants. Nothing here knows about the DOM.
 */

export type FlameMetric = 'time' | 'memory';

/** Expansion stopped here because the function is already on the ancestor path. */
export const FLAME_FLAG_RECURSIVE = 1;
/** Children existed but fell below the cost threshold or the depth cap. */
export const FLAME_FLAG_PRUNED = 2;

export interface FlameGraphOptions {
  /** Root of the expansion. Defaults to `profile.entryFnId`. */
  readonly rootFnId?: number;
  readonly metric?: FlameMetric;
  /**
   * Skip subtrees below this fraction of the root's value. Defaults to 0:
   * culling belongs at draw time, where the zoom level is known. Dropping a
   * frame at build time makes it unreachable however far the user zooms in,
   * which is exactly when they want to see it.
   */
  readonly minFraction?: number;
  readonly maxDepth?: number;
  /** Hard ceiling on rectangles. Protects the tab from pathological profiles. */
  readonly maxNodes?: number;
}

export interface FlameGraph {
  readonly count: number;
  readonly fnId: Int32Array;
  readonly depth: Int32Array;
  /** Offset along the value axis, in raw cost units. */
  readonly start: Float64Array;
  readonly value: Float64Array;
  /** Value not attributed to any child — the function's own work at this node. */
  readonly selfValue: Float64Array;
  readonly parent: Int32Array;
  readonly callCount: Float64Array;
  readonly flags: Uint8Array;
  readonly total: number;
  readonly maxDepth: number;
  readonly rootFnId: number;
  readonly metric: FlameMetric;
  /** Frames whose children were not fully expanded. */
  readonly prunedNodes: number;
  /**
   * True when `maxNodes` was reached, so the graph is a partial view of a
   * pathologically large call graph rather than the whole thing.
   */
  readonly hitNodeCeiling: boolean;
}

/** Call graph edges merged per (caller, callee), in compressed-sparse-row form. */
interface CallGraphIndex {
  /** `offsets[fn] .. offsets[fn + 1]` is the range of out-edges for `fn`. */
  readonly offsets: Int32Array;
  readonly callee: Int32Array;
  readonly value: Float64Array;
  readonly callCount: Float64Array;
}

/**
 * Merge the call table by (caller, callee) — a flame graph node is a function,
 * not a call site — and index it for O(1) child lookup.
 */
export function buildCallGraphIndex(profile: Profile, metric: FlameMetric): CallGraphIndex {
  const { calls, functions } = profile;
  const edgeValue = metric === 'memory' ? calls.inclMemory : calls.inclTime;

  const merged = createHashIndex(Math.max(1024, calls.count));
  let value = new Float64Array(1024);
  let callCount = new Float64Array(1024);

  for (let edge = 0; edge < calls.count; edge++) {
    const caller = calls.callerFnId[edge]!;
    const callee = calls.calleeFnId[edge]!;
    if (caller < 0 || callee < 0) continue;
    const entry = lookupOrInsert(merged, caller, callee, 0);
    if (merged.inserted && entry >= value.length) {
      const capacity = nextCapacity(value.length, entry + 1, 1024);
      value = growF64(value, capacity);
      callCount = growF64(callCount, capacity);
    }
    value[entry]! += edgeValue[edge]!;
    callCount[entry]! += calls.callCount[edge]!;
  }

  // Counting sort into CSR order, keyed by caller.
  const functionCount = functions.count;
  const offsets = new Int32Array(functionCount + 1);
  for (let entry = 0; entry < merged.size; entry++) {
    offsets[merged.k0[entry]! + 1]! += 1;
  }
  for (let fn = 0; fn < functionCount; fn++) {
    offsets[fn + 1]! += offsets[fn]!;
  }

  const cursor = offsets.slice(0, functionCount);
  const calleeColumn = new Int32Array(merged.size);
  const valueColumn = new Float64Array(merged.size);
  const callCountColumn = new Float64Array(merged.size);
  for (let entry = 0; entry < merged.size; entry++) {
    const caller = merged.k0[entry]!;
    const slot = cursor[caller]!;
    cursor[caller] = slot + 1;
    calleeColumn[slot] = merged.k1[entry]!;
    valueColumn[slot] = value[entry]!;
    callCountColumn[slot] = callCount[entry]!;
  }

  return { offsets, callee: calleeColumn, value: valueColumn, callCount: callCountColumn };
}

export function buildFlameGraph(profile: Profile, options: FlameGraphOptions = {}): FlameGraph {
  const metric: FlameMetric = options.metric ?? 'time';
  const rootFnId = options.rootFnId ?? profile.entryFnId;
  const minFraction = options.minFraction ?? 0;
  const maxDepth = options.maxDepth ?? 128;
  const maxNodes = options.maxNodes ?? 200_000;

  const inclusive = metric === 'memory' ? profile.functions.inclMemory : profile.functions.inclTime;
  const functionCount = profile.functions.count;

  const empty: FlameGraph = {
    count: 0,
    fnId: new Int32Array(0),
    depth: new Int32Array(0),
    start: new Float64Array(0),
    value: new Float64Array(0),
    selfValue: new Float64Array(0),
    parent: new Int32Array(0),
    callCount: new Float64Array(0),
    flags: new Uint8Array(0),
    total: 0,
    maxDepth: 0,
    rootFnId,
    metric,
    prunedNodes: 0,
    hitNodeCeiling: false,
  };
  if (rootFnId < 0 || rootFnId >= functionCount) return empty;

  const rootValue = inclusive[rootFnId]!;
  if (!(rootValue > 0)) return empty;

  const graph = buildCallGraphIndex(profile, metric);
  const threshold = rootValue * minFraction;

  let capacity = 1024;
  let fnId = new Int32Array(capacity);
  let depth = new Int32Array(capacity);
  let start = new Float64Array(capacity);
  let value = new Float64Array(capacity);
  let selfValue = new Float64Array(capacity);
  let parent = new Int32Array(capacity);
  let callCount = new Float64Array(capacity);
  let flags = new Uint8Array(capacity);
  let count = 0;
  let prunedNodes = 0;
  let observedMaxDepth = 0;

  const ensure = (needed: number): void => {
    if (needed <= capacity) return;
    capacity = nextCapacity(capacity, needed, 1024);
    fnId = growI32(fnId, capacity);
    depth = growI32(depth, capacity);
    start = growF64(start, capacity);
    value = growF64(value, capacity);
    selfValue = growF64(selfValue, capacity);
    parent = growI32(parent, capacity);
    callCount = growF64(callCount, capacity);
    flags = growU8(flags, capacity);
  };

  // Counts how many times each function appears on the current ancestor path.
  // Recursion is a cycle in the call graph, and expanding it would never
  // terminate; stop and flag instead.
  const onPath = new Int32Array(functionCount);

  interface StackFrame {
    node: number;
    /** Index into the child list, or -1 before children have been emitted. */
    childCursor: number;
    children: number[];
  }

  const emit = (
    fn: number,
    nodeDepth: number,
    nodeStart: number,
    nodeValue: number,
    nodeParent: number,
    nodeCalls: number,
  ): number => {
    ensure(count + 1);
    const node = count++;
    fnId[node] = fn;
    depth[node] = nodeDepth;
    start[node] = nodeStart;
    value[node] = nodeValue;
    selfValue[node] = nodeValue;
    parent[node] = nodeParent;
    callCount[node] = nodeCalls;
    flags[node] = 0;
    if (nodeDepth > observedMaxDepth) observedMaxDepth = nodeDepth;
    return node;
  };

  /**
   * Emit the children of `node`, laid out left to right, largest first.
   * Returns the emitted child node indices.
   */
  const expand = (node: number): number[] => {
    const fn = fnId[node]!;
    const nodeValue = value[node]!;
    const nodeDepth = depth[node]!;
    const hasChildren = graph.offsets[fn + 1]! > graph.offsets[fn]!;

    // Once the ceiling is reached, stop doing work entirely rather than
    // walking the rest of the graph to count what was skipped. On a dense
    // profile -- thousands of functions each calling many others -- the
    // difference is seconds of frozen parse time versus none.
    if (count >= maxNodes || nodeDepth + 1 > maxDepth) {
      if (hasChildren) {
        flags[node]! |= FLAME_FLAG_PRUNED;
        prunedNodes++;
      }
      return [];
    }

    const from = graph.offsets[fn]!;
    const to = graph.offsets[fn + 1]!;
    if (from === to) return [];

    // A function reached through one call site carries only that site's share
    // of its total inclusive cost, so children scale by the same ratio.
    const totalInclusive = inclusive[fn]!;
    const scale = totalInclusive > 0 ? nodeValue / totalInclusive : 0;

    const order: number[] = [];
    for (let edge = from; edge < to; edge++) order.push(edge);
    order.sort((a, b) => graph.value[b]! - graph.value[a]!);

    const children: number[] = [];
    let offset = start[node]!;
    let attributed = 0;
    let pruned = false;
    for (const edge of order) {
      const callee = graph.callee[edge]!;
      const childValue = graph.value[edge]! * scale;
      if (childValue <= 0) continue;
      if (count >= maxNodes) {
        // Children are sorted largest first, so everything after this point is
        // smaller still. Nothing is gained by looking at the rest.
        pruned = true;
        break;
      }
      if (childValue < threshold) {
        pruned = true;
        continue;
      }
      const child = emit(callee, nodeDepth + 1, offset, childValue, node, graph.callCount[edge]!);
      if (onPath[callee]! > 0) flags[child]! |= FLAME_FLAG_RECURSIVE;
      children.push(child);
      offset += childValue;
      attributed += childValue;
    }

    if (pruned) {
      flags[node]! |= FLAME_FLAG_PRUNED;
      // Counted per node, not per skipped edge: "3 frames were not fully
      // expanded" is actionable, "88 million subtrees" is noise.
      prunedNodes++;
    }
    selfValue[node] = Math.max(0, nodeValue - attributed);
    return children;
  };

  const root = emit(rootFnId, 0, 0, rootValue, -1, profile.functions.invocations[rootFnId] || 1);
  onPath[rootFnId]! += 1;
  const stack: StackFrame[] = [{ node: root, childCursor: -1, children: [] }];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.childCursor === -1) {
      frame.children = expand(frame.node);
      frame.childCursor = 0;
    }
    if (frame.childCursor >= frame.children.length) {
      onPath[fnId[frame.node]!]! -= 1;
      stack.pop();
      continue;
    }
    const child = frame.children[frame.childCursor++]!;
    // A recursive node is drawn, but not expanded — otherwise the cycle is
    // followed forever.
    if ((flags[child]! & FLAME_FLAG_RECURSIVE) !== 0) continue;
    onPath[fnId[child]!]! += 1;
    stack.push({ node: child, childCursor: -1, children: [] });
  }

  return {
    count,
    fnId: trimI32(fnId, count),
    depth: trimI32(depth, count),
    start: trimF64(start, count),
    value: trimF64(value, count),
    selfValue: trimF64(selfValue, count),
    parent: trimI32(parent, count),
    callCount: trimF64(callCount, count),
    flags: trimU8(flags, count),
    total: rootValue,
    maxDepth: observedMaxDepth,
    rootFnId,
    metric,
    prunedNodes,
    hitNodeCeiling: count >= maxNodes,
  };
}
