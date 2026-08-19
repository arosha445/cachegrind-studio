import { growF64, growI32, nextCapacity, trimF64, trimI32 } from './growable.js';
import { createHashIndex, lookupOrInsert, type HashIndex } from './hashindex.js';
import { findEventIndex, parseCreator, resolveTimeUnit } from './units.js';
import {
  FunctionKind,
  type F64,
  type I32,
  type ParseOptions,
  type ParseWarning,
  type Profile,
  type WarningCode,
} from './types.js';

// Byte constants. Comparing bytes avoids decoding the numeric body of the file
// into strings, which is the single biggest cost in a naive implementation.
const LF = 0x0a;
const CR = 0x0d;
const TAB = 0x09;
const SPACE = 0x20;
const HASH = 0x23;
const STAR = 0x2a;
const PLUS = 0x2b;
const MINUS = 0x2d;
const ZERO = 0x30;
const NINE = 0x39;
const EQUALS = 0x3d;
const UPPER_A = 0x41;
const UPPER_F = 0x46;
const UPPER_X = 0x58;
const LOWER_A = 0x61;
const LOWER_B = 0x62;
const LOWER_C = 0x63;
const LOWER_E = 0x65;
const LOWER_F = 0x66;
const LOWER_I = 0x69;
const LOWER_L = 0x6c;
const LOWER_N = 0x6e;
const LOWER_O = 0x6f;
const LOWER_S = 0x73;
const LOWER_X = 0x78;
const LPAREN = 0x28;
const RPAREN = 0x29;

const PROGRESS_INTERVAL_BYTES = 4 << 20;
const MAX_WARNINGS = 200;
const MAX_WARNINGS_PER_CODE = 5;

const KIND_IGNORE = 0;
const KIND_COST = 1;
const KIND_FILE = 2;
const KIND_FUNCTION = 3;
const KIND_CALLEE_FILE = 4;
const KIND_CALLEE_FUNCTION = 5;
const KIND_CALLS = 6;
const KIND_HEADER = 7;

/**
 * Scan decompressed Callgrind bytes into the columnar profile.
 *
 * Never throws on malformed profile data. "Read a profile without crashing" is
 * the whole point of the project, so anything unexpected becomes a warning and
 * the scan continues with a documented fallback.
 */
