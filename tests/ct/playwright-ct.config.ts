import { defineConfig } from '@playwright/experimental-ct-react';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');

export default defineConfig({
  testDir: __dirname,
  testMatch: ['**/*.spec.{ts,tsx}'],
  fullyParallel: true,
  retries: 0,
  timeout: 30000,
  reporter: 'list',
  use: {
    ctPort: 3101,
    ctTemplateDir: './playwright',
    ctViteConfig: {
      plugins: [react()],
      server: { port: 3101 },
      build: {
        rollupOptions: {
          input: {
            index: path.resolve(__dirname, 'playwright/index.html'),
          },
        },
      },
      resolve: {
        alias: {
          '@': path.resolve(rootDir, 'src'),
          '@tauri-apps/api/core': path.resolve(__dirname, 'mocks/tauri-core-mock.ts'),
          '@tauri-apps/api/event': path.resolve(__dirname, 'mocks/tauri-event-mock.ts'),
          '@tauri-apps/api/window': path.resolve(__dirname, 'mocks/tauri-window-mock.ts'),
          '@tauri-apps/api/webviewWindow': path.resolve(__dirname, 'mocks/tauri-webviewWindow-mock.ts'),
          '@tauri-apps/api/webview': path.resolve(__dirname, 'mocks/tauri-webview-mock.ts'),
          '/src/contexts/SubjectContext.tsx': path.resolve(__dirname, 'mocks/SubjectContext.mock.tsx'),
          'react-i18next': path.resolve(__dirname, 'mocks/react-i18next.tsx'),
          '/src/utils/tauriApi.ts': path.resolve(__dirname, 'mocks/tauriApi.mock.ts'),
        },
      },
    },
  },
});
