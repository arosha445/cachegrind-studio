import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseProfile } from '../src/parse.js';
import type { Profile } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = join(here, '..', '..', '..', 'fixtures', 'callgrind');

export function fixtureBytes(name: string): Uint8Array {
  const buffer = readFileSync(join(FIXTURE_DIR, name));
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

export function parseFixture(name: string): Promise<Profile> {
  return parseProfile(fixtureBytes(name));
}

/** Function id by exact name. Throws with the available names, which makes a
 *  renamed fixture fail loudly instead of silently asserting on -1. */
export function fnId(profile: Profile, name: string): number {
  const id = profile.functionNames.indexOf(name);
  if (id === -1) {
    throw new Error(`no function named ${name}; profile has: ${profile.functionNames.join(', ')}`);
  }
  return id;
}

/** Function id by substring — for the Windows-path-bearing names. */
export function fnIdMatching(profile: Profile, needle: string): number {
  const id = profile.functionNames.findIndex((name) => name.includes(needle));
  if (id === -1) {
    throw new Error(`no function matching ${needle}; profile has: ${profile.functionNames.join(', ')}`);
  }
  return id;
}

export function edge(
  profile: Profile,
  callerFnId: number,
  calleeFnId: number,
): { callCount: number; inclTime: number; inclMemory: number } {
  let callCount = 0;
  let inclTime = 0;
  let inclMemory = 0;
  for (let i = 0; i < profile.calls.count; i++) {
    if (profile.calls.callerFnId[i] !== callerFnId) continue;
    if (profile.calls.calleeFnId[i] !== calleeFnId) continue;
    callCount += profile.calls.callCount[i]!;
    inclTime += profile.calls.inclTime[i]!;
    inclMemory += profile.calls.inclMemory[i]!;
  }
  return { callCount, inclTime, inclMemory };
}

export function lineCost(profile: Profile, fn: number, line: number): number {
  for (let i = 0; i < profile.lines.count; i++) {
    if (profile.lines.fnId[i] === fn && profile.lines.line[i] === line) {
      return profile.lines.time[i]!;
    }
  }
  return 0;
}
