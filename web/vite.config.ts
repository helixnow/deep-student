import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import react from '@vitejs/plugin-react-swc';
import autoprefixer from 'autoprefixer';
import tailwindcss from 'tailwindcss';
import { defineConfig, normalizePath, searchForWorkspaceRoot, type Plugin } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { createManualChunks, failOnCircularChunk } from '../src/platform/chunk-strategy.ts';
import {
  listOfficialPlugins,
  OFFICIAL_PLUGINS_MODULE,
  OFFICIAL_PLUGINS_VIRTUAL_ID,
  renderOfficialPluginsModule,
  selectOfficialPlugins,
} from '../src/platform/official-plugins.ts';

function resolveWebFsAllow(cwd: string): string[] {
  const roots = [searchForWorkspaceRoot(cwd)];
  try {
    roots.push(fs.realpathSync(path.join(cwd, 'node_modules')));
  } catch (error) {
    void error;
  }
  return roots;
}

const repoRoot = process.cwd();
const webDir = path.join(repoRoot, 'web');
const webPublicDir = path.join(webDir, 'public');

/**
 * 构建先落到 `dist-web.next`，成功后再整目录切换成 `dist-web`。
 *
 * `emptyOutDir` 会先把正在被 `--prod` 实例服务的 `dist-web` 清空，实测约 2 分钟内
 * 首页 404。先写旁路目录再切换，构建失败时旧产物原样可用。
 */
const WEB_DIST_DIR = path.join(repoRoot, 'dist-web');
const WEB_DIST_STAGING_DIR = `${WEB_DIST_DIR}.next`;
const WEB_DIST_PREVIOUS_DIR = `${WEB_DIST_DIR}.prev`;

const require = createRequire(import.meta.url);
const pdfjsDistPath = path.dirname(require.resolve('pdfjs-dist/package.json'));
const cMapsDir = normalizePath(path.join(pdfjsDistPath, 'cmaps'));
const standardFontsDir = normalizePath(path.join(pdfjsDistPath, 'standard_fonts'));
const wasmDir = normalizePath(path.join(pdfjsDistPath, 'wasm'));
const keptCMapGlobs: string[] = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'config', 'pdfjs-local-assets.json'), 'utf8'),
).keptCMapGlobs;

/** `sw.js` 里由构建期替换成真实构建指纹的占位符（源文件在 `web/public/sw.js`）。 */
const WEB_BUILD_HASH_PLACEHOLDER = '__DS_WEB_BUILD_HASH__';

/**
 * 12 位十六进制构建指纹：`dist-web/index.html` 内容 + `dist-web/assets/` 文件名（排序后）。
 * 两者一起覆盖「入口 HTML 引用了哪些 chunk」与「chunk 实际有哪些」，任一变化都会换名。
 */
function computeWebBuildHash(outDir: string): string {
  const hash = createHash('sha256');
  const indexHtml = path.join(outDir, 'index.html');
  if (fs.existsSync(indexHtml)) hash.update(fs.readFileSync(indexHtml));
  const assetsDir = path.join(outDir, 'assets');
  if (fs.existsSync(assetsDir)) {
    hash.update('\0assets\0');
    for (const name of fs.readdirSync(assetsDir).sort()) hash.update(`${name}\0`);
  }
  return hash.digest('hex').slice(0, 12);
}

function excludeMcpDebugProd(): Plugin {
  return {
    name: 'dstu-web-exclude-mcp-debug',
    apply: 'build',
    resolveId(id: string) {
      return id.includes('mcp-debug') ? '\0mcp-debug-noop' : null;
    },
    load(id: string) {
      return id === '\0mcp-debug-noop'
        ? 'export const initMCPDebug = async () => {}; export const registerAllStores = async () => {}; export const destroyMCPDebug = async () => {};'
        : null;
    },
  };
}

