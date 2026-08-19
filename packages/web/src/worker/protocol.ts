import type { FlameGraph, FlameMetric, ParseProgress, Profile } from '@cachegrind-studio/parser';

/**
 * The Worker boundary.
 *
 * Everything crossing it is either a plain object or a typed array listed in a
 * transfer list. The profile's columns move rather than copy, which is what
 * keeps handing a large profile to the UI thread from costing as much as
 * parsing it did.
 */

export interface ParseRequest {
  readonly type: 'parse';
  readonly id: number;
  readonly name: string;
  /** Transferred, not copied. Unusable on the main thread afterwards. */
  readonly bytes: ArrayBuffer;
  readonly metric: FlameMetric;
}

export type WorkerRequest = ParseRequest;

export interface ProgressMessage {
  readonly type: 'progress';
  readonly id: number;
  readonly progress: ParseProgress;
}

export interface ResultMessage {
  readonly type: 'result';
  readonly id: number;
  readonly name: string;
  readonly profile: Profile;
  readonly flame: FlameGraph;
  /** Wall-clock milliseconds spent inside the Worker. */
  readonly elapsedMs: number;
  /** Split of `elapsedMs`, so a regression in either half is visible. */
  readonly parseMs: number;
  readonly flameMs: number;
}

export interface ErrorMessage {
  readonly type: 'error';
  readonly id: number;
  readonly message: string;
}

export type WorkerResponse = ProgressMessage | ResultMessage | ErrorMessage;
