import { defineConfig } from 'vitest/config';
import frontend from '../../../vitest.config.ts';

// Reuse the frontend environment but use the OFFICIAL Tauri core/event packages:
// their invoke/listen must go through the real Electron preload bridge below.
export default defineConfig({
  ...frontend,
  resolve: { alias: Object.fromEntries(Object.entries(frontend.resolve!.alias as Record<string, string>)
    .filter(([name]) => name !== '@tauri-apps/api/core' && name !== '@tauri-apps/api/event')) },
  test: { ...frontend.test, include: ['host/e2e/streaming/__tests__/*.spec.mts'], maxWorkers: 1 },
});
