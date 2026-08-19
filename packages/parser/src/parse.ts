import { gunzipIfNeeded, isGzip } from './gzip.js';
import { scanCallgrind } from './scan.js';
import type { ParseOptions, Profile } from './types.js';

/**
 * The parser's entire public surface: bytes in, columnar profile out.
 *
 * Deliberately narrow. If measurements ever show TypeScript parsing dominating
 * on very large profiles, a WASM implementation can replace everything behind
 * this signature without the UI noticing.
 */
export async function parseProfile(
  input: ArrayBuffer | Uint8Array,
  options: ParseOptions = {},
): Promise<Profile> {
  const raw = input instanceof Uint8Array ? input : new Uint8Array(input);
  const compressed = isGzip(raw);

  if (compressed) options.onProgress?.({ phase: 'decompress', ratio: 0 });
  const bytes = await gunzipIfNeeded(raw);
  if (compressed) options.onProgress?.({ phase: 'decompress', ratio: 1 });

  return scanCallgrind(bytes, compressed, options);
}
