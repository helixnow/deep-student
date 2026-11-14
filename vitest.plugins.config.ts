import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['scripts/plugins/tests/**/*.test.ts'],
    pool: 'forks', maxWorkers: 1, minWorkers: 1,
    testTimeout: 20_000,
  },
});
