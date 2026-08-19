import { useCallback, useMemo, useRef, useState } from 'react';
import {
  callSiteCostsForFile,
  callersOf,
  calleesOf,
  formatDuration,
  formatPercent,
  selfLinesForFile,
  shortenFunctionName,
  toMilliseconds,
} from '@cachegrind-studio/parser';
import type { Profile } from '@cachegrind-studio/parser';

interface Props {
  readonly profile: Profile;
  readonly selectedFnId: number;
  readonly onSelectFunction: (fnId: number) => void;
}

/** Basename, for either separator style. */
function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

/**
 * Per-line cost, with the source text alongside when the user has attached it.
 *
 * Two numbers per line, because one is misleading on its own. Xdebug charges a
 * function's *self* cost to its declaration line, so a self-only gutter puts
 * every figure on a `function foo()` line. The second column is the inclusive
 * cost of the calls made from that line, which is what actually points at the
 * slow statement.
 *
 * A cachegrind file records line numbers, not code. The static build has no
 * server to fetch source from — that arrives with the PHP drop-in in v0.15 —
 * so the gutter always renders from the profile, and attaching a file simply
 * fills in the text beside it.
 */
export function SourceView({ profile, selectedFnId, onSelectFunction }: Props): React.ReactElement {
  const [sources, setSources] = useState<ReadonlyMap<string, string>>(new Map());
  const inputRef = useRef<HTMLInputElement>(null);

  const fileId = selectedFnId >= 0 ? profile.functions.fileId[selectedFnId]! : -1;
  const filePath = fileId >= 0 ? profile.files[fileId]! : null;

  const selfCosts = useMemo(
    () => (fileId >= 0 ? selfLinesForFile(profile, fileId) : new Map()),
    [profile, fileId],
  );
  const callCosts = useMemo(
    () => (fileId >= 0 ? callSiteCostsForFile(profile, fileId) : new Map()),
    [profile, fileId],
  );

  const sourceText = filePath === null ? undefined : sources.get(basename(filePath).toLowerCase());
  const sourceLines = useMemo(
    () => (sourceText === undefined ? null : sourceText.split(/\r?\n/)),
    [sourceText],
  );

  const attach = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    event.target.value = '';
    void Promise.all(
      files.map(async (file) => [file.name.toLowerCase(), await file.text()] as const),
    )
      .then((entries) => {
        setSources((previous) => new Map([...previous, ...entries]));
      })
      .catch(() => {
        /* A file the browser cannot read is not worth interrupting the view for. */
      });
  }, []);

  const callers = useMemo(
    () => (selectedFnId >= 0 ? callersOf(profile, selectedFnId).slice(0, 12) : []),
    [profile, selectedFnId],
  );
  const callees = useMemo(
    () => (selectedFnId >= 0 ? calleesOf(profile, selectedFnId).slice(0, 12) : []),
    [profile, selectedFnId],
  );

  if (selectedFnId < 0) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-zinc-500">
        Select a function in the flame graph or the function list.
      </div>
    );
  }

  const total = profile.summary.time || 1;
  const scale = Math.max(
    1,
    ...[...selfCosts.values()].map((cost) => cost.time),
    ...[...callCosts.values()].map((cost) => cost.inclTime),
  );

  const rows: number[] =
    sourceLines !== null
      ? sourceLines.map((_, index) => index + 1)
      : [...new Set([...selfCosts.keys(), ...callCosts.keys()])].sort((a, b) => a - b);

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-3 border-b border-zinc-200 px-3 py-2 text-xs dark:border-zinc-800">
          <span className="font-mono break-all">{profile.functionNames[selectedFnId]}</span>
          <span className="text-zinc-500 break-all">{filePath ?? 'unknown file'}</span>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="ml-auto shrink-0 rounded-md border border-zinc-300 px-3 py-1 dark:border-zinc-700"
          >
            {sourceLines === null ? 'Attach source file…' : 'Attach more…'}
          </button>
          <input ref={inputRef} type="file" multiple className="hidden" onChange={attach} />
        </div>

        <div className="flex gap-2 border-b border-zinc-200 px-3 py-1 text-[11px] text-zinc-500 dark:border-zinc-800">
          <span className="w-12 shrink-0 text-right">line</span>
          <span className="w-24 shrink-0 text-right">self</span>
          <span className="w-28 shrink-0 text-right">calls from here</span>
          <span className="w-16 shrink-0" />
          <span>
            {sourceLines === null ? (
              <>
                Attach{' '}
                <code className="font-mono">
                  {filePath === null ? 'the file' : basename(filePath)}
                </code>{' '}
                to see the code — read in your browser, not uploaded.
              </>
            ) : (
              'source'
            )}
          </span>
        </div>

        <div className="flex-1 overflow-auto font-mono text-xs">
          {rows.length === 0 && (
            <p className="p-4 text-zinc-500">No line costs recorded for this file.</p>
          )}
          {rows.map((line) => {
            const self = selfCosts.get(line);
            const call = callCosts.get(line);
            const selfTime = self?.time ?? 0;
            const callTime = call?.inclTime ?? 0;
            const heat = Math.max(selfTime, callTime) / scale;

            return (
              <div
                key={line}
                className="flex items-start gap-2 px-3 leading-5 hover:bg-zinc-100 dark:hover:bg-zinc-900"
              >
                <span className="w-12 shrink-0 text-right text-zinc-400 tabular">{line}</span>
                <span className="w-24 shrink-0 text-right tabular">
                  {selfTime > 0 ? formatDuration(toMilliseconds(profile, selfTime)) : ''}
                </span>
                <span className="w-28 shrink-0 text-right tabular text-zinc-500">
                  {callTime > 0 ? (
                    <>
                      {formatDuration(toMilliseconds(profile, callTime))}
                      <span className="ml-1 text-zinc-600">
                        {call!.callCount.toLocaleString()}×
                      </span>
                    </>
                  ) : (
                    ''
                  )}
                </span>
                {/* Needs an explicit height: the row is `items-start`, so an
                    empty span would collapse and the bar inside it vanish. */}
                <span className="relative h-5 w-16 shrink-0" title={formatPercent(heat)}>
                  <span
                    className="absolute inset-y-1 left-0 rounded-sm bg-amber-500/60"
                    style={{ width: `${Math.round(heat * 100)}%` }}
                  />
                </span>
                <span className="whitespace-pre break-all">
                  {sourceLines === null
                    ? `${formatPercent((selfTime + callTime) / total)} of total`
                    : (sourceLines[line - 1] ?? '')}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <aside className="hidden w-80 shrink-0 flex-col overflow-auto border-l border-zinc-200 text-xs xl:flex dark:border-zinc-800">
        <EdgeList
          title="Called by"
          empty="Nothing calls this — it is an entry point."
          entries={callers.map((edge) => ({
            fnId: edge.callerFnId,
            label: shortenFunctionName(profile.functionNames[edge.callerFnId]!),
            detail: `${formatDuration(toMilliseconds(profile, edge.inclTime))} · ${edge.callCount.toLocaleString()}×`,
          }))}
          onSelect={onSelectFunction}
        />
        <EdgeList
          title="Calls"
          empty="This function calls nothing else."
          entries={callees.map((edge) => ({
            fnId: edge.calleeFnId,
            label: shortenFunctionName(profile.functionNames[edge.calleeFnId]!),
            detail: `${formatDuration(toMilliseconds(profile, edge.inclTime))} · ${edge.callCount.toLocaleString()}×`,
          }))}
          onSelect={onSelectFunction}
        />
      </aside>
    </div>
  );
}

function EdgeList({
  title,
  empty,
  entries,
  onSelect,
}: {
  title: string;
  empty: string;
  entries: readonly { fnId: number; label: string; detail: string }[];
  onSelect: (fnId: number) => void;
}): React.ReactElement {
  return (
    <section className="border-b border-zinc-200 dark:border-zinc-800">
      <h3 className="px-3 py-2 font-medium text-zinc-500">{title}</h3>
      {entries.length === 0 && <p className="px-3 pb-3 text-zinc-500">{empty}</p>}
      {entries.map((entry) => (
        <button
          key={`${title}-${entry.fnId}`}
          type="button"
          onClick={() => onSelect(entry.fnId)}
          className="flex w-full items-baseline justify-between gap-2 px-3 py-1 text-left hover:bg-zinc-100 dark:hover:bg-zinc-900"
        >
          <span className="truncate font-mono">{entry.label}</span>
          <span className="shrink-0 text-zinc-500 tabular">{entry.detail}</span>
        </button>
      ))}
    </section>
  );
}
