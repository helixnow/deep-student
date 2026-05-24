import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  outputDir: './results',
  use: {
    baseURL: 'http://localhost:1422',
    viewport: { width: 1280, height: 800 },
    screenshot: 'only-on-failure',
  },
  webServer: undefined, // Assumes dev server is already running
  reporter: 'list',
});