function webOfficialPlugins(): Plugin {
  let isProduction = true;
  const targetModule = normalizePath(path.resolve(repoRoot, OFFICIAL_PLUGINS_MODULE)).replace(/\.ts$/, '');
  return {
    name: 'dstu-web-official-ui-plugins',
    apply: 'build',
    enforce: 'pre',
    configResolved(config) {
      isProduction = config.isProduction;
    },
    resolveId(source, importer) {
      if (source === 'virtual:ds-official-plugins') return OFFICIAL_PLUGINS_VIRTUAL_ID;
      if (!importer || !source.startsWith('.')) return null;
      const importerFile = importer.split('?')[0]!;
      const resolved = normalizePath(path.resolve(path.dirname(importerFile), source)).replace(/\.ts$/, '');
      return resolved === targetModule ? OFFICIAL_PLUGINS_VIRTUAL_ID : null;
    },
    load(id) {
      if (id !== OFFICIAL_PLUGINS_VIRTUAL_ID) return null;
      const { included, excluded } = selectOfficialPlugins(listOfficialPlugins(repoRoot), {
        platform: 'desktop',
        production: isProduction,
      });
      for (const p of [...included, ...excluded.map((e) => e.plugin)]) {
        this.addWatchFile(path.join(repoRoot, p.file));
      }
      return renderOfficialPluginsModule(repoRoot, included, excluded.map((e) => e.plugin));
    },
  };
}

function webHtmlAndPwaAssets(): Plugin {
  return {
    name: 'dstu-web-html-and-pwa',
    resolveId(id) {
      return id === 'virtual:dstu-web-app-entry' ? '\0dstu-web-app-entry' : null;
    },
    load(id) {
      return id === '\0dstu-web-app-entry'
        ? `import ${JSON.stringify(path.join(repoRoot, 'src', 'main.tsx'))};`
        : null;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const reqPath = req.url?.split('?')[0] ?? '/';
        if (reqPath === '/manifest.webmanifest' || reqPath === '/sw.js') {
          const filePath = path.join(webPublicDir, reqPath.slice(1));
          if (fs.existsSync(filePath)) {
            res.statusCode = 200;
            res.setHeader(
              'Content-Type',
              reqPath.endsWith('.webmanifest')
                ? 'application/manifest+json; charset=utf-8'
                : 'text/javascript; charset=utf-8',
            );
            res.setHeader('Cache-Control', 'no-cache');
            res.end(fs.readFileSync(filePath));
            return;
          }
        }
        if (reqPath === '/legal/THIRD_PARTY_NOTICES.txt') {
          const notices = path.join(repoRoot, 'legal', 'THIRD_PARTY_NOTICES.txt');
          if (fs.existsSync(notices)) {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.end(fs.readFileSync(notices));
            return;
          }
        }
        if (reqPath === '/' || reqPath === '/index.html') {
          const query = req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
          req.url = `/web/index.html${query}`;
        }
        next();
      });
    },
    writeBundle(options) {
      const outDir = options.dir ?? WEB_DIST_STAGING_DIR;
      const nestedHtml = path.join(outDir, 'web', 'index.html');
      const rootHtml = path.join(outDir, 'index.html');
      if (fs.existsSync(nestedHtml)) {
        fs.renameSync(nestedHtml, rootHtml);
        fs.rmSync(path.join(outDir, 'web'), { recursive: true, force: true });
      }
      for (const file of ['manifest.webmanifest', 'sw.js']) {
        const src = path.join(webPublicDir, file);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, path.join(outDir, file));
        }
      }
      // Service Worker 的缓存名要跟着构建走：每次产物变化都换一个 `ds-webui-shell-v1-<hash>`，
      // 旧缓存由 activate 清掉；否则同名缓存会让客户端继续用上一版壳 + 上一版 chunk 清单。
      const swPath = path.join(outDir, 'sw.js');
      if (fs.existsSync(swPath)) {
        const source = fs.readFileSync(swPath, 'utf8');
        if (source.includes(WEB_BUILD_HASH_PLACEHOLDER)) {
          fs.writeFileSync(
            swPath,
            source.split(WEB_BUILD_HASH_PLACEHOLDER).join(computeWebBuildHash(outDir)),
          );
        }
      }
    },
    closeBundle() {
      // 产物齐了才切换目录；中途失败时 `dist-web` 保持上一版，线上实例不会 404。
      if (!fs.existsSync(WEB_DIST_STAGING_DIR)) return;
      fs.rmSync(WEB_DIST_PREVIOUS_DIR, { recursive: true, force: true });
      if (fs.existsSync(WEB_DIST_DIR)) {
        fs.renameSync(WEB_DIST_DIR, WEB_DIST_PREVIOUS_DIR);
      }
      fs.renameSync(WEB_DIST_STAGING_DIR, WEB_DIST_DIR);
      fs.rmSync(WEB_DIST_PREVIOUS_DIR, { recursive: true, force: true });
    },
  };
}

