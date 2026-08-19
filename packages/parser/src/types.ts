/**
 * The public shape of a parsed profile.
 *
 * Everything numeric lives in typed arrays so the whole thing can cross a
 * Worker boundary with `postMessage(profile, collectTransferables(profile))`
 * without copying. Strings are the one exception: name tables are plain
 * `string[]` and are structured-cloned.
 *
 * Columns are pinned to a non-shared `ArrayBuffer` rather than the default
 * `ArrayBufferLike`. That is what `postMessage` transfer lists require, so
 * stating it in the type stops a `SharedArrayBuffer` sneaking in and silently
 * turning a zero-copy handoff into a structured clone.
 *
 * Cost values are kept in the file's *raw* units. Conversion to milliseconds
 * happens at display time via `meta.timeToMs`. Keeping raw values means
 * summing, diffing and re-aggregating never accumulate rounding error.
 */

export type I32 = Int32Array<ArrayBuffer>;
export type F64 = Float64Array<ArrayBuffer>;
export type U8 = Uint8Array<ArrayBuffer>;

/** Unit of a single raw `Time` cost value. */
export type TimeUnit = 'ns' | '10ns' | 'us' | 'ms' | 'unknown';

/** How the time unit was determined. Surfaced in the UI when it is a guess. */
export type TimeUnitSource = 'event-name' | 'creator-version' | 'assumed';

export const FunctionKind = {
  /** Ordinary userland function, method or closure. */
  User: 0,
  /** PHP built-in: `fl=php:internal`, `fn=php::name`. */
  Internal: 1,
  /** `require::`, `include_once::` and friends — pseudo-functions per include. */
  Include: 2,
  /** The `{main}` pseudo-frame: the script itself. */
  Main: 3,
} as const;
export type FunctionKind = (typeof FunctionKind)[keyof typeof FunctionKind];

export type WarningCode =
  | 'empty-input'
  | 'no-events-header'
  | 'no-time-event'
  | 'unknown-time-unit'
  | 'missing-summary'
  | 'summary-mismatch'
  | 'truncated'
  | 'undefined-name-id'
  | 'no-entry-point'
  | 'unsupported-position-format';

/**
 * A recoverable problem. The parser never throws on malformed profile data —
 * "read a profile without crashing" is the whole point — so anything odd is
 * reported here and the parse continues with a documented fallback.
 */
export interface ParseWarning {
  readonly code: WarningCode;
  readonly message: string;
  /** 1-based line number in the decompressed file, when known. */
  readonly line: number;
}

export interface ProfileMeta {
  readonly version: string | null;
  /** The raw `creator:` line, e.g. `xdebug 3.5.1 (PHP 8.3.29)`. */
  readonly creator: string | null;
  /** Lowercased tool name parsed out of `creator:`, e.g. `xdebug`. */
  readonly creatorTool: string | null;
  readonly creatorMajor: number | null;
  /** The `cmd:` line — the profiled script or request. */
  readonly cmd: string | null;
  readonly part: number | null;
  /** Event names exactly as written, e.g. `['Time_(10ns)', 'Memory_(bytes)']`. */
  readonly events: readonly string[];
  readonly positions: readonly string[];
  /** Index into a cost line's values, or -1 when the profile has no time column. */
  readonly timeEventIndex: number;
  readonly memoryEventIndex: number;
  readonly timeUnit: TimeUnit;
  readonly timeUnitSource: TimeUnitSource;
  /** Multiply a raw time cost by this to get milliseconds. */
  readonly timeToMs: number;
  /** True when the input bytes were gzipped. */
  readonly compressed: boolean;
  /** Size of the decompressed profile in bytes. */
  readonly byteLength: number;
}

/** Per-function totals. Indexed by function id; parallel to `Profile.functionNames`. */
export interface FunctionTable {
  readonly count: number;
  /** Index into `Profile.files`, or -1 if the function was never given a file. */
  readonly fileId: I32;
  /** One of `FunctionKind`. */
  readonly kind: U8;
  readonly selfTime: F64;
  readonly selfMemory: F64;
  readonly inclTime: F64;
  readonly inclMemory: F64;
  /** How many times the function was entered (sum of incoming call counts). */
  readonly invocations: F64;
}

/**
 * Self cost per (function, line). This is what the source-annotation gutter
 * reads. Aggregated during parsing — repeated cost lines for one position are
 * summed, never overwritten.
 */
export interface LineTable {
  readonly count: number;
  readonly fnId: I32;
  readonly line: I32;
  readonly time: F64;
  readonly memory: F64;
}

/**
 * Call edges, aggregated per (caller, callee, call-site line). Costs here are
 * *inclusive* — the cost line following `calls=` is the total cost of the
 * callee's execution, not the caller's own work.
 */
export interface CallTable {
  readonly count: number;
  readonly callerFnId: I32;
  readonly calleeFnId: I32;
  /** Line in the *caller* where the call happens. */
  readonly line: I32;
  readonly callCount: F64;
  readonly inclTime: F64;
  readonly inclMemory: F64;
}

export interface ProfileSummary {
  readonly time: number;
  readonly memory: number;
  /** `header` when a `summary:` line was present, `computed` when derived. */
  readonly source: 'header' | 'computed';
}

export interface Profile {
  readonly meta: ProfileMeta;
  /** fileId -> path, as written in the profile (Windows paths stay Windows paths). */
  readonly files: string[];
  /** fnId -> function name. */
  readonly functionNames: string[];
  readonly functions: FunctionTable;
  readonly lines: LineTable;
  readonly calls: CallTable;
  readonly summary: ProfileSummary;
  /** `{main}` if present, else the best-guess root, else -1. */
  readonly entryFnId: number;
  readonly warnings: readonly ParseWarning[];
}

export interface ParseProgress {
  readonly phase: 'decompress' | 'scan' | 'aggregate';
  /** 0..1. Approximate during `scan`; exact at phase boundaries. */
  readonly ratio: number;
}

export interface ParseOptions {
  /**
   * Called periodically during parsing. Keep it cheap — it runs on the parse
   * thread. The parser throttles calls to roughly one per 4 MB scanned.
   */
  readonly onProgress?: (progress: ParseProgress) => void;
}
