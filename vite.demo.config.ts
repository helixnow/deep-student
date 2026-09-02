/**
 * Web 演示壳专用 Vite 配置（瘦身构建）
 *
 * 与主配置的差异：
 * 1. 仅构建 demo.html 入口（不含桌面主入口），输出到 dist-demo/
 * 2. 通过 build.modulePreload.resolveDependencies 阻止首屏预载重型 chunk：
 *    milkdown（笔记编辑器）/ mermaid / pptx / exceljs / docx / pdfjs /
 *    recharts / xyflow / heic2any 等仅在"附件预览、图表统计、笔记、
 *    思维导图"等非会话场景用到，lazy 视图真正打开时仍会动态加载——
 *    功能零损失，仅砍掉首屏预载。
 *    会话链路（markdown / KaTeX / 代码高亮 / 流式渲染）完整保留。
 *
 * 用法：
 *   npm run dev:demo    # 开发（端口 1423）
 *   npm run build:demo  # 构建到 dist-demo/
 */

import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import baseConfig from "./vite.config";

/**
 * Demo 专用模块入口 stub（功能模块级，形状简单不易崩；生产代码零改动）
 *
 * 背景：App.tsx 静态引入 workbench AgentBridge → bridge → drivers/index
 * → noteDriver(@milkdown)/mindmapDriver(@xyflow)，把笔记编辑器/导图画布
 * 拖进主 bundle；DialogControlContext 挂载时动态 import mcpService。
 * 演示壳用经典模式（workbenchMode=false），AgentBridge 必然空转，
 * MCP 会话工具在剧本会话中不使用，stub 掉功能等价。
 */
const DEMO_MODULE_STUBS: Array<{ test: RegExp; code: string; label: string }> = [
  {
    label: "AgentBridge",
    test: /features[\/]workbench[\/]agent[\/]AgentBridge(\.tsx?)?$/,
    code: "export const AgentBridge = () => null;\nexport default AgentBridge;\n",
  },
  {
    label: "mcpService",
    test: /[\/]mcp[\/]mcpService(\.ts)?$/,
    code: [
      "const noop = () => {};",
      "export const McpService = {",
      "  listTools: async () => [],",
      "  status: async () => ({ servers: [] }),",
      "  onStatus: () => noop,",
      "  callTool: async () => { throw new Error('[demo] MCP disabled'); },",
      "};",
      "export default McpService;",
      "",
    ].join("\n"),
  },
  {
    // stageManager 静态拉起 bridge → drivers → noteDriver(@milkdown)/mindmapStore(@xyflow)。
    // 演示壳（经典壳、剧本会话无 workbench-ops 块）永不执行这些路径；
    // chat 的 workbenchOpsBlock 仅在渲染工作台操作块时才调用这三个方法。
    label: "stageManager",
    test: /features[\/]workbench[\/]agent[\/]stageManager(\.ts)?$/,
    code: [
      "export const stageManager = {",
      "  hasReversibleRun: () => false,",
      "  handleBridgeRequest: async () => ({ handled: false, code: 'DEMO_DISABLED', hint: '演示壳未启用工作台' }),",
      "  revertRun: async () => false,",
      "};",
      "",
    ].join("\n"),
  },
];

/**
 * 次级页面整体剔除（2026-09 门户首页需求）：演示只保留主聊天页 + 侧边栏会话
 * 交互，其余视图入口由 App.tsx 的 isDemoShell 导航拦截（点击不响应）。
 * 这里把对应 lazy 页面模块 stub 成空组件，Rollup 因此不再打包它们的
 * 依赖树（设置页、学习中心、待办、PDF、模板/技能管理、导入导出等），
 * 直接减小 dist-demo 体积与访客加载压力。这些模块在 lazyComponents.tsx
 * 中仅经动态导入引用，stub 后即使极端路径触发也只是渲染空组件，不会崩。
 */
const NULL_PAGE_CODE = [
  "const NullPage = () => null;",
  "export default NullPage;",
  "export const Settings = NullPage;",
  "export const SOTADashboard = NullPage;",
  "export const DataImportExport = NullPage;",
  "export const ImportConversationDialog = NullPage;",
  "export const LearningHubPage = NullPage;",
  "export const SandboxWorkbenchPage = NullPage;",
  "export const TodoPage = NullPage;",
  "export const ImageViewer = NullPage;",
  "export const SkillsManagementPage = NullPage;",
].join("\n");