export default defineConfig({
  root: repoRoot,
  publicDir: path.join(repoRoot, 'public'),
  plugins: [
    excludeMcpDebugProd(),
    webOfficialPlugins(),
    react(),
    webHtmlAndPwaAssets(),
    viteStaticCopy({
      targets: [
        { src: keptCMapGlobs.map((g) => `${cMapsDir}/${g}`), dest: 'cmaps' },
        { src: standardFontsDir, dest: '' },
        { src: [`${wasmDir}/*.wasm`, `${wasmDir}/LICENSE*`], dest: 'wasm' },
        { src: normalizePath(path.join(pdfjsDistPath, 'build', 'pdf.worker.min.mjs')), dest: '' },
        { src: normalizePath(path.join(repoRoot, 'LICENSE')), dest: 'legal', rename: 'DEEPSTUDENT_LICENSE.txt' },
        { src: normalizePath(path.join(repoRoot, 'legal', 'THIRD_PARTY_NOTICES.txt')), dest: 'legal' },
      ],
    }),
  ],
  define: {
    __VUE_OPTIONS_API__: false,
    __VUE_PROD_DEVTOOLS__: false,
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false,
  },
  css: {
    postcss: {
      plugins: [tailwindcss(), autoprefixer()],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(repoRoot, './src'),
    },
    dedupe: [
      'react',
      'react-dom',
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
      '@lezer/highlight',
    ],
  },
  server: {
    fs: {
      allow: resolveWebFsAllow(repoRoot),
    },
    watch: {
      ignored: [
        '**/tmp/**',
        '**/dist/**',
        '**/dist-demo/**',
        '**/dist-web/**',
        '**/.oc-runs/**',
        '**/video/**',
        '**/benchmarks/**',
        '**/node-compile-cache/**',
      ],
    },
  },
  optimizeDeps: {
    entries: ['web/client/entry.ts', 'src/main.tsx'],
    include: [
      'mustache',
      'dompurify',
      'cmdk',
      '@milkdown/crepe',
      '@milkdown/kit',
      'prismjs',
    ],
  },
  worker: {
    format: 'es',
  },
  build: {
    outDir: WEB_DIST_STAGING_DIR,
    emptyOutDir: true,
    reportCompressedSize: false,
    sourcemap: false,
    target: 'esnext',
    rollupOptions: {
      input: path.join(webDir, 'index.html'),
      output: {
        // 与桌面构建共用同一份分包策略（src/platform/chunk-strategy.ts）：
        // 没有它时 Rollup 会把整个应用并进极少数巨型 chunk，构建阶段的
        // render/minify 近似串行，且首屏产物无法长期缓存。
        // WebUI 额外开启两项（桌面构建不传参数，chunk 图保持不变）：
        // - 延迟语言包按语言合并（92 个 JSON → 2 个 chunk）；
        // - 应用壳按层归组 app-main / workbench-core / chat-core：首屏直接命中
        //   app-main.js（不再被匿名共享 chunk 挡在前面）；挂载默认桌面的请求数从
        //   121 降到 12、下载量 5.27 MiB 降到 4.15 MiB；桌面挂载后打开聊天只需
        //   1 个请求（chat-core 93 KB）。
        manualChunks: createManualChunks({ groupLocaleChunks: true, groupWebAppShell: true }),
        // 不加 `onlyExplicitManualChunks`：它让手动 chunk 只装点名模块，会让被漏掉的模块
        // 变成自动 chunk，同时被 vendor chunk 与应用壳引用。实测直接成环、构建失败：
        // `vendor-i18n -> ReviewQuestionsView -> app-main -> vendor-i18n`。
        // 因此保留 Rollup 的隐式拉取（见 `computeWebAppShellGroups` 的闭包式认领）。
        // 不再设置 `experimentalMinChunkSize`：它会把共享小 chunk 并进别的 chunk
        // （实测把 `src/main.tsx` 的动态入口并进 3.7 MiB 的共享 chunk，并把它的
        // `vendor-katex` / `vendor-markdown-shared` 一并拖进首屏），也会把入口 chunk
        // 变成应用 chunk 的静态依赖。请求数问题改由上面的显式分组解决。
      },
      // chunk 之间的静态导入环会让模块在被依赖初始化之前求值（白屏），
      // 与桌面构建一样把 CIRCULAR_CHUNK 从警告升级为构建失败。
      onLog: failOnCircularChunk,
    },
  },
});
