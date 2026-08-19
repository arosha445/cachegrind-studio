/// <reference lib="webworker" />
import {
  buildFlameGraph,
  collectTransferables,
  parseProfile,
  type FlameGraph,
} from '@cachegrind-studio/parser';
import type { WorkerRequest, WorkerResponse } from './protocol.js';

/**
 * Parsing and flame-graph construction both run here. Neither touches the DOM,
 * and doing them on the main thread is precisely what freezes the tab in the
 * tools this project replaces.
 */

const post = (message: WorkerResponse, transfer: Transferable[] = []): void => {
  (self as DedicatedWorkerGlobalScope).postMessage(message, transfer);
};

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (request.type !== 'parse') return;

  void (async () => {
    const startedAt = performance.now();
    try {
      const profile = await parseProfile(new Uint8Array(request.bytes), {
        onProgress: (progress) => {
          post({ type: 'progress', id: request.id, progress });
        },
      });

      const parsedAt = performance.now();
      const flame = buildFlameGraph(profile, { metric: request.metric });
      const flameAt = performance.now();

      post(
        {
          type: 'result',
          id: request.id,
          name: request.name,
          profile,
          flame,
          elapsedMs: flameAt - startedAt,
          parseMs: parsedAt - startedAt,
          flameMs: flameAt - parsedAt,
        },
        [...collectTransferables(profile), ...flameTransferables(flame)],
      );
    } catch (error) {
      post({
        type: 'error',
        id: request.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })();
};

function flameTransferables(flame: FlameGraph): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  for (const column of [
    flame.fnId,
    flame.depth,
    flame.start,
    flame.value,
    flame.selfValue,
    flame.parent,
    flame.callCount,
    flame.flags,
  ]) {
    if (column.buffer instanceof ArrayBuffer) buffers.add(column.buffer);
  }
  return [...buffers];
}
