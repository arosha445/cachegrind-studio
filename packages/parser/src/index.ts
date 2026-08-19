/**
 * @cachegrind-studio/parser
 *
 * Framework-free Callgrind/cachegrind parsing. Shared by the browser Worker,
 * the MCP server, and anything else that needs to read a profile. It must never
 * import from the web package, and must never touch `document` or `window`.
 */

export { parseProfile } from './parse.js';
export { scanCallgrind } from './scan.js';
export { gunzipIfNeeded, isGzip, DecompressionUnavailableError } from './gzip.js';
export { resolveTimeUnit, parseCreator, findEventIndex } from './units.js';
export type { ResolvedTimeUnit } from './units.js';

export {
  buildFlameGraph,
  buildCallGraphIndex,
  FLAME_FLAG_PRUNED,
  FLAME_FLAG_RECURSIVE,
} from './tree.js';
export type { FlameGraph, FlameGraphOptions, FlameMetric } from './tree.js';

export {
  callersOf,
  calleesOf,
  callSiteCostsForFile,
  collectTransferables,
  selfLinesForFile,
  selfLinesForFunction,
} from './queries.js';
export type { CallEdge, CallSiteCost, LineCost } from './queries.js';

export {
  formatBytes,
  formatDuration,
  formatPercent,
  shortenFunctionName,
  shortenPath,
  toMilliseconds,
} from './format.js';

export { FunctionKind } from './types.js';
export type {
  CallTable,
  FunctionTable,
  LineTable,
  ParseOptions,
  ParseProgress,
  ParseWarning,
  Profile,
  ProfileMeta,
  ProfileSummary,
  TimeUnit,
  TimeUnitSource,
  WarningCode,
} from './types.js';
