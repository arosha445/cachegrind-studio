import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Window-wide drop target.
 *
 * Listening on `window` rather than on a box means a profile can be dropped
 * anywhere, including on top of an already-loaded one — which is what people
 * actually do when comparing runs.
 */
export function useFileDrop(onFile: (file: File) => void): { dragging: boolean } {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  useEffect(() => {
    const onDragEnter = (event: DragEvent): void => {
      if (event.dataTransfer?.types.includes('Files') !== true) return;
      event.preventDefault();
      depth.current += 1;
      setDragging(true);
    };
    const onDragOver = (event: DragEvent): void => {
      if (event.dataTransfer?.types.includes('Files') !== true) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = (): void => {
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const onDrop = (event: DragEvent): void => {
      const file = event.dataTransfer?.files?.[0];
      if (file === undefined) return;
      event.preventDefault();
      depth.current = 0;
      setDragging(false);
      onFile(file);
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [onFile]);

  return { dragging };
}

export function DropZone({
  onFile,
  dragging,
}: {
  onFile: (file: File) => void;
  dragging: boolean;
}): React.ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);

  const onPick = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file !== undefined) onFile(file);
      event.target.value = '';
    },
    [onFile],
  );

  return (
    <div className="flex h-full items-center justify-center p-8">
      <div
        className={`w-full max-w-2xl rounded-xl border-2 border-dashed p-10 text-center transition-colors ${
          dragging
            ? 'border-amber-500 bg-amber-500/5'
            : 'border-zinc-300 dark:border-zinc-700'
        }`}
      >
        <h1 className="text-2xl font-semibold tracking-tight">Cachegrind Studio</h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Drop a <code className="font-mono">cachegrind.out</code> file anywhere on this page.
          Gzipped files are fine.
        </p>

        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="mt-6 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          Choose a file
        </button>
        <input ref={inputRef} type="file" className="hidden" onChange={onPick} />

        <p className="mt-8 text-xs text-zinc-500">
          Parsing happens in your browser, in a Web Worker. Nothing is uploaded.
        </p>

        <details className="mt-6 text-left text-xs text-zinc-500">
          <summary className="cursor-pointer">No profile files yet?</summary>
          <pre className="mt-3 overflow-x-auto rounded-md bg-zinc-100 p-3 font-mono text-[11px] leading-relaxed dark:bg-zinc-900">
            {`[xdebug]
zend_extension=xdebug
xdebug.mode=profile
xdebug.start_with_request=trigger
xdebug.output_dir="C:\\xampp\\tmp"
xdebug.profiler_output_name=cachegrind.out.%t.%p`}
          </pre>
          <p className="mt-2">
            <code className="font-mono">xdebug.mode</code> cannot be set with{' '}
            <code className="font-mono">ini_set()</code> or{' '}
            <code className="font-mono">.htaccess</code> — it has to go in{' '}
            <code className="font-mono">php.ini</code>. Restart Apache, then add{' '}
            <code className="font-mono">?XDEBUG_TRIGGER=1</code> to a URL.
          </p>
        </details>
      </div>
    </div>
  );
}
