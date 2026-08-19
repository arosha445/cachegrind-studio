import type { Profile } from './types.js';

/**
 * Display helpers. Raw cost values stay raw everywhere else so that summing and
 * diffing never accumulate rounding error; conversion happens here, once, at
 * the point of rendering.
 */

/** Convert a raw Time cost from this profile into milliseconds. */
export function toMilliseconds(profile: Profile, rawTime: number): number {
  return rawTime * profile.meta.timeToMs;
}

/** `1234.5` ms -> `1.23 s`; `0.4` ms -> `400 µs`. */
export function formatDuration(milliseconds: number): string {
  const value = Math.abs(milliseconds);
  if (value >= 1000) return `${(milliseconds / 1000).toFixed(2)} s`;
  if (value >= 1) return `${milliseconds.toFixed(2)} ms`;
  if (value >= 0.001) return `${(milliseconds * 1000).toFixed(1)} \u00b5s`;
  return `${(milliseconds * 1e6).toFixed(0)} ns`;
}

export function formatBytes(bytes: number): string {
  const value = Math.abs(bytes);
  if (value >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  if (value >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes.toFixed(0)} B`;
}

export function formatPercent(fraction: number): string {
  if (!Number.isFinite(fraction)) return '0.00%';
  return `${(fraction * 100).toFixed(2)}%`;
}

/**
 * Windows and POSIX separators both, in one place. Profiles routinely carry
 * `C:\xampp\htdocs\...`, and a pattern that only splits on `/` silently leaves
 * the whole Windows path as a single segment.
 */
const PATH_SEPARATOR = /[\\/]/;

/**
 * Strip the leading directories a user does not care about, keeping the last
 * two path segments. Handles Windows and POSIX separators — profiles routinely
 * carry `C:\xampp\htdocs\...`.
 */
export function shortenPath(path: string): string {
  if (path === '' || path === 'php:internal') return path;
  const parts = path.split(PATH_SEPARATOR).filter((part) => part.length > 0);
  if (parts.length <= 2) return path;
  return `\u2026/${parts.slice(-2).join('/')}`;
}

/** `Widget->add` -> `Widget->add`; `{closure:/very/long/path.php:42-44}` -> `{closure @ path.php:42}`. */
export function shortenFunctionName(name: string): string {
  const closure = /^\{closure:(.+):(\d+)-\d+\}$/.exec(name);
  if (closure !== null) {
    const file = closure[1]!.split(PATH_SEPARATOR).pop() ?? closure[1]!;
    return `{closure @ ${file}:${closure[2]}}`;
  }
  const include = /^(require|require_once|include|include_once)::(.+)$/.exec(name);
  if (include !== null) {
    const file = include[2]!.split(PATH_SEPARATOR).pop() ?? include[2]!;
    return `${include[1]} ${file}`;
  }
  return name;
}