const DEMO_PAGE_STUBS: Array<{ test: RegExp; label: string }> = [
  { label: "Settings", test: /features[\/]settings[\/]components[\/]Settings(\.tsx?)?$/ },
  { label: "SOTADashboardLite", test: /components[\/]SOTADashboardLite(\.tsx?)?$/ },
  { label: "DataImportExport", test: /components[\/]DataImportExport(\.tsx?)?$/ },
  { label: "ImportConversationDialog", test: /components[\/]ImportConversationDialog(\.tsx?)?$/ },
  { label: "SkillsManagementPage", test: /skills-management[\/][^\/]*Page(\.tsx?)?$/ },
  { label: "TemplateManagementApp", test: /template-management[\/]Template[^\/]*App(\.tsx?)?$/ },
  { label: "StyleDebugPage", test: /style-lab[\/]StyleDebugPage(\.tsx?)?$/ },
  { label: "TemplateJsonPreviewPage", test: /components[\/]TemplateJsonPreviewPage(\.tsx?)?$/ },
  { label: "LearningHubPage", test: /features[\/]learning-hub[\/]LearningHubPage(\.tsx?)?$/ },
  { label: "SandboxWorkbenchPage", test: /features[\/]sandbox[\/]pages[\/][^\/]*WorkbenchPage(\.tsx?)?$/ },
  { label: "PdfReader", test: /features[\/]pdf[\/]components[\/]PdfReader(\.tsx?)?$/ },
  { label: "TodoPage", test: /features[\/]todo[\/]components[\/]TodoPage(\.tsx?)?$/ },
  { label: "ImageViewer", test: /components[\/]ImageViewer(\.tsx?)?$/ },
];

for (const stub of DEMO_PAGE_STUBS) {
  DEMO_MODULE_STUBS.push({ test: stub.test, code: NULL_PAGE_CODE, label: `page:${stub.label}` });
}

function demoModuleStubPlugin(): Plugin {
  const PREFIX = "\0demo-stub:";
  return {
    name: "demo-module-stub",
    enforce: "pre",
    resolveId(id) {
      for (let i = 0; i < DEMO_MODULE_STUBS.length; i++) {
        if (DEMO_MODULE_STUBS[i].test.test(id)) {
          console.log(`[demo-build] stub: ${DEMO_MODULE_STUBS[i].label} (${id})`);
          return PREFIX + i;
        }
      }
      return null;
    },
    load(id) {
      if (id.startsWith(PREFIX)) {
        return DEMO_MODULE_STUBS[Number(id.slice(PREFIX.length))].code;
      }
      return null;
    },
  };
}


/** 首屏不预载的 chunk 文件名特征（lazy 场景用到时仍会动态加载） */
const DEMO_NO_PRELOAD = [
  "vendor-milkdown",
  "vendor-mermaid",
  "vendor-pptx",
  "vendor-exceljs",
  "vendor-docx",
  "vendor-pdfjs",
  "vendor-recharts",
  "vendor-xyflow",
  "heic2any",
  "mcpService",
];

export default defineConfig((env) => {
  const base = typeof baseConfig === "function" ? baseConfig(env) : baseConfig;

  return {
    ...base,
    plugins: [demoModuleStubPlugin(), ...(base.plugins ?? [])],
    build: {
      ...base.build,
      outDir: "dist-demo",
      modulePreload: {
        ...(typeof base.build?.modulePreload === "object" ? base.build.modulePreload : {}),
        resolveDependencies(_url, deps, context) {
          // js 上下文（React.lazy 等动态导入点）：演示壳一律不预载。
          // 原因：modulepreload 会连带拉取被预载 chunk 的整个静态依赖树——
          // deps 数组里一个不起眼的 noteDriver.js 就会把 4MB 的 milkdown
          // 拽进首屏。演示场景视图少，按需加载完全够用。
          if (context?.hostType === "js") return [];
          // html 上下文（入口直接依赖）：保留轻量预载，剔除重库
          const kept = deps.filter(
            (d) => !DEMO_NO_PRELOAD.some((pat) => d.includes(pat)),
          );
          if (kept.length !== deps.length) {
            const dropped = deps.filter((d) => !kept.includes(d));
            console.log(`[demo-build] preload dropped: ${dropped.join(", ")}`);
          }
          return kept;
        },
      },
      rollupOptions: {
        ...base.build?.rollupOptions,
        input: {
          demo: fileURLToPath(new URL("./demo.html", import.meta.url)),
          // Hero 落地页（纯静态 HTML，内嵌 demo.html iframe，无 JS bundle）
          hero: fileURLToPath(new URL("./hero.html", import.meta.url)),
        },
        output: {
          ...(typeof base.build?.rollupOptions?.output === "object" &&
          !Array.isArray(base.build.rollupOptions.output)
            ? base.build.rollupOptions.output
            : {}),
          // 关掉 Rollup 的传递依赖提升：否则 lazy chunk 的重依赖会以
          // 静态 import 边形式挂进首屏 chunk，浏览器启动即拉取
          hoistTransitiveImports: false,
          // 注意：不要开 onlyExplicitManualChunks——实测会重构 chunk 拓扑
          // 形成环（入口模块无法完成求值：白屏、零 console 输出）。
          // 运行时关键小库误入重 chunk 的问题，改由 vite.config.ts 的
          // vendor-micro / vendor-markdown-shared / vite-runtime 显式归组解决。
        },
      },
    },
  };
});
