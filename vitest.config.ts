import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: [
      'tests/vitest/ui-shell/**/*.{test,spec}.{ts,tsx}',
      'tests/vitest/**/*.{test,spec}.{ts,tsx}',
      'src/**/*.{test,spec}.{ts,tsx}',
    ],
    css: false, // 禁用CSS处理避免选择器问题
    silent: true, // 降低日志噪音与内存占用，避免大规模 console 输出导致 runner 不稳定
    // 🔧 稳定性：Node 22 + threads(tinypool) 偶发 "Channel closed" 崩溃 → 用 forks 池规避。
    // ⚠️ 不要再开 singleFork：单进程串行会让 jsdom 内存跨文件累积，
    // 大批量文件跑到中途触发 V8 GC 抖动近似死锁（本地与 CI 分片 4 均复现过）。
    // 多进程并行 + 堆上限兜底，内存有界且显著更快。
    pool: 'forks',
    poolOptions: {
      forks: {
        execArgv: ['--max-old-space-size=4096'],
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      'heic2any': path.resolve(__dirname, 'tests/vitest/mocks/heic2any.mock.ts'),
      '@tauri-apps/api/core': path.resolve(__dirname, 'tests/ct/mocks/tauri-core-mock.ts'),
      '@tauri-apps/api/event': path.resolve(__dirname, 'tests/ct/mocks/tauri-event-mock.ts'),
      '@tauri-apps/api/window': path.resolve(__dirname, 'tests/ct/mocks/tauri-window-mock.ts'),
      '@tauri-apps/api/webviewWindow': path.resolve(__dirname, 'tests/ct/mocks/tauri-webviewWindow-mock.ts'),
      '@tauri-apps/api/webview': path.resolve(__dirname, 'tests/ct/mocks/tauri-webview-mock.ts'),
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
});
