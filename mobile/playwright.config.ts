import { defineConfig, devices } from '@playwright/test';

/**
 * 测的是生产优化的构建（`vite build` + `vite preview`），性能数据与打包体积对应同一份产物。
 * 用例经 `mobileDiagnostics` 驱动 Host，所以构建带 `--mode diagnostics`（host-worker.ts 只在该模式装诊断插件）。
 */
const PORT = 5318;

export default defineConfig({
  testDir: './tests',
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  reporter: [['list']],
  outputDir: './test-results/artifacts',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    headless: true,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npx vite build --mode diagnostics --logLevel warn && npx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
  },
});
