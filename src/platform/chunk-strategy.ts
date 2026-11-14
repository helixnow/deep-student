/**
 * 生产构建分包策略（desktop `vite.config.ts` 与 WebUI/PWA `web/vite.config.ts` 共用）。
 *
 * 纯函数：只依赖模块 id 与 Rollup 的 chunk 元信息，不含任何 profile / 入口路径假设，
 * 因此两个构建（同一 `src/main.tsx` 入口）能得到一致的 chunk 图。
 * 从根 `vite.config.ts` 抽出，避免 web 配置在 strict 下 import 根配置
 * （根配置里的若干隐式 nullable 访问在 `web/tsconfig.client.json` 的 strict 下报错）。
 */
import { normalizePath, type Rollup } from 'vite';

function vendorChunkName(id: string): string | undefined {
  // Vite 运行时辅助（__vitePreload / modulepreload polyfill）必须独立成组：
  // 它们被所有含动态 import 的 chunk 静态引用，若被 Rollup 并入
  // vendor-milkdown 之类的重 chunk（实测如此），首屏每个 chunk 都会
  // 静态 import 它 → 整个 milkdown 编辑器被迫随首屏加载。
  if (id.includes('vite/preload-helper') || id.includes('vite/modulepreload-polyfill')) {
    return 'vite-runtime';
  }
  // Rollup 的 CommonJS 辅助模块（\0commonjsHelpers.js）必须落在无依赖的 vendor-react：
  // 不归组时 Rollup 把它交给执行序最靠前、静态依赖它的手动 chunk。别的 CJS vendor 先于 React 执行时，
  // 它落进那个 chunk，vendor-react 反向 import 该 chunk；vendor-micro 这类本身 import React 的随即成环，
  // 求值时 React 尚未初始化（白屏）。
  if (id.includes('commonjsHelpers')) return 'vendor-react';
  if (!id.includes('node_modules')) return;
  // Keep React DOM and its scheduler in one dependency-only chunk.
  // Splitting scheduler into vendor-micro let Rollup place React DOM in
  // vendor-recharts, creating a cycle that invoked scheduler before its
  // CommonJS exports were initialized (startup stuck on the HTML logo).
  if (/node_modules\/(react|react-dom|react-is|scheduler|use-sync-external-store)\//.test(id)) {
    return 'vendor-react';
  }
  // 微型通用库必须显式归组（先于各重库规则）：
  // 否则 manualChunks 函数式的"独占依赖合并"会把 uuid / es-toolkit
  // 卷进 vendor-mermaid / vendor-recharts 等重 chunk——首屏代码
  // 一旦 import 它们（src/utils/shared.ts 就用 uuid），整个重 chunk
  // 会以静态 import 边被拉进首屏。
  if (
    id.includes('node_modules/uuid/') ||
    id.includes('node_modules/es-toolkit/') ||
    id.includes('node_modules/nanoid/') ||
    id.includes('node_modules/dompurify/') ||
    id.includes('node_modules/invariant/') ||
    id.includes('node_modules/tippy.js/') ||
    id.includes('node_modules/react-redux/') ||
    id.includes('node_modules/reselect/') ||
    // tslib：echarts 与 react-remove-scroll（Select / Dialog）共用；不归组时 Rollup 把它放进 vendor-pptx，
    // 任何带下拉框的页面都会顺带下载 1.3MB 的 PPTX 预览与 echarts
    id.includes('node_modules/tslib/') ||
    id.includes('node_modules/redux/') ||
    id.includes('@floating-ui/') ||
    // Phosphor 图标公共底座（IconBase / context）：首屏本就加载；归组后各图标模块
    // 才能整组并入 ui-boot（见 startupBootChunkName）而不把它卷走
    id.includes('@phosphor-icons/react/dist/lib/')
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
}

/**
 * UI 内核启动链（main → import(bootstrap) → import(install)）静态拉入、又被懒加载页面共用的
 * 小模块（图标、命令模块、贡献点）默认会各自成为一个共享 chunk，首屏多出几十个请求。
 * 把它们并成一个 `ui-boot` chunk。入组条件（缺一不可，保证首屏内容与懒加载边界不变、chunk 之间不成环）：
 * - 在 bootstrap / install 的静态闭包里、不在任何构建入口的静态闭包里（首屏本就加载，且不进入口 chunk）；
 * - 不是动态入口（不改变任何 import() 的目标）；
 * - 不在任何 vendor 分组模块的静态闭包里（commonjsHelpers、void-elements 这类被 vendor 包引用的模块）：
 *   vendor chunk 会 import 它所在的 chunk，而 ui-boot 本身 import vendor chunk；
 * - 整个静态依赖树都已入组或属于 vendor 分组——Rollup 会把手动 chunk 的未分组依赖一并卷入，
 *   这一条保证不会把 main 闭包里的模块搬进来。
 * 后两条合起来：ui-boot 只 import vendor chunk，vendor chunk 从不 import ui-boot。环的兜底见 `failOnCircularChunk`。
 */
const startupBootGroups = new WeakMap<Rollup.ManualChunkMeta['getModuleInfo'], Set<string>>();

function startupBootChunkName(id: string, meta: Rollup.ManualChunkMeta): string | undefined {
  let group = startupBootGroups.get(meta.getModuleInfo);
  if (!group) {
    group = computeStartupBootGroup(meta);
    startupBootGroups.set(meta.getModuleInfo, group);
  }
  return group.has(id) ? 'ui-boot' : undefined;
}

/**
 * 延迟加载的语言包（`src/i18n.ts` 的 `import.meta.glob`）不归组时每个 JSON 都是一个
 * 动态入口 → 每种语言约 46 个小 chunk，首屏与切语言时几十个独立请求。
 * WebUI（局域网/公网 RTT 150–250ms）下这些请求几乎完全被往返延迟支配，
 * 按语言合并成 `locales-zh-CN` / `locales-en-US` 两个 chunk。
 * 已同步导入的 `common` / `sidebar` 必须排除（它们在入口静态闭包里）。
 */
const CORE_LOCALE_NAMESPACES = new Set(['common', 'sidebar']);

function localeChunkName(id: string): string | undefined {
  const match = /\/locales\/(zh-CN|en-US)\/([^/]+)\.json$/.exec(normalizePath(id));
  if (!match || CORE_LOCALE_NAMESPACES.has(match[2]!)) return undefined;
  return `locales-${match[1]}`;
}

export interface ManualChunkOptions {
  /**
   * 把延迟加载的语言包按语言并成单个 chunk。
   * 仅 WebUI 构建开启：桌面构建的 chunk 图由 `scripts/plugins/chunk-graph.mjs` 盯住，
   * 保持既有结构不变。
   */
  groupLocaleChunks?: boolean;
  /**
   * 把 WebUI 应用壳的静态闭包按层归成 `app-main` / `workbench-core` / `chat-core`。
   * 仅 `web/vite.config.ts` 开启：桌面构建的 `manualChunks` 不带任何参数，
   * chunk 图由 `scripts/plugins/chunk-graph.mjs` 逐模块对比，必须保持 100% 不变。
   *
   * 为什么 WebUI 需要它（实测 `dist-web/`，同一份源码 A/B 构建）：
   * - `WorkbenchDesktop` 是默认首页，它的静态闭包里约 120 个共享小 chunk（大量 zustand
   *   `create()` 副作用模块，`experimentalMinChunkSize` 不敢合并）：HTTP/1.1 下 6 连接
   *   要排 20 轮 RTT。归组后挂载桌面从 `122` 个请求 / `5.27 MiB` 降到 `11` 个 / `3.46 MiB`。
   * - 打开聊天从几十个共享小 chunk 变成 1 个 `chat-core`（+ 已加载的 `workbench-core`）。
   *
   * 归组规则是「按静态闭包整块认领」，chunk 之间因此是严格 DAG：
   * `vendor-*` ← `entry` ← `{app-main, ui-boot}` ← `workbench-core` ← `chat-core`。
   * 应用壳必须点名成 `app-main`：函数式 `manualChunks` 会把被点名模块的全部静态依赖卷进
   * 同一 chunk（`app-main` 因此比应用壳真正渲染用到的代码多约 870 KB，见
   * `computeWebAppShellGroups`），但放手不管更糟——`workbench-core` / `chat-core` 的隐式
   * 拉取会把应用壳模块吞进那 2.4 MB 的桌面 chunk，首屏就要静态 import 它。
   */
  groupWebAppShell?: boolean;
}

/** WebUI 应用壳分组。顺序即 chunk 之间的层序（后面的只 import 前面的）。 */
const WEB_APP_MAIN_CHUNK = 'app-main';
const WEB_WORKBENCH_CHUNK = 'workbench-core';
const WEB_CHAT_CHUNK = 'chat-core';

const APP_MAIN_MODULE = '/src/main.';
const WORKBENCH_DESKTOP_MODULE = '/src/features/workbench/components/WorkbenchDesktop.';
const CHAT_PAGE_MODULES = ['/src/features/chat/pages/index.', '/src/features/chat/pages/ChatV2Page.'];

export interface WebAppShellGroups {
  appMain: Set<string>;
  workbenchCore: Set<string>;
  chatCore: Set<string>;
}

const webAppShellGroupCache = new WeakMap<Rollup.ManualChunkMeta['getModuleInfo'], WebAppShellGroups>();

function webAppShellChunkName(id: string, meta: Rollup.ManualChunkMeta): string | undefined {
  let groups = webAppShellGroupCache.get(meta.getModuleInfo);
  if (!groups) {
    groups = computeWebAppShellGroups(meta);
    webAppShellGroupCache.set(meta.getModuleInfo, groups);
  }
  if (groups.appMain.has(id)) return WEB_APP_MAIN_CHUNK;
  if (groups.workbenchCore.has(id)) return WEB_WORKBENCH_CHUNK;
  if (groups.chatCore.has(id)) return WEB_CHAT_CHUNK;
  return undefined;
}

/**
 * 静态闭包（只走 `importedIds`，即产物的静态 import 边）。
 * `import()` 不进闭包：动态入口的 chunk 边界一律保持原样。
 */
function staticClosureOf(
  getModuleInfo: Rollup.ManualChunkMeta['getModuleInfo'],
  roots: string[],
): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(getModuleInfo(id)?.importedIds ?? []));
  }
  return seen;
}

