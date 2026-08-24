# R2-rolldown-spike：WI-7 rolldown-vite 可行性验证

> 子代理：SA-R2-09（模型 `claude-fable-5-thinking-xhigh`）  
> 日期：2026-08-24  
> 分支：`cursor/optimization0824-5575`  
> 状态：❌ 失败（rolldown 内部 panic）——依赖改动已 revert，仅留本报告。**建议 vite 7 升级后重试，transform 阶段实测 ~12s vs 基线全程 2m13s，潜在收益极大。**

## 结论（TL;DR）

- vite 6 兼容的最新 rolldown-vite 为 **6.3.21**（6.x 线终点，内置 rolldown `1.0.0-beta.16`，npm 已标记 deprecated）。
- 换上后 `npm install` 干净通过、全部 vite 消费方成功 dedupe，但 `vite build` 在 transform 完成后的 finalize 阶段触发 **rolldown 原生 Rust panic**，无产物输出，无法对比 dist。
- panic 属 rolldown 已知 bug 类型（`no entry found for key` @ `module_finalizers`），修复散落在更新的 rolldown 版本中，而这些只随 rolldown-vite 7.x（要求 vite 7）发布——vite 6 线内无解。
- 已按预案 revert `package.json`/`package-lock.json`，工作树恢复 stock vite 6.4.3。

## 基线（stock vite 6.4.3，rollup + esbuild）

环境：Linux x64（Cloud Agent VM），Node v22.14.0，npm 10.9.7。计时仅 `npx vite build`
（`prebuild` 的 typecheck/licenses 与打包器无关，已排除；`version:generate` 预先跑过）。

| 指标 | 数值 |
| --- | ---: |
| `vite build` wall time | **2m13.8s**（user 2m2.2s / sys 4.9s；vite 自报 "built in 2m 13s"） |
| dist 总体积 | 40,525,575 bytes（≈38.6 MiB，含 pdfjs cmaps/fonts/wasm 静态拷贝） |
| dist/assets 文件数 | 1,063（其中 JS chunk 961 个） |
| JS 合计 | 30,019,057 bytes（≈28.6 MiB） |
| CSS 合计 | 1,315,249 bytes |

Top chunk（raw）：`init` 6.63 MB、entry `index` 4.21 MB、`vendor-mermaid` 2.74 MB、
`heic2any` 1.35 MB、`vendor-pptx` 1.35 MB、`vendor-milkdown` 1.24 MB、`vendor-exceljs` 0.94 MB
——与 R1-WI-8 门禁基线一致。

## spike 过程

1. `devDependencies.vite` → `npm:rolldown-vite@6.3.21`，`overrides.vite: "$vite"`（让
   `@vitejs/plugin-react`、`vite-plugin-static-copy`、`vitest`、`@playwright/experimental-ct-core`
   的传递依赖统一走别名）。
2. `npm install`：2s 完成（+9/-6/~1 包），`npm ls vite` 确认全部消费方 dedupe 到
   `vite@npm:rolldown-vite@6.3.21`。npm 同时给出弃用警告：
   *"Use 7.3.1 for migration purposes. For the most recent updates, migrate to Vite 8 once you're ready."*
3. `npx vite build`：

```text
rolldown-vite v6.3.21 building for production...
Warning validate output options.
- For the "manualChunks". manualChunks is not supported. Please use advancedChunks instead.
transforming...
✓ 18882 modules transformed.

thread '<unnamed>' panicked at crates/rolldown/src/module_finalizers/mod.rs:1250:65:
no entry found for key
✗ Build failed in 12.46s
error during build: Panic in async function
```

## 失败原因分析

- **panic 位置**：`crates/rolldown/src/module_finalizers/mod.rs:1250`，`no entry found for key`，
  发生在 18,882 个模块全部 transform 成功之后的 symbol/chunk finalize 阶段。
  `RUST_BACKTRACE=1` 只有 napi 原生帧，无法定位具体触发模块。
- **排除项**：临时禁用 `vite.config.ts` 里的 `exclude-mcp-debug` 虚拟模块插件后同样 panic
  ⇒ 与自定义虚拟模块无关（实验后已还原）。
- **上游背景**：`no entry found for key` @ module_finalizers 是 rolldown 反复出现的一类内部
  bug（scope hoisting / 动态 import / CJS re-export 边界场景），上游多个 issue
  （rolldown#1722、#2833、#6587 等）在**更新的 rolldown 版本**里陆续修复。
  6.3.21 捆绑的 `rolldown 1.0.0-beta.16` 过旧且不可单独升级
  （rolldown-vite 按精确版本绑定其 rolldown API）；6.3.21 已是 6.x 线最后一版，
  vite 6 约束下无更新版本可试。
- **次要发现**：即使 build 通过，`build.rollupOptions.output.manualChunks` 也会被 rolldown
  **忽略**（warning），vendor-* 手动拆包会失效——重试时必须迁移到
  `advancedChunks`（`output.advancedChunks.groups`）。

## 体积/chunk 对比

无法进行：rolldown 构建在产物写盘前 panic，无 dist 输出。

## 性能信号（为什么值得重试）

- rolldown transform 完成 18,882 个模块仅 **~11–12s**（wall），而 stock vite 全程 2m13s
  （其中 rollup 打包为主要占比）。虽然 finalize/minify/写盘阶段未能走完，无法给出端到端
  数字，但量级差距明显，与社区通报的 5–15x 提速一致。

## 建议（重试路径）

1. **前置**：先落地 vite 7 升级（已有 dependabot 分支 `dependabot/npm_and_yarn/vite-7.3.1`），
   然后用 **rolldown-vite 7.3.1**（rolldown 1.x stable，含上述 panic 类修复）重跑本 spike。
2. 重试时同步处理：
   - `manualChunks` → `advancedChunks.groups` 迁移（否则 vendor 拆包静默失效，
     R1-WI-8 体积门禁会误报）；
   - 评估 `@vitejs/plugin-react-oxc` 替换 `@vitejs/plugin-react`（rolldown-vite 构建时
     主动提示，babel transform 是剩余大头）；
   - 验证 `vite-plugin-static-copy`、`rollup-plugin-visualizer`（ANALYZE=1）与 Sentry
     sourcemap 插件在 rolldown 下的行为。
3. 更长线：vite 8 默认 rolldown 化，届时无需别名 override，WI-7 可能随大版本升级自然完成。

## 变更清单

| 文件 | 状态 |
| --- | --- |
| `package.json` / `package-lock.json` | spike 后已 revert，无净变更 |
| `vite.config.ts` | 无净变更（实验性禁用插件已还原） |
| `docs/dev/optimization0824/progress/R2-rolldown-spike.md` | 新增（本报告，唯一交付物） |
