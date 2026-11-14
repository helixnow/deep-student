/**
 * `vite build --mode app`（以及 `vite --mode app`）额外的配置：把仓库根的完整 React 前端（`src/main.tsx`）打进移动端外壳。
 *
 * 只在 app 模式下由 `mobile/vite.config.ts` 动态导入，诊断 / 默认构建和启动测试不加载这里的依赖。
 * 与根 `vite.config.ts` 对齐的部分：React（SWC）、`@` 别名与 dedupe、Tailwind + Autoprefixer、构建期官方 UI 插件表
 * （`VITE_DS_PLATFORM=mobile`）、生产构建去掉 mcp-debug、PDF.js 资源拷贝、根 `public/`。不从根配置导入：
 * 它在模块顶层按 `process.cwd()` 读文件，从 `mobile/` 运行会失败。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import react from '@vitejs/plugin-react-swc';
import autoprefixer from 'autoprefixer';
import tailwindcss from 'tailwindcss';
import { normalizePath, type Plugin, type UserConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import {
  listOfficialPlugins,
  OFFICIAL_PLUGINS_MODULE,
  OFFICIAL_PLUGINS_VIRTUAL_ID,
  renderOfficialPluginsModule,
  selectOfficialPlugins,
} from '../src/platform/official-plugins.ts';

/** 移动端的 UI 平台（`src/ui-kernel/meta.ts` `UI_PLATFORMS`）。 */
export const APP_PLATFORM = 'mobile';

/** 根 `vite.config.ts` 的 `officialUiPluginsPlugin`，平台固定为 mobile、源码根固定为仓库根。 */
function officialUiPlugins(repo: string): Plugin {
  let production = true;
  const module = normalizePath(join(repo, OFFICIAL_PLUGINS_MODULE)).replace(/\.ts$/, '');
  return {
    name: 'dstu-mobile-official-ui-plugins',
    apply: 'build',
    enforce: 'pre',
    configResolved(config) {
      production = config.isProduction;
    },
    resolveId(source, importer) {
      if (source === 'virtual:ds-official-plugins') return OFFICIAL_PLUGINS_VIRTUAL_ID;
      if (!importer || !source.startsWith('.')) return null;
      const target = normalizePath(join(dirname(importer.split('?')[0]!), source)).replace(/\.ts$/, '');
      return target === module ? OFFICIAL_PLUGINS_VIRTUAL_ID : null;
    },
    load(id) {
      if (id !== OFFICIAL_PLUGINS_VIRTUAL_ID) return null;
      const { included, excluded } = selectOfficialPlugins(listOfficialPlugins(repo), { platform: APP_PLATFORM, production });
      for (const plugin of [...included, ...excluded.map(entry => entry.plugin)]) this.addWatchFile(join(repo, plugin.file));
      return renderOfficialPluginsModule(repo, included, excluded.map(entry => entry.plugin));
    },
  };
}

/** 生产构建把 mcp-debug（调试代码）换成空实现（同根配置）。 */
function excludeMcpDebug(): Plugin {
  return {
    name: 'dstu-mobile-exclude-mcp-debug',
    apply: 'build',
    resolveId: id => (id.includes('mcp-debug') ? '\0mcp-debug-noop' : null),
    load: id => (id === '\0mcp-debug-noop'
      ? 'export const initMCPDebug = async () => {}; export const registerAllStores = async () => {}; export const destroyMCPDebug = () => {};'
      : null),
  };
}

/** 构建与开发服务器都以 `app.html` 作为 `index.html`（Capacitor 的 webDir 入口固定是 index.html）。 */
function appHtml(mobile: string): Plugin {
  return {
    name: 'dstu-mobile-app-html',
    resolveId: id => id === 'virtual:dstu-app-entry' ? '\0dstu-app-entry' : null,
    load: id => id === '\0dstu-app-entry' ? `import ${JSON.stringify(join(mobile, '../src/main.tsx'))};` : null,
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url === '/' || req.url?.startsWith('/index.html') || req.url?.startsWith('/?')) req.url = `/app.html${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`;
        next();
      });
    },
    // HTML 由 Vite 的 build-html 插件在本插件之后产出，这里等写盘后再改名。
    writeBundle(options) {
      const dir = options.dir ?? join(mobile, 'dist');
      if (existsSync(join(dir, 'app.html'))) renameSync(join(dir, 'app.html'), join(dir, 'index.html'));
    },
  };
}

/**
 * `src/version.ts` 由 `scripts/generate-version.mjs` 生成（已 gitignore）。缺失时先跑一次生成器；生成器在浅克隆 /
 * worktree 里可能因缺少 git 基线失败（未设 `DEEP_STUDENT_BUILD_NUMBER`），这时以 package.json 版本号、build 0
 * 提供同形状的虚拟模块并打警告，不落盘。
 */
