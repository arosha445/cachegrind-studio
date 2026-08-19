import type { TimeUnit, TimeUnitSource } from './types.js';

export interface ResolvedTimeUnit {
  readonly unit: TimeUnit;
  readonly source: TimeUnitSource;
  /** Multiply a raw time cost by this to get milliseconds. */
  readonly toMs: number;
}

const MS_PER_UNIT: Record<Exclude<TimeUnit, 'unknown'>, number> = {
  ns: 1e-6,
  '10ns': 1e-5,
  us: 1e-3,
  ms: 1,
};

/**
 * Xdebug 2 and Xdebug 3 report `Time` in different units, and treating one as
 * the other inflates every number in the UI by ~100x. This is webgrind#132:
 * a 16-second request rendered as 1,095,246 ms.
 *
 * Resolution order, most to least trustworthy:
 *
 *  1. The event name itself. Xdebug 3.1+ writes `events: Time_(10ns)
 *     Memory_(bytes)` — the unit is stated, so no version guessing is needed.
 *  2. The `creator:` version. Xdebug 2.x emitted microseconds; Xdebug 3.x
 *     emitted hundredths of a microsecond even before it started labelling them.
 *  3. Neither available: assume microseconds, the historical default, and mark
 *     the result `assumed` so the UI can say so rather than quietly lying.
 */
export function resolveTimeUnit(
  eventName: string | null,
  creatorTool: string | null,
  creatorMajor: number | null,
): ResolvedTimeUnit {
  const fromName = eventName === null ? null : unitFromEventName(eventName);
  if (fromName !== null) {
    return { unit: fromName, source: 'event-name', toMs: MS_PER_UNIT[fromName] };
  }

  if (creatorTool === 'xdebug' && creatorMajor !== null) {
    const unit: Exclude<TimeUnit, 'unknown'> = creatorMajor >= 3 ? '10ns' : 'us';
    return { unit, source: 'creator-version', toMs: MS_PER_UNIT[unit] };
  }

  return { unit: 'unknown', source: 'assumed', toMs: MS_PER_UNIT.us };
}

/**
 * `Time_(10ns)` -> `10ns`. Returns null when the event name carries no unit,
 * which is the case for a bare `Time`.
 */
function unitFromEventName(eventName: string): Exclude<TimeUnit, 'unknown'> | null {
  const open = eventName.indexOf('(');
  if (open === -1 || !eventName.endsWith(')')) return null;
  const raw = eventName.slice(open + 1, -1).trim().toLowerCase();
  switch (raw) {
    case 'ns':
    case 'nanoseconds':
      return 'ns';
    case '10ns':
      return '10ns';
    case 'us':
    case 'µs':
    case 'μs':
    case 'microseconds':
      return 'us';
    case 'ms':
    case 'milliseconds':
      return 'ms';
    default:
      return null;
  }
}

/** `xdebug 3.5.1 (PHP 8.3.29)` -> `{ tool: 'xdebug', major: 3 }`. */
export function parseCreator(creator: string | null): {
  tool: string | null;
  major: number | null;
} {
  if (creator === null) return { tool: null, major: null };
  const match = /^\s*([A-Za-z][\w-]*)\s+v?(\d+)/.exec(creator);
  if (match === null) {
    const bare = /^\s*([A-Za-z][\w-]*)/.exec(creator);
    return { tool: bare?.[1]?.toLowerCase() ?? null, major: null };
  }
  return { tool: match[1]!.toLowerCase(), major: Number(match[2]) };
}

/**
 * Index of the event column holding wall time. Xdebug always writes it first,
 * but the header is authoritative and other producers order differently.
 */
export function findEventIndex(events: readonly string[], prefix: string): number {
  const wanted = prefix.toLowerCase();
  for (let i = 0; i < events.length; i++) {
    const name = events[i]!.toLowerCase();
    if (name === wanted || name.startsWith(`${wanted}_`) || name.startsWith(`${wanted}(`)) {
      return i;
    }
  }
  return -1;
}
