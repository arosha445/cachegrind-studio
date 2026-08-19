import type { I32 } from './types.js';

/**
 * Open-addressing hash index over three int32 keys.
 *
 * Used to aggregate cost lines while scanning, rather than appending every raw
 * line and merging afterwards. That distinction is load-bearing: a large
 * profile holds millions of cost lines but only tens of thousands of *distinct*
 * (function, line) positions, because Xdebug emits one record per invocation.
 * Aggregating on the fly keeps memory proportional to distinct positions.
 *
 * Deliberately not a class with methods — the lookup runs once per cost line,
 * and keeping it as free functions over a flat struct keeps the shape
 * monomorphic.
 */

export interface HashIndex {
  /** slot -> (entry index + 1); 0 means empty. Length is a power of two. */
  slots: I32;
  mask: number;
  /** Entry keys, parallel to entry indices. */
  k0: I32;
  k1: I32;
  k2: I32;
  size: number;
  /** Set by `lookupOrInsert`: true when the returned entry was newly created. */
  inserted: boolean;
}

export function createHashIndex(initialSlots = 4096): HashIndex {
  let slotCount = 16;
  while (slotCount < initialSlots) slotCount *= 2;
  return {
    slots: new Int32Array(slotCount),
    mask: slotCount - 1,
    k0: new Int32Array(slotCount >> 1),
    k1: new Int32Array(slotCount >> 1),
    k2: new Int32Array(slotCount >> 1),
    size: 0,
    inserted: false,
  };
}

function mix(a: number, b: number, c: number): number {
  let h = Math.imul(a, 0x9e3779b1);
  h = Math.imul(h ^ b, 0x85ebca6b);
  h = Math.imul(h ^ c, 0xc2b2ae35);
  h ^= h >>> 15;
  return h >>> 0;
}

function rehash(index: HashIndex): void {
  const slotCount = index.slots.length * 2;
  const slots = new Int32Array(slotCount);
  const mask = slotCount - 1;
  const { k0, k1, k2, size } = index;
  for (let entry = 0; entry < size; entry++) {
    let slot = mix(k0[entry]!, k1[entry]!, k2[entry]!) & mask;
    while (slots[slot] !== 0) slot = (slot + 1) & mask;
    slots[slot] = entry + 1;
  }
  index.slots = slots;
  index.mask = mask;
}

/**
 * Return the entry index for `(a, b, c)`, creating it if absent.
 * Check `index.inserted` afterwards to learn whether value columns need
 * initialising for the returned index.
 */
export function lookupOrInsert(index: HashIndex, a: number, b: number, c: number): number {
  const { slots, mask } = index;
  let slot = mix(a, b, c) & mask;
  for (;;) {
    const probe = slots[slot]!;
    if (probe === 0) break;
    const entry = probe - 1;
    if (index.k0[entry] === a && index.k1[entry] === b && index.k2[entry] === c) {
      index.inserted = false;
      return entry;
    }
    slot = (slot + 1) & mask;
  }

  const entry = index.size;
  if (entry >= index.k0.length) {
    const capacity = index.k0.length * 2;
    const k0 = new Int32Array(capacity);
    k0.set(index.k0);
    const k1 = new Int32Array(capacity);
    k1.set(index.k1);
    const k2 = new Int32Array(capacity);
    k2.set(index.k2);
    index.k0 = k0;
    index.k1 = k1;
    index.k2 = k2;
  }
  index.k0[entry] = a;
  index.k1[entry] = b;
  index.k2[entry] = c;
  index.size = entry + 1;
  index.slots[slot] = entry + 1;
  index.inserted = true;

  // Keep load factor under ~0.7. Rehash after insertion so the new entry moves too.
  if (index.size * 10 >= index.slots.length * 7) rehash(index);
  return entry;
}
