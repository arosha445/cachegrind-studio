import type { Profile } from './types.js';

/**
 * Read-side helpers over the columnar tables. Everything here is a scan or a
 * small allocation on demand — no index is built eagerly, because the views
 * that need them (source annotation, caller/callee) are opened one function at
 * a time.
 */

export interface LineCost {
  readonly line: number;
  readonly time: number;
  readonly memory: number;
}

export interface CallEdge {
  readonly callerFnId: number;
  readonly calleeFnId: number;
  readonly line: number;
  readonly callCount: number;
  readonly inclTime: number;
  readonly inclMemory: number;
}

/** Self cost per line for one function, ascending by line. */
export function selfLinesForFunction(profile: Profile, fnId: number): LineCost[] {
  const { lines } = profile;
  const out: LineCost[] = [];
  for (let i = 0; i < lines.count; i++) {
    if (lines.fnId[i] !== fnId) continue;
    out.push({ line: lines.line[i]!, time: lines.time[i]!, memory: lines.memory[i]! });
  }
  out.sort((a, b) => a.line - b.line);
  return out;
}

/**
 * Self cost per line across every function defined in one file — what the
 * source-annotation gutter renders. Costs from different functions on the same
 * line (a closure inside a function body) are summed.
 */
export function selfLinesForFile(profile: Profile, fileId: number): Map<number, LineCost> {
  const { lines, functions } = profile;
  const byLine = new Map<number, { line: number; time: number; memory: number }>();
  for (let i = 0; i < lines.count; i++) {
    const fn = lines.fnId[i]!;
    if (functions.fileId[fn] !== fileId) continue;
    const line = lines.line[i]!;
    const existing = byLine.get(line);
    if (existing === undefined) {
      byLine.set(line, { line, time: lines.time[i]!, memory: lines.memory[i]! });
    } else {
      existing.time += lines.time[i]!;
      existing.memory += lines.memory[i]!;
    }
  }
  return byLine;
}

export interface CallSiteCost {
  readonly line: number;
  readonly inclTime: number;
  readonly inclMemory: number;
  readonly callCount: number;
}

/**
 * Inclusive cost of the calls made *from* each line of one file.
 *
 * Xdebug charges a function's self cost to its declaration line, so a gutter
 * showing self cost alone puts every number on a `function foo()` line and
 * nothing on the line that actually calls the slow thing. The call table has
 * the caller's line, so the interesting number is recoverable — this is what
 * makes the annotated source worth reading.
 */
export function callSiteCostsForFile(profile: Profile, fileId: number): Map<number, CallSiteCost> {
  const { calls, functions } = profile;
  const byLine = new Map<number, { line: number; inclTime: number; inclMemory: number; callCount: number }>();
  for (let i = 0; i < calls.count; i++) {
    const caller = calls.callerFnId[i]!;
    if (caller < 0 || functions.fileId[caller] !== fileId) continue;
    const line = calls.line[i]!;
    const existing = byLine.get(line);
    if (existing === undefined) {
      byLine.set(line, {
        line,
        inclTime: calls.inclTime[i]!,
        inclMemory: calls.inclMemory[i]!,
        callCount: calls.callCount[i]!,
      });
    } else {
      existing.inclTime += calls.inclTime[i]!;
      existing.inclMemory += calls.inclMemory[i]!;
      existing.callCount += calls.callCount[i]!;
    }
  }
  return byLine;
}

/** Edges into `fnId`, i.e. who called it. */
export function callersOf(profile: Profile, fnId: number): CallEdge[] {
  return collectEdges(profile, fnId, true);
}

/** Edges out of `fnId`, i.e. what it called. */
export function calleesOf(profile: Profile, fnId: number): CallEdge[] {
  return collectEdges(profile, fnId, false);
}

function collectEdges(profile: Profile, fnId: number, incoming: boolean): CallEdge[] {
  const { calls } = profile;
  const match = incoming ? calls.calleeFnId : calls.callerFnId;
  const out: CallEdge[] = [];
  for (let i = 0; i < calls.count; i++) {
    if (match[i] !== fnId) continue;
    out.push({
      callerFnId: calls.callerFnId[i]!,
      calleeFnId: calls.calleeFnId[i]!,
      line: calls.line[i]!,
      callCount: calls.callCount[i]!,
      inclTime: calls.inclTime[i]!,
      inclMemory: calls.inclMemory[i]!,
    });
  }
  out.sort((a, b) => b.inclTime - a.inclTime);
  return out;
}

/**
 * Every buffer in a parsed profile, for
 * `postMessage(profile, collectTransferables(profile))`.
 *
 * The typed arrays move to the receiving thread instead of being copied, which
 * is what keeps handing a large profile to the UI thread free. The profile is
 * unusable on the sending side afterwards — that is the point.
 */
export function collectTransferables(profile: Profile): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  const add = (view: { buffer: ArrayBufferLike }): void => {
    if (view.buffer instanceof ArrayBuffer) buffers.add(view.buffer);
  };

  const { functions, lines, calls } = profile;
  add(functions.fileId);
  add(functions.kind);
  add(functions.selfTime);
  add(functions.selfMemory);
  add(functions.inclTime);
  add(functions.inclMemory);
  add(functions.invocations);
  add(lines.fnId);
  add(lines.line);
  add(lines.time);
  add(lines.memory);
  add(calls.callerFnId);
  add(calls.calleeFnId);
  add(calls.line);
  add(calls.callCount);
  add(calls.inclTime);
  add(calls.inclMemory);

  return [...buffers];
}