/**
 * 计算 WebUI 应用壳的分组（纯函数，可单测）。
 *
 * 不变量（构建期由 `failOnCircularChunk` 兜底，违反即构建失败）：
 * - `app-main` 只 import `vendor-*`；
 * - `workbench-core` 只 import `app-main` / `ui-boot` / `vendor-*`；
 * - `chat-core` 只 import `workbench-core` / `app-main` / `ui-boot` / `vendor-*`；
 * - 任何 `vendor-*` chunk 都不会反向 import 这三个 chunk（它们认领的模块一律避开
 *   `vendorReach`——所有被 vendor 分组模块静态引用的模块）。
 */
export function computeWebAppShellGroups(
  meta: Pick<Rollup.ManualChunkMeta, 'getModuleIds' | 'getModuleInfo'>,
): WebAppShellGroups {
  const { getModuleInfo } = meta;
  const ids = Array.from(meta.getModuleIds());
  const staticClosure = (roots: string[]) => staticClosureOf(getModuleInfo, roots);
  const findIds = (marker: string) => ids.filter((id) => normalizePath(id).includes(marker));

  const vendorReach = staticClosure(ids.filter((id) => vendorChunkName(id)));
  const bootGroup = computeStartupBootGroup(meta);

  /**
   * 不能被应用壳分组认领的模块：
   * - 外部模块 / 构建入口（入口 chunk 必须保持原样）；
   * - 已归 vendor 或会被 vendor chunk 静态引用的（否则 vendor-* ⇄ 应用壳成环）；
   * - 语言包（`locales-*` 自己的分组）；
   * - `ui-boot`（boot 链只向下 import vendor，把它的模块抢过来会让 ui-boot 反向
   *   import 应用壳）。
   */
  const unownable = (id: string) => {
    const info = getModuleInfo(id);
    return (
      !info ||
      info.isExternal ||
      info.isEntry ||
      Boolean(vendorChunkName(id)) ||
      vendorReach.has(id) ||
      bootGroup.has(id) ||
      localeChunkName(id) !== undefined
    );
  };

  /**
   * 固定点剪枝（与 `computeStartupBootGroup` 同一套判据）：只保留静态依赖全部落在
   * 「本组 + 允许的下层 + vendor」里的模块。闭包分组本身已经满足这条，剪枝是兜底：
   * 万一某个模块还指向别的分组，就把它踢出本组（Rollup 会按默认规则安置它），
   * 而不是产出一个成环的 chunk 图。
   */
  const pruneDownwardOnly = (group: Set<string>, allowed: (dep: string) => boolean) => {
    for (let changed = true; changed; ) {
      changed = false;
      for (const id of Array.from(group)) {
        const deps = getModuleInfo(id)?.importedIds ?? [];
        if (deps.some((dep) => !group.has(dep) && !allowed(dep))) {
          group.delete(id);
          changed = true;
        }
      }
    }
    return group;
  };
  const vendorDep = (dep: string) => Boolean(vendorChunkName(dep)) || Boolean(getModuleInfo(dep)?.isExternal);

  // ---- app-main -----------------------------------------------------------
  // WebUI 的应用入口是 `import('virtual:dstu-web-app-entry')`，虚拟模块自己只做
  // 一次静态转发（`import '<repo>/src/main.tsx'`）。把它一并认领，动态 import 才会
  // 直接命中 `app-main.js`，否则首屏多一个「先取转发壳、再取应用」的串行 RTT。
  //
  // 应用壳必须被**点名**（不能留给自动分组）：函数式 `manualChunks` 会把被点名模块的
  // 全部静态依赖卷进同一 chunk，所以 `app-main` 会比应用壳真正渲染用到的代码多一些
  // （实测 4.55 MB 对 3.68 MB，多出来的是「只被懒加载页面用到、在应用壳里被 tree-shake
  // 掉」的部分）。但反过来放手不管更糟：workbench-core / chat-core 的隐式拉取会把
  // 应用壳模块吞进那 2.4 MB 的桌面 chunk，首屏就要静态 import 它。
  const appMainSeeds = new Set(findIds(APP_MAIN_MODULE));
  for (const id of [...appMainSeeds]) {
    for (const importer of getModuleInfo(id)?.importers ?? []) {
      const info = getModuleInfo(importer);
      if (!info || info.isExternal || info.dynamicImporters.length === 0) continue;
      const deps = info.importedIds;
      if (deps.length > 0 && deps.every((dep) => appMainSeeds.has(dep))) appMainSeeds.add(importer);
    }
  }
  const appMain = pruneDownwardOnly(
    new Set(Array.from(staticClosure([...appMainSeeds])).filter((id) => !unownable(id))),
    vendorDep,
  );

  // ---- workbench-core ----------------------------------------------------
  const workbenchClosure = staticClosure(findIds(WORKBENCH_DESKTOP_MODULE));
  const workbenchCore = pruneDownwardOnly(
    new Set(
      Array.from(workbenchClosure).filter(
        (id) => !unownable(id) && !appMain.has(id),
      ),
    ),
    (dep) => appMain.has(dep) || bootGroup.has(dep) || vendorDep(dep),
  );

  // ---- chat-core ---------------------------------------------------------
  // 额外排除「整块 workbench 闭包」：workbench 闭包里落在 workbench-core 之外的模块
  // （动态入口、vendorReach）若被 chat-core 认领，workbench-core 就会静态 import
  // chat-core，同时 chat-core 又 import workbench-core → 环。
  const chatClosure = staticClosure(CHAT_PAGE_MODULES.flatMap(findIds));
  const chatCore = pruneDownwardOnly(
    new Set(
      Array.from(chatClosure).filter(
        (id) => !unownable(id) && !appMain.has(id) && !workbenchClosure.has(id),
      ),
    ),
    (dep) => workbenchCore.has(dep) || appMain.has(dep) || bootGroup.has(dep) || vendorDep(dep),
  );

  return { appMain, workbenchCore, chatCore };
}

