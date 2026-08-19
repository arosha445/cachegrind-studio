/**
 * Doubling growth for typed-array columns.
 *
 * The parser does not know up front how many distinct positions or call edges a
 * profile holds, and a counting pre-pass would mean scanning 200 MB twice.
 * Doubling costs an amortised copy and keeps the scan single-pass.
 */

import type { F64, I32, U8 } from './types.js';

/** Next power-of-two capacity that fits `needed`, never below `min`. */
export function nextCapacity(current: number, needed: number, min = 1024): number {
  let capacity = Math.max(current, min);
  while (capacity < needed) capacity *= 2;
  return capacity;
}

export function growI32(source: I32, capacity: number): I32 {
  if (source.length >= capacity) return source;
  const next = new Int32Array(capacity);
  next.set(source);
  return next;
}

export function growF64(source: F64, capacity: number): F64 {
  if (source.length >= capacity) return source;
  const next = new Float64Array(capacity);
  next.set(source);
  return next;
}

export function growU8(source: U8, capacity: number): U8 {
  if (source.length >= capacity) return source;
  const next = new Uint8Array(capacity);
  next.set(source);
  return next;
}

/** Trim a column to exactly `length` elements, copying into a right-sized buffer. */
export function trimI32(source: I32, length: number): I32 {
  return source.length === length ? source : source.slice(0, length);
}

export function trimF64(source: F64, length: number): F64 {
  return source.length === length ? source : source.slice(0, length);
}

export function trimU8(source: U8, length: number): U8 {
  return source.length === length ? source : source.slice(0, length);
}
