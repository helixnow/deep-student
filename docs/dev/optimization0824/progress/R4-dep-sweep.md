# R4：前端依赖收敛（能删都删）

> 子代理：SA-R4-04
> 模型：`claude-fable-5-thinking-xhigh`
> 分支：`cursor/r4-dep-sweep-980d`（自 `cursor/optimization0824-5575` 切出）
> 状态：✅ 完成 —— **删除 19 个生产依赖，flowtoken 改懒加载，init chunk 较基线 -75.9%（gzip）**

## 任务与范围

审计 `package.json` 全部 97 个 `dependencies`，`rg` 每个包名于 `src/`，按
零引用 / 仅注释 / 真实使用分类；重点处理 react-grab、@nvq/flowtoken、heic2any、
framer-motion；其余零引用生产依赖卸载；echarts 若仅 pptx-preview 使用则确保按需
加载。约束：不改 `tsconfig*`、不改 CI frontend matrix（本次两者均未触碰）。

## 审计方法

对 97 个依赖逐一统计两个数：`src/` 内 **import 引用数**（`from '<pkg>'` /
`import('<pkg>')` / 子路径导入）与**原始文本提及数**（含注释/字符串）。对零 import
候选再做三层核验：

1. 全仓（排除 node_modules / docs / lockfile）文本引用复查，排除 `src/` 之外的消费；
2. `package-lock.json` 反查每个候选的**全部依赖方**（含 peer 边），确认删除直接依赖后
   包是否仍由传递边保留、或彻底从树中消失；
3. 动态字符串 import 排查——本仓库仅有的两处动态包名 import（`heic2any`、
   `react-grab`）均为字面量，无模板串拼包名的情况。

## 审计结果（97 个生产依赖）

### 零 import（18 个）

| 包 | 判定依据 | 处置 |
| --- | --- | --- |
| `prosemirror-{model,state,view,transform,keymap,commands,schema-list,inputrules,history,dropcursor,gapcursor}`（11 个） | `src/` 零引用；均为 `@milkdown/prose`（72 处 import）的常规依赖，删除直接依赖后仍在树中（锁文件确认）；`overrides` 继续钉版本；`vite.config.ts` 的 `resolve.dedupe` 按包名工作，不需要直接依赖 | **删除** |
| `@milkdown/plugin-history`、`@milkdown/plugin-slash` | 零引用；`@milkdown/kit` 常规依赖，传递保留 | **删除** |
| `@milkdown/plugin-prism`、`@milkdown/theme-nord` | 零引用且**无任何依赖方**，删后彻底出树（连带 refractor@5） | **删除** |
| `@tauri-apps/plugin-log` | 零引用；Rust 侧插件不依赖 npm 包 | **删除** |
| `react-is` | `src/` 零引用，**但**是 recharts 的运行时 peer 依赖（`recharts/es6/util/ReactUtils.js` 实际 import）；`.npmrc` 有 `legacy-peer-deps=true`，npm **不会**自动装 peer——删除后 `require.resolve('react-is')` 自 recharts 立即失败（已实测） | **保留**（peer 供给） |
| `@types/prismjs` | 运行时零引用，但 typecheck 需要（prismjs 87 处 import） | **移到 devDependencies** |

### 仅注释 / 非代码提及（2 个）

| 包 | 提及位置 | 处置 |
| --- | --- | --- |
| `react-complex-tree` | 仅 `src/utils/tauriDragFix.ts` 一行 CSS 注释 | **删除** |
| `@tauri-apps/plugin-os` | 仅 `src/types/shims-tauri-plugins.d.ts` 的 `declare module`（无人 import） | **删除**（连带删 shim 声明块） |

### 真实使用（77 个）

其余 77 个均有真实 import（从 `@codemirror/lang-css` 2 处到 `react` 1107 处不等），
不动。低频但确认在用的边缘项：`react-grab`（见下）、`@nvq/flowtoken`（见下）、
`heic2any`（动态 import）、`mustache`/`cmdk`/`@uiw/react-heat-map`/`@zumer/snapdom`
（各 1 处真实调用点）、`exceljs`/`pdfjs-dist`/`docx-preview`/`pptx-preview`
（懒加载预览器各 1 处）。

## 四个重点包的处置

