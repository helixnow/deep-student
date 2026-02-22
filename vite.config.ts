import path from "node:path";
import { createRequire } from "node:module";
import { defineConfig, normalizePath } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { viteStaticCopy } from "vite-plugin-static-copy";
// Explicit PostCSS config to ensure Tailwind is applied even if auto-detection fails
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import tailwindcss from "tailwindcss";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import autoprefixer from "autoprefixer";

// PDF.js 资源路径配置（用于支持非拉丁字符、JPEG 2000 图片、标准字体）
const require = createRequire(import.meta.url);
const pdfjsDistPath = path.dirname(require.resolve('pdfjs-dist/package.json'));
const cMapsDir = normalizePath(path.join(pdfjsDistPath, 'cmaps'));
const standardFontsDir = normalizePath(path.join(pdfjsDistPath, 'standard_fonts'));
const wasmDir = normalizePath(path.join(pdfjsDistPath, 'wasm'));

// Node 环境变量（避免 TS 提示）
const host = (process as any)?.env?.TAURI_DEV_HOST;

// https://vitejs.dev/config/
export default defineConfig(({ command, mode }) => ({
  // 使用相对 base 以兼容移动端 tauri 协议资源加载，避免打包后绝对路径导致白屏
  // dev 使用默认根路径，build 使用相对路径
  base: command === 'serve' ? '/' : './',
  plugins: [
    // 生产构建排除 mcp-debug 模块（4,573 行调试代码），替换为空实现
    mode === 'production' && {
      name: 'exclude-mcp-debug',
      resolveId(id: string) {
        if (id.includes('mcp-debug')) return '\0mcp-debug-noop';
      },
      load(id: string) {
        if (id === '\0mcp-debug-noop') {
          return 'export const initMCPDebug = async () => {}; export const registerAllStores = async () => {}; export const destroyMCPDebug = () => {};';
        }
      },
    },
    react(),
    viteStaticCopy({
      targets: [
        { src: cMapsDir, dest: '' },
        { src: standardFontsDir, dest: '' },
        { src: wasmDir, dest: '' },
      ],
    }),
  ],
  define: {
    __VUE_OPTIONS_API__: false,
    __VUE_PROD_DEVTOOLS__: false,
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url))
    },
    dedupe: [
      'prosemirror-model',
      'prosemirror-state',
      'prosemirror-view',
      'prosemirror-transform',
      'prosemirror-keymap',
      'prosemirror-commands',
      'prosemirror-schema-list',
      'prosemirror-inputrules',
      'prosemirror-history',
      'prosemirror-dropcursor',
      'prosemirror-gapcursor',
      '@codemirror/state',
      '@codemirror/view',
      '@codemirror/language',
      '@codemirror/commands',
      '@codemirror/autocomplete',
      '@codemirror/lint',
      '@codemirror/search',
      '@codemirror/lang-markdown',
      '@lezer/common',
      '@lezer/highlight'
    ],
  },
  css: {
    postcss: {
      plugins: [tailwindcss(), autoprefixer()],
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1422,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1423,
          overlay: false,
        }
      : {
          overlay: false,
        },
    watch: {
      // 3. tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
      // 4. 使用 polling 模式解决路径含空格时 FSEvents 不工作的问题
      usePolling: true,
      interval: 300,
    },
    // Dev-only proxy to bypass CORS for remote MCP providers (ModelScope etc.)
    proxy: {
      // 代理SSE连接
      '/sse-proxy': {
        target: 'https://mcp.api-inference.modelscope.net',
        changeOrigin: true,
        secure: true,
        ws: true,
        rewrite: (path: string) => path.replace(/^\/sse-proxy/, '')
      },
      // 代理POST请求到/messages  
      '/messages': {
        target: 'https://mcp.api-inference.modelscope.net',
        changeOrigin: true,
        secure: true,
        rewrite: (path: string) => {
          // /messages?session_id=xxx -> /messages?session_id=xxx
          // ModelScope接受/messages路径
          console.log('[Vite Proxy] POST to /messages:', path);
          return path;
        },
        configure: (proxy, _options) => {
          // Ensure correct headers for ModelScope messages endpoint
          proxy.on('proxyReq', (proxyReq, req) => {
            try {
              const method = (req.method || 'GET').toUpperCase();
              if (method === 'POST' && /\/(messages|mcp)(?:\?|$|\/)/.test(req.url || '')) {
                proxyReq.setHeader('accept', 'application/json');
                if (!proxyReq.getHeader('content-type')) {
                  proxyReq.setHeader('content-type', 'application/json');
                }
              }
            } catch {}
          });
        }
      },
      // 代理WebSocket连接
      '/ws-proxy': {
        target: 'wss://mcp.api-inference.modelscope.net',
        changeOrigin: true,
        secure: true,
        ws: true,
        rewrite: (path: string) => {
          // /ws-proxy/path -> /path
          console.log('[Vite Proxy] WebSocket:', path);
          return path.replace(/^\/ws-proxy/, '');
        }
      },
      // 代理Streamable HTTP
      '/http-proxy': {
        target: 'https://mcp.api-inference.modelscope.net',
        changeOrigin: true,
        secure: true,
        rewrite: (path: string) => {
          // /http-proxy/path -> /path
          const stripped = path.replace(/^\/http-proxy/, '');
          console.log('[Vite Proxy] Streamable HTTP:', { original: path, stripped });
          return stripped;
        },
        configure: (proxy, _options) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            try {
              const method = (req.method || 'GET').toUpperCase();
              // Streamable HTTP requires specific headers
              if (method === 'GET') {
                // For SSE stream - keep original accept header
                if (!proxyReq.getHeader('accept')) {
                  proxyReq.setHeader('accept', 'text/event-stream');
                }
              } else if (method === 'POST') {
                // For sending messages - Streamable HTTP requires both JSON and event-stream
                // Don't override if client already set it
                const existingAccept = proxyReq.getHeader('accept');
                if (!existingAccept || existingAccept === 'application/json') {
                  // ModelScope requires both for Streamable HTTP
                  proxyReq.setHeader('accept', 'application/json, text/event-stream');
                }
                if (!proxyReq.getHeader('content-type')) {
                  proxyReq.setHeader('content-type', 'application/json');
                }
              }
              console.log(`[Vite Proxy] Streamable HTTP ${method} headers:`, {
                accept: proxyReq.getHeader('accept'),
                'content-type': proxyReq.getHeader('content-type')
              });
            } catch {}
          });
        }
      }
    }
  },
  
  // 配置Web Worker构建选项
  build: {
    // 显式禁用 source map，防止生产包意外暴露源码；请勿移除此行
    sourcemap: false,
    target: 'esnext', // 支持 top-level await 和其他现代 ES 特性
    rollupOptions: {
      external: [],
      output: {
        // 确保动态导入正确处理
        manualChunks: undefined,
      }
    }
  },

  // 优化依赖处理
  optimizeDeps: {
    include: [
      'mustache',
      'dompurify',
      'cmdk',
      'react-hotkeys-hook',
      // Milkdown/Crepe 依赖
      '@milkdown/crepe',
      '@milkdown/kit',
      'prismjs',
    ],
  },

  // Worker配置
  worker: {
    format: 'es',
    rollupOptions: {
      external: []
    }
  }
}));
