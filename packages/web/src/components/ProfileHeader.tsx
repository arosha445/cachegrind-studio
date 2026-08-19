import { formatBytes, formatDuration, toMilliseconds } from '@cachegrind-studio/parser';
import type { Profile } from '@cachegrind-studio/parser';

interface Props {
  readonly name: string;
  readonly profile: Profile;
  readonly elapsedMs: number;
  readonly parseMs: number;
  readonly flameMs: number;
  readonly onClose: () => void;
}

export function ProfileHeader({
  name,
  profile,
  elapsedMs,
  parseMs,
  flameMs,
  onClose,
}: Props): React.ReactElement {
  const { meta, summary } = profile;

  return (
    <header className="border-b border-zinc-200 dark:border-zinc-800">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-3 py-2 text-xs">
        <span className="font-medium">{name}</span>
        <span className="font-mono text-zinc-500 break-all">{meta.cmd ?? 'unknown command'}</span>

        <div className="ml-auto flex flex-wrap items-baseline gap-x-4 text-zinc-500 tabular">
          <span>
            <span className="text-zinc-400">total</span>{' '}
            <span className="text-zinc-900 dark:text-zinc-100">
              {formatDuration(toMilliseconds(profile, summary.time))}
            </span>
            {summary.source === 'computed' && <span className="text-amber-500"> (computed)</span>}
          </span>
          <span>
            <span className="text-zinc-400">memory</span> {formatBytes(summary.memory)}
          </span>
          <span>
            <span className="text-zinc-400">functions</span>{' '}
            {profile.functions.count.toLocaleString()}
          </span>
          <span>
            <span className="text-zinc-400">edges</span> {profile.calls.count.toLocaleString()}
          </span>
          <span>
            <span className="text-zinc-400">parsed</span> {formatBytes(meta.byteLength)} in{' '}
            <span title={`parse ${parseMs.toFixed(0)} ms · flame graph ${flameMs.toFixed(0)} ms`}>
              {elapsedMs.toFixed(0)} ms
            </span>
            {meta.compressed && <span className="text-zinc-400"> (gzip)</span>}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-zinc-300 px-2 py-0.5 dark:border-zinc-700"
          >
            Close
          </button>
        </div>
      </div>

      {/*
        CLAUDE.md: the profiler distorts what it measures, and the caveat must
        stay visible rather than being removed to make a view look cleaner.
      */}
      <p className="border-t border-zinc-200 bg-amber-500/5 px-3 py-1.5 text-[11px] text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
        Xdebug&rsquo;s profiler overhead is significant and uneven across function types. Trust
        relative self cost and call counts; do not quote these absolute times as real-world
        performance.
        {meta.creator !== null && <span className="ml-2 text-zinc-500">{meta.creator}</span>}
        <span className="ml-2 text-zinc-500">
          Time unit: {meta.timeUnit}
          {meta.timeUnitSource === 'assumed' && ' (assumed)'}
        </span>
      </p>

      {profile.warnings.length > 0 && (
        <ul className="border-t border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[11px]">
          {profile.warnings.slice(0, 5).map((warning, index) => (
            <li key={`${warning.code}-${index}`}>
              <span className="font-mono text-amber-700 dark:text-amber-400">{warning.code}</span>{' '}
              {warning.message}
              {warning.line > 0 && <span className="text-zinc-500"> (line {warning.line})</span>}
            </li>
          ))}
        </ul>
      )}
    </header>
  );
}
