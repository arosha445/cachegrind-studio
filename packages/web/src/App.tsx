import { useCallback, useState } from 'react';
import { DropZone, useFileDrop } from './components/DropZone.js';
import { FlameGraphView } from './components/FlameGraphView.js';
import { FunctionTable } from './components/FunctionTable.js';
import { ProfileHeader } from './components/ProfileHeader.js';
import { SourceView } from './components/SourceView.js';
import { useProfileLoader } from './worker/useProfileLoader.js';

type Tab = 'flame' | 'functions' | 'source';

const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'flame', label: 'Flame graph' },
  { id: 'functions', label: 'Functions' },
  { id: 'source', label: 'Source' },
];

export function App(): React.ReactElement {
  const { state, load, reset } = useProfileLoader();
  const [tab, setTab] = useState<Tab>('flame');
  const [filter, setFilter] = useState('');
  const [selectedFnId, setSelectedFnId] = useState(-1);

  const onFile = useCallback(
    (file: File) => {
      setSelectedFnId(-1);
      setFilter('');
      setTab('flame');
      load(file);
    },
    [load],
  );

  const { dragging } = useFileDrop(onFile);

  if (state.status === 'idle') {
    return <DropZone onFile={onFile} dragging={dragging} />;
  }

  if (state.status === 'loading') {
    const ratio = state.progress?.ratio ?? 0;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-sm">
        <p className="font-mono">{state.name}</p>
        <div className="h-1.5 w-64 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
          <div
            className="h-full bg-amber-500 transition-[width] duration-100"
            style={{ width: `${Math.round(Math.max(0.03, ratio) * 100)}%` }}
          />
        </div>
        <p className="text-zinc-500">
          {state.progress?.phase === 'decompress' ? 'Decompressing' : 'Parsing'} in a Web Worker…
        </p>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-sm">
        <p className="font-medium">Could not read {state.name || 'that file'}</p>
        <p className="max-w-lg text-center text-zinc-500">{state.message}</p>
        <button
          type="button"
          onClick={reset}
          className="rounded-md border border-zinc-300 px-3 py-1 dark:border-zinc-700"
        >
          Try another file
        </button>
      </div>
    );
  }

  const { profile, flame, name, elapsedMs, parseMs, flameMs } = state.loaded;

  return (
    <div className="flex h-full flex-col">
      <ProfileHeader
        name={name}
        profile={profile}
        elapsedMs={elapsedMs}
        parseMs={parseMs}
        flameMs={flameMs}
        onClose={reset}
      />

      <nav className="flex items-center gap-1 border-b border-zinc-200 px-3 dark:border-zinc-800">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setTab(entry.id)}
            className={`border-b-2 px-3 py-2 text-xs ${
              tab === entry.id
                ? 'border-amber-500 font-medium'
                : 'border-transparent text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'
            }`}
          >
            {entry.label}
          </button>
        ))}

        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter functions…"
          className="ml-auto my-1 w-64 rounded-md border border-zinc-300 bg-transparent px-2 py-1 text-xs outline-none focus:border-amber-500 dark:border-zinc-700"
        />
      </nav>

      <main className="min-h-0 flex-1">
        {tab === 'flame' && (
          <FlameGraphView
            profile={profile}
            flame={flame}
            filter={filter}
            onSelectFunction={setSelectedFnId}
          />
        )}
        {tab === 'functions' && (
          <FunctionTable
            profile={profile}
            filter={filter}
            selectedFnId={selectedFnId}
            onSelectFunction={setSelectedFnId}
          />
        )}
        {tab === 'source' && (
          <SourceView
            profile={profile}
            selectedFnId={selectedFnId}
            onSelectFunction={setSelectedFnId}
          />
        )}
      </main>

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-amber-500/10">
          <p className="rounded-lg border-2 border-dashed border-amber-500 bg-zinc-950/80 px-6 py-4 text-sm text-white">
            Drop to open this profile
          </p>
        </div>
      )}
    </div>
  );
}
