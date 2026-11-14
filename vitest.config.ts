import { defineConfig } from 'vitest/config';
import { searchForWorkspaceRoot } from 'vite';
import react from '@vitejs/plugin-react-swc';
import fs from 'fs';
import path from 'path';

// node_modules 可能是软链（多个 worktree 共用一份）：Vite 按真实路径解析依赖，真实路径落在工作区外会被
// fs.allow 拒绝（如 `katex/dist/katex.min.css?raw`）。只额外放行本工程 node_modules 的真实路径本身；
// 设置 allow 会覆盖默认值，所以显式保留默认的工作区根。node_modules 不是软链时两者重合，等同默认配置。
export const fsAllow = (root: string = __dirname): string[] => {
  const modules = path.join(root, 'node_modules');
  const allow = [searchForWorkspaceRoot(root)];
  if (fs.existsSync(modules)) allow.push(fs.realpathSync(modules));
  return [...new Set(allow)];
};

export default defineConfig({
  plugins: [react()],
  // 依赖预打包产物放在本工作区：node_modules 被多个 worktree 共用，默认的 node_modules/.vite 会被并发改写。
  cacheDir: path.join(__dirname, '.cache/vite'),
  server: {
    fs: { allow: fsAllow() },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: [
      'tests/vitest/ui-shell/**/*.{test,spec}.{ts,tsx}',
      'tests/vitest/**/*.{test,spec}.{ts,tsx}',
      'src/**/*.{test,spec}.{ts,tsx}',
    ],
    // @phosphor-icons/react 的 ESM 桶文件约 7,500 个模块，逐个转换让首个引到它的用例冷加载 2–3 s；
    // 预打包成单文件后约 0.1 s。
    deps: { optimizer: { web: { enabled: true, include: ['@phosphor-icons/react'] } } },
    css: false, // 禁用CSS处理避免选择器问题
    silent: true, // 降低日志噪音与内存占用，避免大规模 console 输出导致 runner 不稳定
    // 🔧 稳定性：Node 22 + threads(tinypool) 偶发 "Channel closed" 崩溃 → 用 forks 池规避。
    // ⚠️ 不要再开 singleFork：单进程串行会让 jsdom 内存跨文件累积，
    // 大批量文件跑到中途触发 V8 GC 抖动近似死锁（本地与 CI 分片 4 均复现过）。
    // 多进程并行 + 堆上限兜底，内存有界且显著更快。
    // CI 分片曾把单个 worker 顶死在 4096MB（日志约 4001MB 后 OOM），
    // 不是断言失败。CI 提高单进程堆、同时把 forks 上限收成 2，避免
    // 4 worker × 6GB 撑爆 runner；不放宽任何用例。
    pool: 'forks',
    poolOptions: {
      forks: {
        execArgv: [
          process.env.CI ? '--max-old-space-size=6144' : '--max-old-space-size=4096',
        ],
        ...(process.env.CI ? { maxForks: 2 } : {}),
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@deepstudent/ui': path.resolve(__dirname, 'src/ui-sdk/index.ts'),
      '@tauri-apps/api/core': path.resolve(__dirname, 'tests/ct/mocks/tauri-core-mock.ts'),
      '@tauri-apps/api/event': path.resolve(__dirname, 'tests/ct/mocks/tauri-event-mock.ts'),
      '@tauri-apps/api/window': path.resolve(__dirname, 'tests/ct/mocks/tauri-window-mock.ts'),
      '@tauri-apps/api/webviewWindow': path.resolve(__dirname, 'tests/ct/mocks/tauri-webviewWindow-mock.ts'),
      '@tauri-apps/api/webview': path.resolve(__dirname, 'tests/ct/mocks/tauri-webview-mock.ts'),
      '/src/contexts/SubjectContext.tsx': path.resolve(__dirname, 'tests/ct/mocks/SubjectContext.mock.tsx'),
      'react-i18next': path.resolve(__dirname, 'tests/ct/mocks/react-i18next.tsx'),
      '/src/utils/tauriApi.ts': path.resolve(__dirname, 'tests/ct/mocks/tauriApi.mock.ts'),
    },
  },
});