| 包 | 结论 | 动作 |
| --- | --- | --- |
| `react-grab` | dev-only 调试工具，靠 `VITE_ENABLE_REACT_GRAB` 门控动态 import；但门控是运行时条件，rollup 仍会为生产构建产出该异步 chunk（含 solid-js/bippy/seroval 约 4 个传递包） | **整包删除**：卸载依赖 + 删 `src/main.tsx` 的 `maybeInstallReactGrab` 钩子 + 删 `.env.example` 条目 |
| `@nvq/flowtoken` | 流式聊天核心动画（AnimatedMarkdown），不可删；但连带 react-syntax-highlighter、@tabler/icons-react、独立 react-markdown@9、regexp-tree，全部被静态 import 打进启动即加载的 `init-*.js` | **改懒加载**：`FlowTokenMarkdownRenderer` 内动态 `import('@nvq/flowtoken')` + 模块级缓存 + 导出 `preloadFlowToken()`；chunk 加载期间（仅首个流式块的头几十毫秒）以纯文本占位；加载完成后渲染保持同步、无 Suspense 抖动。测试侧 `beforeAll(preloadFlowToken)` 保持同步断言语义 |
| `heic2any` | 仅 HEIC 上传转换用；**2026-07-08（审计 30-P1-4）已改为动态 import**（`src/utils/shared.ts:349`），构建产物中已是独立异步 chunk | 无需改动 |
| `framer-motion` | 51 个文件、54 处静态 import（`motion` 43、`AnimatePresence` 35、`useReducedMotion` 19 等），真实重度使用 | **保留**。删除不可行；懒加载需 LazyMotion + 全量 `motion.*`→`m.*` 迁移（51 文件、动画回归风险高），属独立工作包，不在本次 sweep 硬做 |

## echarts（任务 5）

echarts **不是直接依赖**（仅 `overrides` 钉 6.1.0），锁文件反查唯一依赖方为
`pptx-preview`。链路：`pptx-preview` 仅被 `PptxPreview.tsx` 静态 import，而该组件在
`RichDocumentPreview.tsx` 中已是 `lazy(() => import('./PptxPreview'))`；vite
`manualChunks` 另将 pptx-preview+echarts 归入独立 `vendor-pptx` chunk（426 KiB gzip，
本次构建确认未被 modulepreload）。**echarts 已经只在打开 PPTX 预览时加载，无需改动。**

## 删除的依赖（19 个）

`@milkdown/plugin-history`、`@milkdown/plugin-prism`、`@milkdown/plugin-slash`、
`@milkdown/theme-nord`、`prosemirror-commands`、`prosemirror-dropcursor`、
`prosemirror-gapcursor`、`prosemirror-history`、`prosemirror-inputrules`、
`prosemirror-keymap`、`prosemirror-model`、`prosemirror-schema-list`、
`prosemirror-state`、`prosemirror-transform`、`prosemirror-view`、
`@tauri-apps/plugin-log`、`@tauri-apps/plugin-os`、`react-complex-tree`、`react-grab`

另：`@types/prismjs` 由 dependencies 移至 devDependencies。彻底出树的包（含传递）：
react-grab+bippy+solid-js+seroval+seroval-plugins、@milkdown/plugin-prism+refractor@5、
@milkdown/theme-nord、react-complex-tree、@tauri-apps/plugin-{log,os}。
THIRD_PARTY_NOTICES 相应减项。

## 验证

| 检查 | 结果 |
| --- | --- |
| `npm run licenses:generate` | ✅ 1847 components（需先 `cargo fetch --locked`；环境自带 Rust 1.83 过旧无法解析 edition2024 清单，升级到 stable 1.98 后通过——环境问题，与仓库无关） |
| `npm run licenses:check` | ✅ OK |
| `npm run typecheck` | ✅ 0 错误 |
| `npx vitest run`（flowtoken/streamingDefaults/bold 三个受影响文件） | ✅ 34/34 通过 |
| `npx vite build` | ✅ 成功；入口 chunk 零 flowtoken 痕迹；flowtoken 异步 chunk 未被 modulepreload |
| `npm run check:bundle-size` | ✅ 全部预算通过：**init-\*.js 336.8 KiB gzip，较基线 -75.9%**（flowtoken 全家桶移出启动路径）；entry -0.3%；total JS -0.3% |

## 改动文件

- `package.json` / `package-lock.json`：删 19 + 移 1；锁文件 -149 行
- `src/features/chat/components/renderers/FlowTokenMarkdownRenderer.tsx`：flowtoken 懒加载
- `src/features/chat/components/renderers/__tests__/MarkdownRenderer.flowtoken.test.tsx`：beforeAll 预载
- `src/main.tsx`、`.env.example`：移除 react-grab 钩子与配置项
- `src/types/shims-tauri-plugins.d.ts`：删 plugin-os shim
- `legal/THIRD_PARTY_NOTICES.txt`：再生成（集成分支最终权威路径；合并时保留本轮减项）

## 遗留 / 后续建议

- **framer-motion LazyMotion 迁移**：51 文件的 `motion.*`→`m.*` + `LazyMotion features`
  注入，预计可从启动包再挪出 ~100 KiB gzip；需要动画全量回归，建议单开工作包。
- `react-is` 是 legacy-peer-deps 环境下的 peer 供给位，勿再当零引用清理（本次已实测
  删除即断 recharts 解析，已回补）。
- `vite.config.ts` `optimizeDeps.include` 里的 `react-hotkeys-hook` 并非依赖；已由
  SA-WRAP-HYGIENE 在合并收尾时移除。
