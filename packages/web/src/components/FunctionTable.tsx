import { useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  FunctionKind,
  formatBytes,
  formatDuration,
  formatPercent,
  shortenPath,
  toMilliseconds,
} from '@cachegrind-studio/parser';
import type { Profile } from '@cachegrind-studio/parser';

type SortKey = 'selfTime' | 'inclTime' | 'invocations' | 'selfMemory' | 'name';

interface Props {
  readonly profile: Profile;
  readonly filter: string;
  readonly selectedFnId: number;
  readonly onSelectFunction: (fnId: number) => void;
}

const ROW_HEIGHT = 28;

const KIND_LABEL: Record<number, string> = {
  [FunctionKind.User]: 'user',
  [FunctionKind.Internal]: 'php',
  [FunctionKind.Include]: 'include',
  [FunctionKind.Main]: 'main',
};

const KIND_CLASS: Record<number, string> = {
  [FunctionKind.User]: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  [FunctionKind.Internal]: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
  [FunctionKind.Include]: 'bg-violet-500/15 text-violet-700 dark:text-violet-400',
  [FunctionKind.Main]: 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-400',
};

/**
 * Invariant 1 again: the row list is virtualized, so a profile with 200,000
 * distinct functions creates ~40 DOM nodes rather than 200,000.
 */
export function FunctionTable({
  profile,
  filter,
  selectedFnId,
  onSelectFunction,
}: Props): React.ReactElement {
  const [sortKey, setSortKey] = useState<SortKey>('selfTime');
  const [ascending, setAscending] = useState(false);
  const parentRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => {
    const { functions, functionNames } = profile;
    const needle = filter.trim().toLowerCase();

    const order: number[] = [];
    for (let fn = 0; fn < functions.count; fn++) {
      if (needle !== '' && !functionNames[fn]!.toLowerCase().includes(needle)) continue;
      order.push(fn);
    }

    const direction = ascending ? 1 : -1;
    order.sort((a, b) => {
      if (sortKey === 'name') {
        return direction * functionNames[a]!.localeCompare(functionNames[b]!);
      }
      const column = functions[sortKey];
      return direction * (column[a]! - column[b]!);
    });
    return order;
  }, [profile, filter, sortKey, ascending]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const total = profile.summary.time || 1;
  const sortBy = (key: SortKey): void => {
    if (key === sortKey) setAscending((value) => !value);
    else {
      setSortKey(key);
      setAscending(key === 'name');
    }
  };

  const header = (key: SortKey, label: string, className: string): React.ReactElement => (
    <button
      type="button"
      onClick={() => sortBy(key)}
      className={`${className} flex items-center gap-1 py-2 font-medium hover:text-zinc-900 dark:hover:text-zinc-100`}
    >
      {label}
      <span className="text-[9px] opacity-70">
        {sortKey === key ? (ascending ? '▲' : '▼') : ''}
      </span>
    </button>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-zinc-200 px-3 text-xs text-zinc-500 dark:border-zinc-800">
        {header('name', 'Function', 'flex-1 justify-start text-left')}
        {header('selfTime', 'Self', 'w-28 justify-end')}
        {header('inclTime', 'Inclusive', 'w-28 justify-end')}
        {header('invocations', 'Calls', 'w-24 justify-end')}
        {header('selfMemory', 'Memory', 'w-24 justify-end')}
      </div>

      <div ref={parentRef} className="flex-1 overflow-auto">
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((item) => {
            const fn = rows[item.index]!;
            const selfTime = profile.functions.selfTime[fn]!;
            const fileId = profile.functions.fileId[fn]!;
            const kind = profile.functions.kind[fn]!;
            const selected = fn === selectedFnId;

            return (
              <div
                key={item.key}
                onClick={() => onSelectFunction(fn)}
                className={`absolute inset-x-0 flex cursor-pointer items-center gap-2 border-b border-zinc-100 px-3 text-xs dark:border-zinc-900 ${
                  selected
                    ? 'bg-amber-500/15'
                    : 'hover:bg-zinc-100 dark:hover:bg-zinc-900'
                }`}
                style={{ height: item.size, transform: `translateY(${item.start}px)` }}
              >
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <span
                    className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${KIND_CLASS[kind] ?? ''}`}
                  >
                    {KIND_LABEL[kind] ?? 'user'}
                  </span>
                  <span className="truncate font-mono" title={profile.functionNames[fn]}>
                    {profile.functionNames[fn]}
                  </span>
                  {/* Allowed to shrink: a deep Windows path must never push
                      the numeric columns off the row. */}
                  <span className="hidden min-w-0 flex-1 truncate text-zinc-500 lg:block">
                    {fileId >= 0 ? shortenPath(profile.files[fileId]!) : ''}
                  </span>
                </div>

                <div className="w-28 shrink-0 text-right tabular">
                  <span>{formatDuration(toMilliseconds(profile, selfTime))}</span>
                  <span className="ml-1 text-zinc-500">{formatPercent(selfTime / total)}</span>
                </div>
                <div className="w-28 shrink-0 text-right tabular">
                  {formatDuration(toMilliseconds(profile, profile.functions.inclTime[fn]!))}
                </div>
                <div className="w-24 shrink-0 text-right tabular">
                  {profile.functions.invocations[fn]!.toLocaleString()}
                </div>
                <div className="w-24 shrink-0 text-right tabular text-zinc-500">
                  {formatBytes(profile.functions.selfMemory[fn]!)}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="border-t border-zinc-200 px-3 py-1.5 text-xs text-zinc-500 dark:border-zinc-800">
        {rows.length.toLocaleString()} of {profile.functions.count.toLocaleString()} functions
      </div>
    </div>
  );
}