export function scanCallgrind(
  bytes: Uint8Array,
  compressed: boolean,
  options: ParseOptions = {},
): Profile {
  const decoder = new TextDecoder('utf-8');
  const total = bytes.length;
  const onProgress = options.onProgress;

  // ---------------------------------------------------------------- warnings
  const warnings: ParseWarning[] = [];
  const warningCounts = new Map<WarningCode, number>();
  const warn = (code: WarningCode, message: string, line: number): void => {
    const seen = warningCounts.get(code) ?? 0;
    warningCounts.set(code, seen + 1);
    if (seen < MAX_WARNINGS_PER_CODE && warnings.length < MAX_WARNINGS) {
      warnings.push({ code, message, line });
    }
  };

  // ------------------------------------------------------------- name tables
  const fileIds = new Map<string, number>();
  const files: string[] = [];
  const functionIds = new Map<string, number>();
  const functionNames: string[] = [];

  // Name compression is per namespace: fl/fi/fe/cfl/cfi share one id space,
  // fn/cfn share another. `cfl=(2)` genuinely refers to whatever `fl=(2)`
  // defined -- verified against real Xdebug 3.5 output.
  let fileByCompressionId = new Int32Array(256).fill(-1);
  let functionByCompressionId = new Int32Array(256).fill(-1);

  // ---------------------------------------------------------- function table
  let functionCapacity = 256;
  let fnFileId = new Int32Array(functionCapacity).fill(-1);
  let fnSelfTime = new Float64Array(functionCapacity);
  let fnSelfMemory = new Float64Array(functionCapacity);

  const internFile = (name: string): number => {
    const existing = fileIds.get(name);
    if (existing !== undefined) return existing;
    const id = files.length;
    files.push(name);
    fileIds.set(name, id);
    return id;
  };

  const internFunction = (name: string): number => {
    const existing = functionIds.get(name);
    if (existing !== undefined) return existing;
    const id = functionNames.length;
    functionNames.push(name);
    functionIds.set(name, id);
    if (id >= functionCapacity) {
      const previousLength = fnFileId.length;
      functionCapacity = nextCapacity(functionCapacity, id + 1, 256);
      const grownFileId = growI32(fnFileId, functionCapacity);
      grownFileId.fill(-1, previousLength);
      fnFileId = grownFileId;
      fnSelfTime = growF64(fnSelfTime, functionCapacity);
      fnSelfMemory = growF64(fnSelfMemory, functionCapacity);
    }
    return id;
  };

  // -------------------------------------------------- aggregated cost tables
  const lineIndex = createHashIndex(4096);
  let lineTime = new Float64Array(2048);
  let lineMemory = new Float64Array(2048);

  const callIndex = createHashIndex(4096);
  let callCount = new Float64Array(2048);
  let callTime = new Float64Array(2048);
  let callMemory = new Float64Array(2048);

  // ----------------------------------------------------------- header state
  let version: string | null = null;
  let creator: string | null = null;
  let cmd: string | null = null;
  let part: number | null = null;
  let events: string[] = [];
  let positions: string[] = ['line'];
  let positionCount = 1;
  let linePositionIndex = 0;
  let timeEventIndex = 0;
  let memoryEventIndex = 1;
  let summaryTime = 0;
  let summaryMemory = 0;
  let sawSummary = false;

  // ------------------------------------------------------------- scan state
  let currentFile = -1;
  let currentFunction = -1;
  let pendingCalleeFunction = -1;
  let pendingCalleeFile = -1;
  let pendingCalls = -1;
  const lastPosition = new Int32Array(8);

  let lineNo = 0;
  let nextProgressAt = PROGRESS_INTERVAL_BYTES;
  onProgress?.({ phase: 'scan', ratio: 0 });

  let cursor = 0;
  while (cursor < total) {
    // ---- locate the line
    const start = cursor;
    let scan = cursor;
    while (scan < total && bytes[scan] !== LF) scan++;
    let end = scan;
    if (end > start && bytes[end - 1] === CR) end--;
    cursor = scan + 1;
    lineNo++;

    if (onProgress !== undefined && start >= nextProgressAt) {
      nextProgressAt = start + PROGRESS_INTERVAL_BYTES;
      onProgress({ phase: 'scan', ratio: start / total });
    }

    if (end === start) continue;

    // ---- classify
    const first = bytes[start]!;
    let kind: number;
    let valueAt = start;

    if (first === HASH) {
      kind = KIND_IGNORE;
    } else if (
      (first >= ZERO && first <= NINE) ||
      first === PLUS ||
      first === MINUS ||
      first === STAR
    ) {
      kind = KIND_COST;
    } else if (first === LOWER_F) {
      const second = bytes[start + 1];
      if (
        (second === LOWER_L || second === LOWER_I || second === LOWER_E) &&
        bytes[start + 2] === EQUALS
      ) {
        kind = KIND_FILE;
        valueAt = start + 3;
      } else if (second === LOWER_N && bytes[start + 2] === EQUALS) {
        kind = KIND_FUNCTION;
        valueAt = start + 3;
      } else {
        kind = KIND_HEADER;
      }
    } else if (first === LOWER_C) {
      const second = bytes[start + 1];
      if (second === LOWER_F && bytes[start + 3] === EQUALS) {
        const third = bytes[start + 2];
        if (third === LOWER_L || third === LOWER_I) {
          kind = KIND_CALLEE_FILE;
          valueAt = start + 4;
        } else if (third === LOWER_N) {
          kind = KIND_CALLEE_FUNCTION;
          valueAt = start + 4;
        } else {
          kind = KIND_HEADER;
        }
      } else if (
        second === LOWER_A &&
        bytes[start + 2] === LOWER_L &&
        bytes[start + 3] === LOWER_L &&
        bytes[start + 4] === LOWER_S &&
        bytes[start + 5] === EQUALS
      ) {
        kind = KIND_CALLS;
        valueAt = start + 6;
      } else if (second === LOWER_O && bytes[start + 2] === LOWER_B && bytes[start + 3] === EQUALS) {
        kind = KIND_IGNORE; // cob= -- ELF object, never emitted by Xdebug
      } else {
        // `creator:` and `cmd:` also start with `c`. Falling through to the
        // header parser rather than ignoring them is what keeps the Xdebug
        // version -- and therefore the time unit -- readable.
        kind = KIND_HEADER;
      }
    } else if (first === LOWER_O && bytes[start + 1] === LOWER_B && bytes[start + 2] === EQUALS) {
      kind = KIND_IGNORE; // ELF object -- never emitted by Xdebug
    } else {
      kind = KIND_HEADER;
    }

    if (kind === KIND_IGNORE) continue;

    if (
      kind === KIND_FILE ||
      kind === KIND_FUNCTION ||
      kind === KIND_CALLEE_FILE ||
      kind === KIND_CALLEE_FUNCTION
    ) {
      const isFileNamespace = kind === KIND_FILE || kind === KIND_CALLEE_FILE;
      let resolved = -1;

      if (bytes[valueAt] === LPAREN) {
        let idCursor = valueAt + 1;
        let compressionId = 0;
        let sawDigit = false;
        while (idCursor < end) {
          const digit = bytes[idCursor]!;
          if (digit < ZERO || digit > NINE) break;
          compressionId = compressionId * 10 + (digit - ZERO);
          sawDigit = true;
          idCursor++;
        }
        if (!sawDigit || idCursor >= end || bytes[idCursor] !== RPAREN) {
          warn('truncated', 'Unterminated name-compression id -- profile is cut short', lineNo);
          continue;
        }
        idCursor++; // past ')'
        while (idCursor < end && (bytes[idCursor] === SPACE || bytes[idCursor] === TAB)) idCursor++;

        if (idCursor < end) {
          // Definition: `fn=(3) helperWork`
          const name = decoder.decode(bytes.subarray(idCursor, end));
          resolved = isFileNamespace ? internFile(name) : internFunction(name);
          if (isFileNamespace) {
            if (compressionId >= fileByCompressionId.length) {
              const previousLength = fileByCompressionId.length;
              const grown = growI32(
                fileByCompressionId,
                nextCapacity(previousLength, compressionId + 1, 256),
              );
              grown.fill(-1, previousLength);
              fileByCompressionId = grown;
            }
            fileByCompressionId[compressionId] = resolved;
          } else {
            if (compressionId >= functionByCompressionId.length) {
              const previousLength = functionByCompressionId.length;
              const grown = growI32(
                functionByCompressionId,
                nextCapacity(previousLength, compressionId + 1, 256),
              );
              grown.fill(-1, previousLength);
              functionByCompressionId = grown;
            }
            functionByCompressionId[compressionId] = resolved;
          }
        } else {
          // Reference: `fn=(3)` -- nothing to decode at all, which is what
          // makes name compression cheap on large profiles.
          const table = isFileNamespace ? fileByCompressionId : functionByCompressionId;
          resolved = compressionId < table.length ? table[compressionId]! : -1;
          if (resolved === -1) {
            warn(
              'undefined-name-id',
              `Reference to undefined ${isFileNamespace ? 'file' : 'function'} id ${compressionId}`,
              lineNo,
            );
          }
        }
      } else if (valueAt < end) {
        const name = decoder.decode(bytes.subarray(valueAt, end));
        resolved = isFileNamespace ? internFile(name) : internFunction(name);
      }

      if (kind === KIND_FILE) {
        currentFile = resolved;
        if (currentFunction >= 0 && resolved >= 0 && fnFileId[currentFunction] === -1) {
          fnFileId[currentFunction] = resolved;
        }
      } else if (kind === KIND_FUNCTION) {
        currentFunction = resolved;
        lastPosition.fill(0);
        // A function's own `fl=` is authoritative and overrides any file a
        // caller supplied through `cfl=`.
        if (resolved >= 0 && currentFile >= 0) fnFileId[resolved] = currentFile;
      } else if (kind === KIND_CALLEE_FILE) {
        pendingCalleeFile = resolved;
      } else {
        pendingCalleeFunction = resolved;
      }
      continue;
    }

    if (kind === KIND_CALLS) {
      let callsCursor = valueAt;
      let count = 0;
      let sawDigit = false;
      while (callsCursor < end) {
        const digit = bytes[callsCursor]!;
        if (digit < ZERO || digit > NINE) break;
        count = count * 10 + (digit - ZERO);
        sawDigit = true;
        callsCursor++;
      }
      pendingCalls = sawDigit ? count : 1;
      continue;
    }

    if (kind === KIND_HEADER) {
      const text = decoder.decode(bytes.subarray(start, end));
      const colon = text.indexOf(':');
      if (colon === -1) continue;
      const key = text.slice(0, colon).trim().toLowerCase();
      const value = text.slice(colon + 1).trim();
      if (key === 'version') {
        version = value;
      } else if (key === 'creator') {
        creator = value;
      } else if (key === 'cmd') {
        cmd = value;
      } else if (key === 'part') {
        const parsed = Number.parseInt(value, 10);
        part = Number.isNaN(parsed) ? null : parsed;
      } else if (key === 'positions') {
        const parsed = value.split(/\s+/).filter((token) => token.length > 0);
        positions = parsed.length > 0 ? parsed : ['line'];
        positionCount = Math.min(positions.length, lastPosition.length);
        const found = positions.indexOf('line');
        linePositionIndex = found === -1 ? 0 : found;
      } else if (key === 'events') {
        events = value.split(/\s+/).filter((token) => token.length > 0);
        timeEventIndex = findEventIndex(events, 'time');
        memoryEventIndex = findEventIndex(events, 'memory');
      } else if (key === 'summary' || key === 'totals') {
        const numbers = value
          .split(/\s+/)
          .filter((token) => token.length > 0)
          .map((token) => Number(token));
        if (timeEventIndex >= 0) summaryTime = numbers[timeEventIndex] ?? 0;
        if (memoryEventIndex >= 0) summaryMemory = numbers[memoryEventIndex] ?? 0;
        sawSummary = true;
      }
      continue;
    }

    // ---- KIND_COST
    let costCursor = start;

    // position columns (`positions: line`, or `instr line`)
    let positionLine = 0;
    for (let column = 0; column < positionCount; column++) {
      while (costCursor < end && (bytes[costCursor] === SPACE || bytes[costCursor] === TAB)) {
        costCursor++;
      }
      if (costCursor >= end) break;
      const lead = bytes[costCursor]!;
      let value: number;
      if (lead === STAR) {
        costCursor++;
        value = lastPosition[column]!;
      } else if (lead === PLUS || lead === MINUS) {
        costCursor++;
        let delta = 0;
        while (costCursor < end) {
          const digit = bytes[costCursor]!;
          if (digit < ZERO || digit > NINE) break;
          delta = delta * 10 + (digit - ZERO);
          costCursor++;
        }
        value = lead === PLUS ? lastPosition[column]! + delta : lastPosition[column]! - delta;
      } else if (lead >= ZERO && lead <= NINE) {
        if (
          lead === ZERO &&
          (bytes[costCursor + 1] === LOWER_X || bytes[costCursor + 1] === UPPER_X)
        ) {
          // Hex instruction address. Xdebug never emits these; read the value
          // rather than silently treating it as line 0.
          costCursor += 2;
          let hex = 0;
          while (costCursor < end) {
            const digit = bytes[costCursor]!;
            let nibble: number;
            if (digit >= ZERO && digit <= NINE) nibble = digit - ZERO;
            else if (digit >= LOWER_A && digit <= LOWER_A + 5) nibble = digit - LOWER_A + 10;
            else if (digit >= UPPER_A && digit <= UPPER_F) nibble = digit - UPPER_A + 10;
            else break;
            hex = hex * 16 + nibble;
            costCursor++;
          }
          value = hex;
          warn(
            'unsupported-position-format',
            'Hex instruction positions are read but do not map to source lines',
            lineNo,
          );
        } else {
          let n = 0;
          while (costCursor < end) {
            const digit = bytes[costCursor]!;
            if (digit < ZERO || digit > NINE) break;
            n = n * 10 + (digit - ZERO);
            costCursor++;
          }
          value = n;
        }
      } else {
        break;
      }
      lastPosition[column] = value;
      if (column === linePositionIndex) positionLine = value;
    }

    // event columns
    let costTime = 0;
    let costMemory = 0;
    let column = 0;
    while (costCursor < end) {
      while (costCursor < end && (bytes[costCursor] === SPACE || bytes[costCursor] === TAB)) {
        costCursor++;
      }
      if (costCursor >= end) break;
      let negative = false;
      if (bytes[costCursor] === MINUS) {
        negative = true;
        costCursor++;
      }
      let n = 0;
      let sawDigit = false;
      while (costCursor < end) {
        const digit = bytes[costCursor]!;
        if (digit < ZERO || digit > NINE) break;
        n = n * 10 + (digit - ZERO);
        sawDigit = true;
        costCursor++;
      }
      if (!sawDigit) {
        costCursor++;
        continue;
      }
      const value = negative ? -n : n;
      if (column === timeEventIndex) costTime = value;
      else if (column === memoryEventIndex) costMemory = value;
      column++;
    }

    if (currentFunction < 0) continue;

    if (pendingCalls >= 0) {
      // The cost line after `calls=` is the *inclusive* cost of that call. It
      // belongs to the edge and must never land in the caller's self cost.
      const callee = pendingCalleeFunction;
      if (callee >= 0) {
        if (fnFileId[callee] === -1 && pendingCalleeFile >= 0) {
          // Some Xdebug versions omit `cfl=` entirely (bug #489), so the
          // callee's own record is the primary source; this is the fallback.
          fnFileId[callee] = pendingCalleeFile;
        }
        const entry = lookupOrInsert(callIndex, currentFunction, callee, positionLine);
        if (callIndex.inserted && entry >= callCount.length) {
          const capacity = nextCapacity(callCount.length, entry + 1, 2048);
          callCount = growF64(callCount, capacity);
          callTime = growF64(callTime, capacity);
          callMemory = growF64(callMemory, capacity);
        }
        callCount[entry]! += pendingCalls;
        callTime[entry]! += costTime;
        callMemory[entry]! += costMemory;
      }
      pendingCalls = -1;
      pendingCalleeFunction = -1;
      pendingCalleeFile = -1;
    } else {
      // A plain cost line is always self (exclusive) cost, and repeats for the
      // same position accumulate rather than overwrite.
      const entry = lookupOrInsert(lineIndex, currentFunction, positionLine, 0);
      if (lineIndex.inserted && entry >= lineTime.length) {
        const capacity = nextCapacity(lineTime.length, entry + 1, 2048);
        lineTime = growF64(lineTime, capacity);
        lineMemory = growF64(lineMemory, capacity);
      }
      lineTime[entry]! += costTime;
      lineMemory[entry]! += costMemory;
      fnSelfTime[currentFunction]! += costTime;
      fnSelfMemory[currentFunction]! += costMemory;
    }
  }

  if (pendingCalls >= 0 || pendingCalleeFunction >= 0) {
    warn('truncated', 'Profile ends mid-call-record; the process was probably killed', lineNo);
  }
  onProgress?.({ phase: 'aggregate', ratio: 1 });

  return finalize({
    compressed,
    byteLength: total,
    files,
    functionNames,
    fnFileId,
    fnSelfTime,
    fnSelfMemory,
    lineIndex,
    lineTime,
    lineMemory,
    callIndex,
    callCount,
    callTime,
    callMemory,
    version,
    creator,
    cmd,
    part,
    events,
    positions,
    timeEventIndex,
    memoryEventIndex,
    summaryTime,
    summaryMemory,
    sawSummary,
    warnings,
    warn,
  });
}

