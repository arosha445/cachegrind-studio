/**
 * Xdebug 3.1+ gzips profiles by default (`xdebug.use_compression`), and the
 * file is still named `cachegrind.out.*` — so sniffing the magic bytes is the
 * only reliable test. Users drag in whatever their php.ini produced.
 */

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === GZIP_MAGIC_0 && bytes[1] === GZIP_MAGIC_1;
}

export class DecompressionUnavailableError extends Error {
  constructor() {
    super(
      'This profile is gzipped and DecompressionStream is unavailable in this ' +
        'runtime. Use a current browser, or set xdebug.use_compression=0 and ' +
        're-run the profile.',
    );
    this.name = 'DecompressionUnavailableError';
  }
}

/**
 * Returns the bytes unchanged when they are not gzipped, so callers can pass
 * anything a user dropped on the page.
 *
 * Uses the platform `DecompressionStream`, available in every browser the app
 * targets and in Node 18+. There is a deliberate seam here for an `fflate`
 * fallback if the support floor ever needs lowering; that would be the
 * parser's first runtime dependency, so it is not taken on speculatively.
 */
export async function gunzipIfNeeded(bytes: Uint8Array): Promise<Uint8Array> {
  if (!isGzip(bytes)) return bytes;

  const DecompressionStreamCtor = (globalThis as { DecompressionStream?: typeof DecompressionStream })
    .DecompressionStream;
  if (typeof DecompressionStreamCtor !== 'function') {
    throw new DecompressionUnavailableError();
  }

  const stream = new DecompressionStreamCtor('gzip');
  const writer = stream.writable.getWriter();
  // A fresh copy: the source may be a view onto a buffer we are about to
  // transfer, and enqueueing a view detaches it in some runtimes.
  void writer.write(bytes.slice());
  void writer.close();

  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value as Uint8Array;
    chunks.push(chunk);
    total += chunk.length;
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
