/**
 * Synthesises Callgrind bytes with the same shape real Xdebug output has, at
 * an arbitrary size.
 *
 * Committing a 100 MB fixture is not reasonable, and the v0.1 success criterion
 * is stated in terms of one. Generating it mirrors what actually makes large
 * profiles large: Xdebug emits a fresh record per *invocation*, so the file is
 * dominated by short repeated records over a small set of compressed names.
 */

export interface SyntheticOptions {
  /** Approximate output size in bytes. */
  readonly targetBytes: number;
  /** Distinct functions in the profile. */
  readonly functionCount?: number;
  /** Distinct source files. */
  readonly fileCount?: number;
  /** Calls emitted per function record. */
  readonly callsPerRecord?: number;
}

export function synthesizeCallgrind(options: SyntheticOptions): Uint8Array {
  const functionCount = options.functionCount ?? 2000;
  const fileCount = options.fileCount ?? 200;
  const callsPerRecord = options.callsPerRecord ?? 4;

  const parts: string[] = [];
  parts.push('version: 1\n');
  parts.push('creator: xdebug 3.5.1 (PHP 8.3.29)\n');
  parts.push('cmd: C:\\xampp\\htdocs\\app\\public\\index.php\n');
  parts.push('part: 1\n');
  parts.push('positions: line\n\n');
  parts.push('events: Time_(10ns) Memory_(bytes)\n\n');

  // Define every name once, exactly as Xdebug does, then reference by id.
  for (let file = 1; file <= fileCount; file++) {
    parts.push(`fl=(${file}) C:\\xampp\\htdocs\\app\\vendor\\acme\\pkg${file}\\src\\Service.php\n`);
    parts.push(`fn=(${file}) Acme\\Pkg${file}\\Service->handle\n`);
    parts.push(`${10 + (file % 40)} ${100 + file} ${64 * (file % 8)}\n\n`);
  }
  for (let fn = fileCount + 1; fn <= functionCount; fn++) {
    parts.push(`fl=(${1 + (fn % fileCount)})\n`);
    parts.push(`fn=(${fn}) Acme\\Domain\\Model${fn % 97}->compute${fn % 13}\n`);
    parts.push(`${20 + (fn % 60)} ${50 + fn} ${32 * (fn % 5)}\n\n`);
  }

  let approximate = 0;
  for (const part of parts) approximate += part.length;

  // The bulk: one record per invocation, all name-compressed.
  let seed = 12345;
  const random = (): number => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return seed;
  };

  let totalSelf = 0;
  while (approximate < options.targetBytes) {
    const fn = 1 + (random() % functionCount);
    const chunk: string[] = [];
    chunk.push(`fl=(${1 + (random() % fileCount)})\n`);
    chunk.push(`fn=(${fn})\n`);
    const selfCost = 10 + (random() % 500);
    totalSelf += selfCost;
    chunk.push(`${20 + (random() % 60)} ${selfCost} ${8 * (random() % 16)}\n`);
    for (let call = 0; call < callsPerRecord; call++) {
      const callee = 1 + (random() % functionCount);
      chunk.push(`cfl=(${1 + (random() % fileCount)})\n`);
      chunk.push(`cfn=(${callee})\n`);
      chunk.push('calls=1 0 0\n');
      chunk.push(`${20 + (random() % 60)} ${10 + (random() % 200)} 0\n`);
    }
    chunk.push('\n');
    for (const line of chunk) {
      parts.push(line);
      approximate += line.length;
    }
  }

  // A real entry point, so flame-graph benchmarks have something to expand.
  parts.push('fl=(1)\n');
  parts.push('fn=(0) {main}\n');
  parts.push(`1 ${Math.round(totalSelf / 100)} 0\n`);
  for (let callee = 1; callee <= Math.min(20, functionCount); callee++) {
    parts.push(`cfl=(1)\ncfn=(${callee})\ncalls=1 0 0\n`);
    parts.push(`${callee} ${Math.round(totalSelf / 20)} 0\n`);
  }
  return new TextEncoder().encode(parts.join(''));
}