function versionInfo(repo: string): Plugin {
  const file = join(repo, 'src/version.ts');
  const id = '\0dstu-mobile-version';
  let fallback: string | null = null;
  return {
    name: 'dstu-mobile-version',
    enforce: 'pre',
    buildStart() {
      if (existsSync(file)) return;
      try {
        execFileSync(process.execPath, [join(repo, 'scripts/generate-version.mjs')], { cwd: repo, stdio: 'pipe' });
      } catch (error) {
        const version = (JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { version: string }).version;
        const reason = String((error as { stderr?: Buffer }).stderr ?? error).split('\n').find(line => line.startsWith('Error')) ?? 'generator failed';
        this.warn(`src/version.ts could not be generated (${reason}); using ${version} build 0`);
        fallback = `export const VERSION_INFO = { APP_VERSION: ${JSON.stringify(version)}, BUILD_NUMBER: '0', GIT_HASH: 'unknown', FULL_VERSION: ${JSON.stringify(`${version} (0)`)}, SENTRY_RELEASE: ${JSON.stringify(`deep-student@${version}+0`)} };\nexport default VERSION_INFO;\n`;
      }
    },
    resolveId(source, importer) {
      if (fallback === null) return null;
      const target = normalizePath(file).replace(/\.ts$/, '');
      if (source === '@/version' || normalizePath(source).replace(/\.ts$/, '') === target) return id;
      if (!importer || !source.startsWith('.')) return null;
      return normalizePath(join(dirname(importer.split('?')[0]!), source)).replace(/\.ts$/, '') === target ? id : null;
    },
    load: source => (source === id ? fallback : null),
  };
}

function pdfAssets(repo: string): Plugin[] {
  const require = createRequire(join(repo, 'package.json'));
  const pdfjs = dirname(require.resolve('pdfjs-dist/package.json'));
  const cmaps = normalizePath(join(pdfjs, 'cmaps'));
  const wasm = normalizePath(join(pdfjs, 'wasm'));
  const kept = (JSON.parse(readFileSync(join(repo, 'config/pdfjs-local-assets.json'), 'utf8')) as { keptCMapGlobs: string[] }).keptCMapGlobs;
  // Root frontend plugin and mobile Vite have separate (nominal Rollup) type identities.
  return viteStaticCopy({
    targets: [
      { src: normalizePath(join(pdfjs, 'build/pdf.worker.min.mjs')), dest: '' },
      { src: kept.map(glob => `${cmaps}/${glob}`), dest: 'cmaps' },
      { src: normalizePath(join(pdfjs, 'standard_fonts')), dest: '' },
      { src: [`${wasm}/*.wasm`, `${wasm}/LICENSE*`], dest: 'wasm' },
      { src: normalizePath(join(repo, 'LICENSE')), dest: 'legal', rename: 'DEEPSTUDENT_LICENSE.txt' },
      { src: normalizePath(join(repo, 'legal/THIRD_PARTY_NOTICES.txt')), dest: 'legal' },
    ],
  }) as unknown as Plugin[];
}

export function appConfig(mobile: string, repo: string): UserConfig {
  // tailwind.config.js 是 CommonJS（根 package.json 为 type: module，不能 import）；用 Tailwind 自己的加载器读。
  const loadConfig = createRequire(join(repo, 'package.json'))('tailwindcss/loadConfig') as (file: string) => { content: string[] };
  const tailwindConfig = loadConfig(join(repo, 'tailwind.config.js'));
  // Tailwind 的 content 是相对仓库根的 glob；从 mobile/ 运行时换成绝对路径（`!` 排除项保留前缀）。
  const content = tailwindConfig.content.map(glob => (glob.startsWith('!') ? `!${join(repo, glob.slice(1))}` : join(repo, glob)));
  return {
    publicDir: join(repo, 'public'),
    // Frontend plugins use the root's Vite types; mobile has an isolated Vite/Rollup install.
    plugins: [versionInfo(repo), officialUiPlugins(repo), excludeMcpDebug(), react() as unknown as Plugin[], appHtml(mobile), ...pdfAssets(repo)],
    define: {
      'import.meta.env.VITE_DS_PLATFORM': JSON.stringify(APP_PLATFORM),
      __VUE_OPTIONS_API__: false,
      __VUE_PROD_DEVTOOLS__: false,
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false,
    },
    resolve: {
      alias: [{ find: /^@\//, replacement: `${join(repo, 'src')}/` }],
      dedupe: [
        'react', 'react-dom',
        'prosemirror-model', 'prosemirror-state', 'prosemirror-view', 'prosemirror-transform', 'prosemirror-keymap',
        'prosemirror-commands', 'prosemirror-schema-list', 'prosemirror-inputrules', 'prosemirror-history',
        'prosemirror-dropcursor', 'prosemirror-gapcursor',
        '@codemirror/state', '@codemirror/view', '@codemirror/language', '@codemirror/commands', '@codemirror/autocomplete',
        '@codemirror/lint', '@codemirror/search', '@codemirror/lang-markdown', '@lezer/common', '@lezer/highlight',
      ],
    },
    css: {
      postcss: { plugins: [tailwindcss({ ...tailwindConfig, content }), autoprefixer()] } as unknown as NonNullable<UserConfig['css']>['postcss'],
    },
    build: {
      target: 'es2022',
      reportCompressedSize: false,
      chunkSizeWarningLimit: 4096,
    },
  };
}
