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
      // MPA：demo.html 为纯浏览器演示壳入口（src/demo/main.tsx），
      // 不依赖 Tauri 后端；dev 下直接访问 /demo.html，build 时显式产出。
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        demo: fileURLToPath(new URL("./demo.html", import.meta.url)),
        // WorkBuddy 风格落地页：Mac 窗壳居中内嵌 demo.html（纯静态，无 JS bundle）
        hero: fileURLToPath(new URL("./hero.html", import.meta.url)),
        "preview-charts": fileURLToPath(new URL("./preview-charts.html", import.meta.url)),
      },
      output: {
        // 🚀 P1-4 性能优化：手动分包策略，将 vendor 依赖分离为独立的长期缓存 chunk
        // 大库（mermaid / exceljs / echarts / recharts / xyflow）多为路由级 lazy 或按需动态 import；
        // 独立 chunk 避免打进主包并利于长期缓存。
        manualChunks(id: string) {
          // Vite 运行时辅助（__vitePreload / modulepreload polyfill）必须独立成组：
          // 它们被所有含动态 import 的 chunk 静态引用，若被 Rollup 并入
          // vendor-milkdown 之类的重 chunk（实测如此），首屏每个 chunk 都会
          // 静态 import 它 → 整个 milkdown 编辑器被迫随首屏加载。
          if (id.includes('vite/preload-helper') || id.includes('vite/modulepreload-polyfill')) {
            return 'vite-runtime';
          }
          if (!id.includes('node_modules')) return;
          // 微型通用库必须显式归组（先于各重库规则）：
          // 否则 manualChunks 函数式的"独占依赖合并"会把 uuid / es-toolkit
          // 卷进 vendor-mermaid / vendor-recharts 等重 chunk——首屏代码
          // 一旦 import 它们（src/utils/shared.ts 就用 uuid），整个重 chunk
          // 会以静态 import 边被拉进首屏。
          if (
            id.includes('node_modules/uuid/') ||
            id.includes('node_modules/es-toolkit/') ||
            id.includes('node_modules/scheduler/') ||
            id.includes('node_modules/nanoid/') ||
            id.includes('node_modules/dompurify/') ||
            id.includes('node_modules/invariant/') ||
            id.includes('node_modules/tippy.js/') ||
            id.includes('node_modules/use-sync-external-store/') ||
            id.includes('node_modules/react-redux/') ||
            id.includes('node_modules/reselect/') ||
            id.includes('node_modules/redux/') ||
            id.includes('@floating-ui/')
          ) {
            return 'vendor-micro';
          }
          // d3 家族必须独立：@xyflow/react（聊天思维导图卡片，首屏正当需求）
          // 与 recharts（懒加载统计图）共用 d3-*——不拆出来 d3 会被并入
          // vendor-recharts，xyflow 一加载就把整个 recharts 拖进首屏。
          if (id.includes('node_modules/d3-')) {
            return 'vendor-d3';
          }
          // i18n
          if (id.includes('i18next') || id.includes('react-i18next')) {
            return 'vendor-i18n';
          }
          if (id.includes('pdfjs-dist')) {
            return 'vendor-pdfjs';
          }
          // mermaid 图表库本体（refractor/lang/mermaid.js 只是 2KB 语法高亮规则，
          // 必须排除——否则它落入本 chunk，会把 6MB+ 的 mermaid 拽进聊天代码块的首屏静态图）
          if (id.includes('mermaid') && !id.includes('refractor')) {
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
          // Markdown 处理生态 + 微型工具库：chat 的 react-markdown 渲染与
          // milkdown 编辑器共用同一套 unified/mdast/micromark/vfile——
          // 此规则必须在 milkdown 规则之后、且不匹配它们会触发 Rollup 的
          // "独占依赖合并"把它们卷进 vendor-milkdown，导致首屏为聊天渲染
          // 被迫加载 4MB+ 的 milkdown 编辑器本体。
          if (
            id.includes('lodash-es') ||
            id.includes('node_modules/clsx') ||
            id.includes('node_modules/immer') ||
            /node_modules\/(unified|remark-|rehype-|mdast|hast|micromark|vfile|zwitch|bail|trough|devlop|comma-separated-tokens|property-information|space-separated-tokens|decode-named-character-reference|character-entities)/.test(id)
          ) {
            return 'vendor-markdown-shared';
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
