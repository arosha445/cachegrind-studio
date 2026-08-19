import { useCallback, useEffect, useRef, useState } from 'react';
import type { FlameGraph, FlameMetric, ParseProgress, Profile } from '@cachegrind-studio/parser';
import type { WorkerRequest, WorkerResponse } from './protocol.js';

export interface LoadedProfile {
  readonly name: string;
  readonly profile: Profile;
  readonly flame: FlameGraph;
  readonly elapsedMs: number;
  readonly parseMs: number;
  readonly flameMs: number;
}

export type LoaderState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading'; readonly name: string; readonly progress: ParseProgress | null }
  | { readonly status: 'ready'; readonly loaded: LoadedProfile }
  | { readonly status: 'error'; readonly name: string; readonly message: string };

/**
 * Owns the parser Worker for the lifetime of the app.
 *
 * One long-lived Worker rather than one per file: spinning up a Worker costs
 * more than parsing a small profile, and the module graph would be re-fetched
 * every time.
 */
export function useProfileLoader(): {
  state: LoaderState;
  load: (file: File, metric?: FlameMetric) => void;
  reset: () => void;
} {
  const workerRef = useRef<Worker | null>(null);
  const requestId = useRef(0);
  const [state, setState] = useState<LoaderState>({ status: 'idle' });

  useEffect(() => {
    const worker = new Worker(new URL('./parser.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      // Ignore anything from a request the user has already superseded.
      if (message.id !== requestId.current) return;

      if (message.type === 'progress') {
        setState((previous) =>
          previous.status === 'loading' ? { ...previous, progress: message.progress } : previous,
        );
        return;
      }
      if (message.type === 'result') {
        setState({
          status: 'ready',
          loaded: {
            name: message.name,
            profile: message.profile,
            flame: message.flame,
            elapsedMs: message.elapsedMs,
            parseMs: message.parseMs,
            flameMs: message.flameMs,
          },
        });
        return;
      }
      setState((previous) => ({
        status: 'error',
        name: previous.status === 'loading' ? previous.name : '',
        message: message.message,
      }));
    };

    worker.onerror = (event) => {
      setState({ status: 'error', name: '', message: event.message || 'The parser worker failed' });
    };

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const load = useCallback((file: File, metric: FlameMetric = 'time') => {
    const worker = workerRef.current;
    if (worker === null) return;

    const id = requestId.current + 1;
    requestId.current = id;
    setState({ status: 'loading', name: file.name, progress: null });

    void file
      .arrayBuffer()
      .then((bytes) => {
        if (requestId.current !== id) return;
        const request: WorkerRequest = {
          type: 'parse',
          id,
          name: file.name,
          bytes,
          metric,
        };
        worker.postMessage(request, [bytes]);
      })
      .catch((error: unknown) => {
        setState({
          status: 'error',
          name: file.name,
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }, []);

  const reset = useCallback(() => {
    requestId.current += 1;
    setState({ status: 'idle' });
  }, []);

  return { state, load, reset };
}
