import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { defineConfig, normalizePath, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { visualizer } from "rollup-plugin-visualizer";
// Explicit PostCSS config to ensure Tailwind is applied even if auto-detection fails
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import tailwindcss from "tailwindcss";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import autoprefixer from "autoprefixer";

/**
 * OS 模式交互延迟落盘：POST/GET `/__wb_interaction_trace`
 * → 仓库 `.tmp/wb-interaction-trace.json`（人看 DevPanel，代理读文件）。
 */
function workbenchInteractionTracePlugin(): Plugin {
  const dumpRel = path.join(".tmp", "wb-interaction-trace.json");
  return {
    name: "wb-interaction-trace",
    configureServer(server) {
      server.middlewares.use("/__wb_interaction_trace", (req, res, next) => {
        const dumpPath = path.join(server.config.root, dumpRel);
        if (req.method === "GET") {
          try {
            if (!fs.existsSync(dumpPath)) {
              res.statusCode = 404;
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              res.end(JSON.stringify({ error: "no_trace_yet", path: dumpRel }));
              return;
            }
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(fs.readFileSync(dumpPath, "utf8"));
          } catch (err) {
            res.statusCode = 500;
            res.end(String(err));
          }
          return;
        }
        if (req.method === "POST" || req.method === "PUT") {
          const chunks: Buffer[] = [];
          req.on("data", (c) => {
            chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
          });
          req.on("end", () => {
            try {
              fs.mkdirSync(path.dirname(dumpPath), { recursive: true });
              const body = Buffer.concat(chunks).toString("utf8") || "{}";
              // 校验 JSON，避免写坏文件
              JSON.parse(body);
              fs.writeFileSync(dumpPath, body, "utf8");
              res.statusCode = 204;
              res.end();
            } catch (err) {
              res.statusCode = 400;
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              res.end(JSON.stringify({ error: String(err) }));
            }
          });
          return;
        }
        next();
      });
    },
  };
}

function removeSourceMaps(directory: string): void {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      removeSourceMaps(entryPath);
    } else if (entry.name.endsWith('.map')) {
      fs.rmSync(entryPath, { force: true });
    }
  }
}

function runSentryCli(args: string[]): void {
  if (process.platform === 'win32') {
    execFileSync('cmd.exe', ['/d', '/s', '/c', 'sentry-cli', ...args], { stdio: 'inherit' });
    return;
  }
  execFileSync('sentry-cli', args, { stdio: 'inherit' });
}

/**
 * 上传必须发生在 Vite build 完成、Tauri 开始打包 frontendDist 之前。
 * 无论上传成功与否都删除 .map；失败会让 beforeBuildCommand 失败，避免泄漏源码。
 */
function sentrySourceMapUploadPlugin(): Plugin {
  return {
    name: 'upload-sentry-sourcemaps-before-tauri-package',
    apply: 'build',
    enforce: 'post',
    closeBundle() {
      const distDir = path.resolve(process.cwd(), 'dist');
      const required = ['SENTRY_AUTH_TOKEN', 'SENTRY_ORG', 'SENTRY_PROJECT'];
      const missing = required.filter(key => !process.env[key]);
      if (missing.length > 0) {
        removeSourceMaps(distDir);
        throw new Error(`Source map upload requested but missing: ${missing.join(', ')}`);
      }
      try {
        const release =
          process.env.SENTRY_RELEASE ||
          execFileSync(
            process.execPath,
            [path.resolve(process.cwd(), 'scripts/generate-version.mjs'), '--print-sentry-release'],
            { encoding: 'utf8' },
          ).trim();
        runSentryCli(['sourcemaps', 'inject', distDir]);
        runSentryCli(['sourcemaps', 'upload', '--release', release, distDir]);
      } finally {
        removeSourceMaps(distDir);
      }
    },
  };
}

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
    workbenchInteractionTracePlugin(),
    viteStaticCopy({
      targets: [
        { src: cMapsDir, dest: '' },
        { src: standardFontsDir, dest: '' },
        { src: wasmDir, dest: '' },
        { src: normalizePath(path.join(process.cwd(), 'LICENSE')), dest: 'legal', rename: 'DEEPSTUDENT_LICENSE.txt' },
      ],
    }),
    process.env.ANALYZE === '1' && visualizer({
      filename: 'dist/bundle-report.html',
      template: 'treemap',
      gzipSize: true,
      brotliSize: false,
      open: false,
    }),
    process.env.SENTRY_UPLOAD_SOURCEMAPS === '1' && sentrySourceMapUploadPlugin(),
  ].filter(Boolean) as any,
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
    // Tauri's macOS WebView resolves the dev URL through IPv4 on this host.
    // Bind the fallback explicitly so it can reach http://localhost:1422.
    host: host || '127.0.0.1',
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
    // 仅在发布流水线明确准备上传时生成 hidden source map。
    // 上传脚本成功后会删除 .map，避免源码随 Tauri 安装包分发。
    sourcemap:
      mode === 'production' && process.env.SENTRY_UPLOAD_SOURCEMAPS === '1'
        ? 'hidden'
        : false,
    target: 'esnext', // 支持 top-level await 和其他现代 ES 特性
    rollupOptions: {
      external: [],
      output: {
        // 🚀 P1-4 性能优化：手动分包策略，将 vendor 依赖分离为独立的长期缓存 chunk
        // 大库（mermaid / exceljs / echarts / recharts / xyflow）多为路由级 lazy 或按需动态 import；
        // 独立 chunk 避免打进主包并利于长期缓存。
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return;
          // i18n
          if (id.includes('i18next') || id.includes('react-i18next')) {
            return 'vendor-i18n';
          }
          if (id.includes('pdfjs-dist')) {
            return 'vendor-pdfjs';
          }
          if (id.includes('mermaid')) {
            return 'vendor-mermaid';
          }
          // Excel 预览（RichDocumentPreview → lazy XlsxPreview）
          if (id.includes('node_modules/exceljs') || id.includes('/exceljs/')) {
            return 'vendor-exceljs';
          }
          // PPTX 预览及其依赖 echarts（pptx-preview → echarts）
          if (
            id.includes('pptx-preview') ||
            id.includes('node_modules/echarts') ||
            id.includes('/echarts/')
          ) {
            return 'vendor-pptx';
          }
          // DOCX 预览
          if (id.includes('docx-preview')) {
            return 'vendor-docx';
          }
          // 图表（仪表盘 / LLM usage / stats）
          if (id.includes('node_modules/recharts') || id.includes('/recharts/')) {
            return 'vendor-recharts';
          }
          // 导图画布（mindmap 路由 lazy 加载）
          if (id.includes('@xyflow/')) {
            return 'vendor-xyflow';
          }
          // Provider 品牌图标（@lobehub/icons，传递依赖 lucide-react）
          if (id.includes('@lobehub/icons') || id.includes('lucide-react')) {
            return 'vendor-lobehub-icons';
          }
          // KaTeX（chat markdown / mindmap LaTeX 渲染共用，~270KB）
          if (id.includes('node_modules/katex') || id.includes('rehype-katex')) {
            return 'vendor-katex';
          }
          // Milkdown 编辑器全家桶（仅笔记编辑场景加载）
          if (id.includes('@milkdown') || id.includes('milkdown') || id.includes('prosemirror')) {
            return 'vendor-milkdown';
          }
        },
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