interface FinalizeInput {
  compressed: boolean;
  byteLength: number;
  files: string[];
  functionNames: string[];
  fnFileId: I32;
  fnSelfTime: F64;
  fnSelfMemory: F64;
  lineIndex: HashIndex;
  lineTime: F64;
  lineMemory: F64;
  callIndex: HashIndex;
  callCount: F64;
  callTime: F64;
  callMemory: F64;
  version: string | null;
  creator: string | null;
  cmd: string | null;
  part: number | null;
  events: string[];
  positions: string[];
  timeEventIndex: number;
  memoryEventIndex: number;
  summaryTime: number;
  summaryMemory: number;
  sawSummary: boolean;
  warnings: ParseWarning[];
  warn: (code: WarningCode, message: string, line: number) => void;
}

function finalize(input: FinalizeInput): Profile {
  const { files, functionNames, lineIndex, callIndex, events, warnings, warn } = input;
  const functionCount = functionNames.length;

  if (input.byteLength === 0) {
    warn('empty-input', 'The profile is empty -- zero bytes', 0);
  } else if (events.length === 0) {
    warn(
      'no-events-header',
      'No `events:` header; assuming column 0 is Time and column 1 is Memory',
      0,
    );
  }

  const { tool: creatorTool, major: creatorMajor } = parseCreator(input.creator);
  const timeEventIndex = input.timeEventIndex;
  const timeEventName = timeEventIndex >= 0 ? (events[timeEventIndex] ?? null) : null;
  const unit = resolveTimeUnit(timeEventName, creatorTool, creatorMajor);
  if (unit.source === 'assumed' && input.byteLength > 0) {
    warn(
      'unknown-time-unit',
      'Neither the events header nor the creator line states a time unit; assuming microseconds. Absolute times may be wrong by orders of magnitude.',
      0,
    );
  }
  if (timeEventIndex === -1 && events.length > 0) {
    warn('no-time-event', 'The profile has no Time event column', 0);
  }

  // ---- call edges, trimmed to their real length
  const callEntryCount = callIndex.size;
  const callerFnId = trimI32(callIndex.k0, callEntryCount);
  const calleeFnId = trimI32(callIndex.k1, callEntryCount);
  const callLine = trimI32(callIndex.k2, callEntryCount);
  const callCountColumn = trimF64(input.callCount, callEntryCount);
  const callTimeColumn = trimF64(input.callTime, callEntryCount);
  const callMemoryColumn = trimF64(input.callMemory, callEntryCount);

  // ---- per-function rollups
  const selfTime = trimF64(input.fnSelfTime, functionCount);
  const selfMemory = trimF64(input.fnSelfMemory, functionCount);
  const inclTime = selfTime.slice();
  const inclMemory = selfMemory.slice();
  const invocations = new Float64Array(functionCount);

  for (let edge = 0; edge < callEntryCount; edge++) {
    const caller = callerFnId[edge]!;
    const callee = calleeFnId[edge]!;
    // Inclusive cost is a function's own work plus everything it called.
    // Deriving it from *outgoing* edges avoids the double counting that
    // summing incoming edges produces for recursive functions.
    if (caller >= 0 && caller < functionCount) {
      inclTime[caller]! += callTimeColumn[edge]!;
      inclMemory[caller]! += callMemoryColumn[edge]!;
    }
    if (callee >= 0 && callee < functionCount) {
      invocations[callee]! += callCountColumn[edge]!;
    }
  }

  // ---- function kinds
  const kind = new Uint8Array(functionCount);
  const fileId = trimI32(input.fnFileId, functionCount);
  for (let fn = 0; fn < functionCount; fn++) {
    const fileIndex = fileId[fn]!;
    const file = fileIndex >= 0 ? (files[fileIndex] ?? '') : '';
    kind[fn] = classifyFunction(functionNames[fn]!, file);
  }

  // ---- entry point
  let entryFnId = functionNames.indexOf('{main}');
  if (entryFnId === -1) {
    let best = -1;
    let bestTime = -1;
    for (let fn = 0; fn < functionCount; fn++) {
      if (invocations[fn]! === 0 && inclTime[fn]! > bestTime) {
        bestTime = inclTime[fn]!;
        best = fn;
      }
    }
    entryFnId = best;
    if (best === -1 && functionCount > 0) {
      warn('no-entry-point', 'No `{main}` frame and no uncalled function to use as a root', 0);
    }
  }

  // ---- summary
  let computedTime = 0;
  let computedMemory = 0;
  for (let fn = 0; fn < functionCount; fn++) {
    computedTime += selfTime[fn]!;
    computedMemory += selfMemory[fn]!;
  }

  let summaryTime = input.summaryTime;
  let summaryMemory = input.summaryMemory;
  let summarySource: 'header' | 'computed' = 'header';
  if (!input.sawSummary) {
    // webgrind#125: with no `summary:` line, dividing by it renders every row
    // as 0.00%. Total self cost is the same number by construction.
    summaryTime = computedTime;
    summaryMemory = computedMemory;
    summarySource = 'computed';
    if (input.byteLength > 0) {
      warn('missing-summary', 'No `summary:` line; totals were computed from self costs', 0);
    }
  } else if (summaryTime > 0 && Math.abs(summaryTime - computedTime) > summaryTime * 0.005) {
    // Real Xdebug output runs a little above the sum of self costs -- it times
    // the whole request, including work outside any function record. Measured
    // at ~0.02% on the reference fixture, so the 0.5% band flags genuine
    // truncation without firing on every healthy profile.
    warn(
      'summary-mismatch',
      `Header summary (${summaryTime}) disagrees with the sum of self costs (${computedTime}); the profile may be truncated`,
      0,
    );
  }
  if (summaryTime === 0 && computedTime > 0) {
    summaryTime = computedTime;
    summaryMemory = computedMemory;
    summarySource = 'computed';
  }

  return {
    meta: {
      version: input.version,
      creator: input.creator,
      creatorTool,
      creatorMajor,
      cmd: input.cmd,
      part: input.part,
      events,
      positions: input.positions,
      timeEventIndex,
      memoryEventIndex: input.memoryEventIndex,
      timeUnit: unit.unit,
      timeUnitSource: unit.source,
      timeToMs: unit.toMs,
      compressed: input.compressed,
      byteLength: input.byteLength,
    },
    files,
    functionNames,
    functions: {
      count: functionCount,
      fileId,
      kind,
      selfTime,
      selfMemory,
      inclTime,
      inclMemory,
      invocations,
    },
    lines: {
      count: lineIndex.size,
      fnId: trimI32(lineIndex.k0, lineIndex.size),
      line: trimI32(lineIndex.k1, lineIndex.size),
      time: trimF64(input.lineTime, lineIndex.size),
      memory: trimF64(input.lineMemory, lineIndex.size),
    },
    calls: {
      count: callEntryCount,
      callerFnId,
      calleeFnId,
      line: callLine,
      callCount: callCountColumn,
      inclTime: callTimeColumn,
      inclMemory: callMemoryColumn,
    },
    summary: { time: summaryTime, memory: summaryMemory, source: summarySource },
    entryFnId,
    warnings,
  };
}

const INCLUDE_PREFIXES = ['require::', 'require_once::', 'include::', 'include_once::'];

function classifyFunction(name: string, file: string): FunctionKind {
  if (name === '{main}') return FunctionKind.Main;
  for (const prefix of INCLUDE_PREFIXES) {
    if (name.startsWith(prefix)) return FunctionKind.Include;
  }
  if (file === 'php:internal' || name.startsWith('php::')) return FunctionKind.Internal;
  return FunctionKind.User;
}