export function createManualChunks(options: ManualChunkOptions = {}) {
  const groupLocaleChunks = options.groupLocaleChunks === true;
  const groupWebAppShell = options.groupWebAppShell === true;
  return function manualChunks(id: string, meta: Rollup.ManualChunkMeta): string | undefined {
    return (
      (groupLocaleChunks ? localeChunkName(id) : undefined)
      ?? vendorChunkName(id)
      ?? (groupWebAppShell ? webAppShellChunkName(id, meta) : undefined)
      ?? startupBootChunkName(id, meta)
    );
  };
}

export const manualChunks = createManualChunks();

/**
 * chunk 之间的静态导入环会让模块在它 import 的模块初始化之前求值（ui-boot ⇄ vendor-* 的白屏）。
 * Rollup 对此只给 CIRCULAR_CHUNK 警告，这里改为构建失败。
 */
export function failOnCircularChunk(level: Rollup.LogLevel, log: Rollup.RollupLog, handler: Rollup.LogOrStringHandler): void {
  if (log.code === 'CIRCULAR_CHUNK') throw new Error(`[vite.config] ${log.message}`);
  handler(level, log);
}

export function computeStartupBootGroup({ getModuleIds, getModuleInfo }: Pick<Rollup.ManualChunkMeta, 'getModuleIds' | 'getModuleInfo'>): Set<string> {
  const staticClosure = (roots: string[]) => staticClosureOf(getModuleInfo, roots);
  const ids = Array.from(getModuleIds());
  // 按归一化路径后缀找模块：`findModule` 精确到文件尾，
  // `findIds` 允许带扩展名通配（`/src/main.` → `/src/main.tsx`）。
  const findModule = (suffix: string) => ids.filter((id) => normalizePath(id).endsWith(suffix));
  const findIds = (marker: string) => ids.filter((id) => normalizePath(id).includes(marker));
  // 全部构建入口，不只 main.tsx（演示壳的入口是 demo.html / demo-app.html）。
  // WebUI 的 Rollup 入口是 web/client/entry.ts，它在 bootstrap 完成后才
  // `import('virtual:dstu-web-app-entry')` 动态加载 src/main.tsx——src/main.tsx
  // 因此不在任何入口的静态闭包里，它的静态依赖（首屏本就加载）会被误判成
  // 「懒加载页共享模块」并各自成为共享 chunk / 被并进 ui-boot。
  // 显式把 src/main.* 的静态闭包当作 main 一部分，让 WebUI 与桌面得到一致的 chunk 图。
  const main = staticClosure([
    ...ids.filter((id) => getModuleInfo(id)?.isEntry),
    ...findIds('/src/main.'),
  ]);
  const vendorReach = staticClosure(ids.filter((id) => vendorChunkName(id)));
  const boot = staticClosure([
    ...findModule('/src/ui-kernel/bootstrap.ts'),
    ...findModule('/src/ui-plugins/official/install.ts'),
  ]);
  const group = new Set(
    Array.from(boot).filter((id) => {
      const info = getModuleInfo(id);
      return !main.has(id) && !vendorReach.has(id) && !!info && !info.isExternal &&
        info.dynamicImporters.length === 0 && !info.isEntry;
    }),
  );
  for (let changed = true; changed; ) {
    changed = false;
    for (const id of Array.from(group)) {
      const deps = getModuleInfo(id)?.importedIds ?? [];
      if (deps.some((dep) => !group.has(dep) && !vendorChunkName(dep) && !getModuleInfo(dep)?.isExternal)) {
        group.delete(id);
        changed = true;
      }
    }
  }
  return group;
}
