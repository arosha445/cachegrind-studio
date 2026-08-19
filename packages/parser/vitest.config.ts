import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'parser',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    benchmark: { include: ['bench/**/*.bench.ts'] },
  },
});
