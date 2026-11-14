import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { defineConfig, normalizePath, searchForWorkspaceRoot, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
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
import {
  listOfficialPlugins,
  OFFICIAL_PLUGINS_MODULE,
  OFFICIAL_PLUGINS_VIRTUAL_ID,
  renderOfficialPluginsModule,
  selectOfficialPlugins,
  targetPlatform,
} from "./src/platform/official-plugins";
import { failOnCircularChunk, manualChunks } from "./src/platform/chunk-strategy";

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

/**
 * WI-9 legal 去重：THIRD_PARTY_NOTICES.txt 权威路径为仓库根 legal/，
 * 只经 tauri bundle.resources 进安装包（resources/licenses/），不再进 dist。
 * 纯 web dev（无 Tauri resources）由本中间件按原 fetch 路径代理到权威文件。
 */
function legalNoticesDevPlugin(): Plugin {
  return {
    name: "serve-legal-notices-from-repo-root",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/legal/THIRD_PARTY_NOTICES.txt", (_req, res) => {
        const noticesPath = path.join(server.config.root, "legal", "THIRD_PARTY_NOTICES.txt");
        if (!fs.existsSync(noticesPath)) {
          res.statusCode = 404;
          res.end("THIRD_PARTY_NOTICES.txt not generated. Run npm run licenses:generate.");
          return;
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(fs.readFileSync(noticesPath));
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

// dev server 文件服务白名单（server.fs.allow）。
// Vite 默认只放行工作区根目录；CSS url() 引用的资源（KaTeX 字体等）不在模块图的
// "安全路径"里，必须落在白名单内才会被 serve。git worktree / 临时检出常把
// node_modules 软链到主仓库：Vite 解析软链后字体 URL 变成 /@fs/<主仓库>/node_modules/…，
// 落在白名单外 → 403 → KaTeX_Main/Math/AMS 全部加载失败，公式退回 Times New Roman，
// \neq / \not 叠加用的私有区字形 U+E020 变成方框（"F′(x) ⊟0"）。
// 把 node_modules 的真实路径加进白名单；显式设置 allow 会替换默认值，故保留工作区根。
export function resolveDevServerFsAllow(cwd: string): string[] {
  const roots = [searchForWorkspaceRoot(cwd)];
  try {
    roots.push(fs.realpathSync(path.join(cwd, 'node_modules')));
  } catch {
    // node_modules 不存在：保持默认白名单
  }
  return roots;
}

// cmaps 保守子集（R2 裁剪，详见 docs/dev/optimization0824/progress/R2-pdfjs-subset.md）：
// 全量 169 个文件 1.11 MB → 68 个 0.59 MB。保留简中 GB 全系（核心场景）、
// 繁中/日/韩的现代 Unicode 编码（UCS2/UTF16）、Adobe registry 系列
// （其中 *-UCS2 是 Identity 编码 CID 字体复制/搜索的 ToUnicode 依赖）。
// 裁掉非 GB 的遗留编码（RKSJ/EUC/B5/HK/KSC 等）与罕见 UTF8/UTF32 变体：
// R4 起命中子集外的 cmap 时经 src/utils/pdfAssets.ts 三级 fallback
//（本地 → appData 缓存 → 预留远程源）补齐，全部落空才记缺字日志并跳过该字体。
// 白名单清单与守卫测试（tests/vitest/pdf/）共用 config/pdfjs-local-assets.json。
const keptCMapGlobs: string[] = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'config', 'pdfjs-local-assets.json'), 'utf8'),
).keptCMapGlobs;
/**
 * 分包策略（manualChunks / failOnCircularChunk / computeStartupBootGroup）在
 * `src/platform/chunk-strategy.ts`，桌面构建与 WebUI/PWA 构建共用同一份规则。
 * 这里保留同名 re-export：现有测试与脚本仍从 `vite.config.ts` 引入。
 */
export { computeStartupBootGroup, failOnCircularChunk, manualChunks } from './src/platform/chunk-strategy';

/**
 * FE-A5：构建时的官方 UI 插件表。`src/ui-plugins/official/plugins.ts`（遍历全部插件目录）在构建中换成虚拟模块
 * `virtual:ds-official-plugins`，只静态导入 `meta.platforms` 含 `VITE_DS_PLATFORM`（缺省 desktop）的插件，生产构建
 * 另外去掉 `meta.devOnly` 的插件，别的平台专属插件目录因此不进包。dev server 不替换（HMR 照常，内核运行时跳过）。
 * 去掉的插件只留一个元数据桩（`excludedOfficialUiPlugins`），内核照样把它记为已跳过。
 */
function officialUiPluginsPlugin(): Plugin {
  let root = process.cwd();
  let production = true;
  return {
    name: 'ds-official-ui-plugins',
    apply: 'build',
    enforce: 'pre',
    configResolved(config) {
      root = config.root;
      production = config.isProduction;
    },
    resolveId(source, importer) {
      if (source === 'virtual:ds-official-plugins') return OFFICIAL_PLUGINS_VIRTUAL_ID;
      if (!importer || !source.startsWith('.')) return null;
      const target = normalizePath(path.resolve(path.dirname(importer.split('?')[0]), source)).replace(/\.ts$/, '');
      return target === normalizePath(path.join(root, OFFICIAL_PLUGINS_MODULE)).replace(/\.ts$/, '') ? OFFICIAL_PLUGINS_VIRTUAL_ID : null;
    },
    load(id) {
      if (id !== OFFICIAL_PLUGINS_VIRTUAL_ID) return null;
      const platform = targetPlatform(process.env.VITE_DS_PLATFORM);
      const { included, excluded } = selectOfficialPlugins(listOfficialPlugins(root), { platform, production });
      for (const { plugin } of excluded) this.addWatchFile(path.join(root, plugin.file));
      for (const plugin of included) this.addWatchFile(path.join(root, plugin.file));
      return renderOfficialPluginsModule(root, included, excluded.map(({ plugin }) => plugin));
    },
  };
}

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
    officialUiPluginsPlugin(),
    react(),
    workbenchInteractionTracePlugin(),
    legalNoticesDevPlugin(),
    viteStaticCopy({
      targets: [
        // worker 唯一权威来源 = node_modules/pdfjs-dist/build（与主库版本永远一致）。
        // public/ 不再保留手工同步副本，升级 pdfjs-dist 时不会再静默过期
        //（版本不匹配会报 API version mismatch）。入口仍是 public/pdf.worker.wrapper.mjs
        //（Promise.withResolvers polyfill 包装），其 import './pdf.worker.min.mjs'
        // 解析到本 target 拷贝的文件。
        { src: normalizePath(path.join(pdfjsDistPath, 'build', 'pdf.worker.min.mjs')), dest: '' },
        // glob src 会拍平文件，dest 需显式指向目标目录（与整目录拷贝语义不同）
        { src: keptCMapGlobs.map((g) => `${cMapsDir}/${g}`), dest: 'cmaps' },
        // standard_fonts 整目录保留：Foxit .pfb 承载非嵌入 Times/Courier/Symbol/
        // ZapfDingbats（PDF 标准 14 字体，出现频率高），裁掉仅省 ~196 KB 不划算
        { src: standardFontsDir, dest: '' },
        // 只拷贝 .wasm + LICENSE，裁掉 452 KB 的 openjpeg_nowasm_fallback.js：
        // 该 JS 回退仅在 WebAssembly.instantiate 失败或显式 useWasm:false 时动态
        // import，Tauri WebView（WebKit/WebView2/Android Chromium）均支持 WASM
        { src: [`${wasmDir}/*.wasm`, `${wasmDir}/LICENSE*`], dest: 'wasm' },
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
    fs: {
      allow: resolveDevServerFsAllow(process.cwd()),
    },
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
      // 以及仓库根下的生成/产物目录（开轮询时监听集合里每个文件都会被周期性 stat；
      // tmp/ 曾堆积 ~89 万个基准测试产物，轮询直接占满 dev server 主线程）。
      ignored: [
        "**/tmp/**",
        "**/dist/**",
        "**/dist-demo/**",
        "**/video/**",
        "**/benchmarks/**",
        "**/node-compile-cache/**",
      ],
      // 4. 默认使用原生文件监听（macOS FSEvents / Linux inotify）。
      //    usePolling 会对整个仓库按 interval 全量轮询，是 dev/HMR 最大的开销来源；
      //    仓库路径含空格时原生监听会失效，自动回退轮询；VITE_USE_POLLING=1/0 可显式覆盖。
      usePolling: process.env.VITE_USE_POLLING
        ? process.env.VITE_USE_POLLING === '1'
        : process.cwd().includes(' '),
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
    // Bundle 体积门禁会在构建后自行以 gzip(level 9) 统计产物，
    // 无需让 Vite 重复计算压缩体积。
    reportCompressedSize: false,
    // 仅在发布流水线明确准备上传时生成 hidden source map。
    // 上传脚本成功后会删除 .map，避免源码随 Tauri 安装包分发。
    sourcemap:
      mode === 'production' && process.env.SENTRY_UPLOAD_SOURCEMAPS === '1'
        ? 'hidden'
        : false,
    target: 'esnext', // 支持 top-level await 和其他现代 ES 特性
    rollupOptions: {
      external: [],
      // 桌面生产构建只产出主应用。纯浏览器 demo/hero 由
      // vite.demo.config.ts 的独立构建负责，避免拖慢常规生产构建。
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
      },
      output: {
        // 🚀 P1-4 性能优化：手动分包策略，将 vendor 依赖分离为独立的长期缓存 chunk
        // 大库（mermaid / exceljs / echarts / recharts / xyflow）多为路由级 lazy 或按需动态 import；
        // 独立 chunk 避免打进主包并利于长期缓存。
        manualChunks,
      },
      onLog: failOnCircularChunk,
    }
  },

  // 优化依赖处理
  optimizeDeps: {
    include: [
      'mustache',
      'dompurify',
      'cmdk',
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
