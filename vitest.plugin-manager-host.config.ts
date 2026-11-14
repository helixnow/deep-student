import { defineConfig } from 'vitest/config';
import base from './vitest.config';

/** Native Node Host + real React DOM UI; ordinary component tests keep their normal jsdom runner. */
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    environment: 'node',
    include: ['src/features/plugin-manager/__tests__/real-host.host-e2e.tsx', 'src/app/__tests__/workshop.host-e2e.tsx'],
    setupFiles: ['./src/features/plugin-manager/__tests__/real-host.setup.ts', './vitest.setup.ts'],
    testTimeout: 30_000,
  },
});
