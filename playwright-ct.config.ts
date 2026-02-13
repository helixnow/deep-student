import { defineConfig } from '@playwright/experimental-ct-react';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const subjectCtxPath = path.resolve(__dirname, 'src/contexts/SubjectContext.tsx');

export default defineConfig({
  testDir: './tests/ct',
  fullyParallel: true,
  retries: 0,
  timeout: 30000,
  reporter: 'list',
  use: {
    ctPort: 3101,
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
          '@tauri-apps/api/core': path.resolve(__dirname, 'tests/ct/mocks/tauri-core-mock.ts'),
          '@tauri-apps/api/event': path.resolve(__dirname, 'tests/ct/mocks/tauri-event-mock.ts'),
          '@tauri-apps/api/window': path.resolve(__dirname, 'tests/ct/mocks/tauri-window-mock.ts'),
          '@tauri-apps/api/webviewWindow': path.resolve(__dirname, 'tests/ct/mocks/tauri-webviewWindow-mock.ts'),
          '@tauri-apps/api/webview': path.resolve(__dirname, 'tests/ct/mocks/tauri-webview-mock.ts'),
          // Mock SubjectContext to avoid real Tauri calls during provider init
          '/src/contexts/SubjectContext.tsx': path.resolve(__dirname, 'tests/ct/mocks/SubjectContext.mock.tsx'),
          'react-i18next': path.resolve(__dirname, 'tests/ct/mocks/react-i18next.tsx'),
          '/src/utils/tauriApi.ts': path.resolve(__dirname, 'tests/ct/mocks/tauriApi.mock.ts'),
          '/src/chat-core/index.ts': path.resolve(__dirname, 'tests/ct/mocks/chat-core.index.mock.ts'),
          '/src/chat-core/dev/guardedListen.ts': path.resolve(__dirname, 'tests/ct/mocks/guardedListen.mock.ts'),
          '/src/chat-core/dev/emitDebug.ts': path.resolve(__dirname, 'tests/ct/mocks/emitDebug.mock.ts'),
          '/src/chat-core/utils/sessionLayer.ts': path.resolve(__dirname, 'tests/ct/mocks/sessionLayer.mock.ts'),
          '/src/chat-core/runtime/CompatRuntime.ts': path.resolve(__dirname, 'tests/ct/mocks/CompatRuntime.mock.ts'),
          '/src/chat-core/runtime/attachments.ts': path.resolve(__dirname, 'tests/ct/mocks/attachments.mock.ts'),
        },
      },
    },
  },
});


