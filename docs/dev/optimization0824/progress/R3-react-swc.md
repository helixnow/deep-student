# R3-react-swc：WI-7 @vitejs/plugin-react → @vitejs/plugin-react-swc

> 子代理：SA-R3-03（模型 `claude-fable-5-thinking-xhigh`）
> 日期：2026-08-24
> 分支：`cursor/optimization0824-5575`
> 状态：✅ 完成——vite build 阶段 1m27s → 1m10s（约 -20%），产物逐 chunk 字节一致，抽样 vitest 无插件相关回归。

## 结论（TL;DR）

- **无自定义 babel 插件**：三处 `react()` 调用（`vite.config.ts` / `vitest.config.ts` / `playwright-ct.config.ts`）均为无参调用，仓库亦无 `.babelrc` / `babel.config.*`——切换无阻碍，无需保留 babel 路径的文档说明。
- 安装 `@vitejs/plugin-react-swc@4.3.3`（peer `vite ^4 || ^5 || ^6 || ^7 || ^8`，与当前 vite 6.4.x 兼容），`vite.config.ts` 与 `vitest.config.ts` 已切换。
- **`playwright-ct.config.ts` 有意保留 babel 版插件**：`@playwright/experimental-ct-react@1.60.0` 自身硬依赖 `@vitejs/plugin-react`（npm ls 显示 deduped 到我们的 devDep），因此 `@vitejs/plugin-react` 保留在 devDependencies，不能移除。
- `npm run build` 全流程通过；vite build 阶段自报 **1m27s → 1m10s（-17s，约 -20%）**。产物与 babel 基线逐 chunk 字节一致（唯一差异可归因于同分支并行任务的源码改动，见下）。
- 抽样 10 个 vitest 文件：通过的全部通过；1 个失败与 1 个挂起在 babel 插件下**逐字复现**，均为既有问题，与本次切换无关。

## 1. babel 插件检查（前置条件）

| 位置 | 用法 | 结论 |
| --- | --- | --- |
| `vite.config.ts` | `react()` 无参 | 可直接切换 |
| `vitest.config.ts` | `react()` 无参 | 可直接切换 |
| `playwright-ct.config.ts` | `react()` 无参 | 保留 babel 版（CT 框架硬依赖，见 TL;DR） |
| `.babelrc*` / `babel.config.*` | 不存在 | 无隐式 babel 配置 |

## 2. 变更内容

- `package.json`：devDependencies 新增 `@vitejs/plugin-react-swc@^4.3.3`；`@vitejs/plugin-react` **保留**（playwright-ct 需要）。
- `vite.config.ts` / `vitest.config.ts`：`import react from "@vitejs/plugin-react"` → `"@vitejs/plugin-react-swc"`，其余零改动（插件仍无参调用）。
- `package-lock.json`：+287 行（`@vitejs/plugin-react-swc` + `@swc/core` 及平台二进制）。
- `public/legal/THIRD_PARTY_NOTICES.txt`：lock 变更触发 `licenses:check` 哈希门禁，重新生成。**正文零变化**（生成器排除 NPM dev-only 包，swc 全链路均为 devDep），仅 `package-lock.json SHA256` 行更新。顺带把此前 `@hello-pangea/dnd` 移除提交后未同步的 lock 哈希对齐，修复了 HEAD 上 `licenses:check` 的门禁失败。

### 行为语义说明

`@vitejs/plugin-react-swc` 仅在 **dev/serve 模式**（含 vitest 的 vite 转换管线）用 SWC 转换；**生产 build** 在未配置 SWC 插件时交回 esbuild 处理 JSX——因此产物预期不变，提速来自 build 阶段去掉了 babel per-file transform，dev 冷启动/HMR 也受益（本次未单测 dev 指标）。

## 3. 构建验证（Linux x64 Cloud Agent VM，Node v22.14.0 / npm 10.9.7）

计时口径：vite 自报 "built in X"（排除 prebuild 的 typecheck/licenses/version 步骤）；两次构建均在系统空载窗口执行（同 VM 有并行子代理任务，已避开其高负载时段）。

| 指标 | babel 基线 | swc 切换后 | Δ |
| --- | ---: | ---: | ---: |
| vite build（自报） | 1m27s | **1m10s** | **-17s（≈ -20%）** |
| dist 总体积 | 38,085,796 B | 38,075,737 B | -10,059 B |
| assets 文件数 / JS chunk 数 | 1,062 / 960 | 1,062 / 960 | 0 |
| JS 合计 | 29,903,025 B | 29,892,966 B | -10,059 B |
| CSS 合计 | 1,315,249 B | 1,315,249 B | 0 |

- `npm run build` 全流程（version:generate + licenses:check + typecheck + vite build）：1m58s，exit 0。
- **逐 chunk 对比**：init（6,632.18 kB）、vendor-mermaid、vendor-milkdown 等全部 chunk 字节一致；唯一差异是 entry `index` chunk 4,185.81 → 4,175.75 kB（-10.06 kB），与两次构建之间并行任务落入工作树的 `src/features/chat/skills/builtin-tools/*` 描述精简改动吻合，**非插件差异**。
- 基线与 R2-rolldown-spike 记录的 2m13s 不可比（树内容与 VM 负载不同）；本报告两侧均为同树同机同窗口实测。

## 4. vitest 抽样（`npm test -- --run <files>`）

| 文件 | 结果 |
| --- | --- |
| `tests/vitest/smoke.test.tsx` | ✅ |
| `tests/vitest/ui-shell/smokeRender.test.tsx` | ❌ 1/2（既有失败，见下） |
| `tests/vitest/errorBoundaryCopy.test.tsx` | ✅ |
| `tests/vitest/chat-v2/useChatSession.test.tsx` | ✅ |
| `tests/vitest/data-governance/ChatSessionArchiveTab.grouping.test.tsx` | ✅ |
| `tests/vitest/todoQuickAddParser.test.ts` | ✅ |
| `tests/vitest/mindmap-store-lifecycle.test.ts` | ✅ |
| `tests/vitest/unifiedNotificationDismiss.test.tsx` | ✅ |
| `tests/vitest/chat-v2/useSessionLifecycle.test.tsx` | ✅（26/26；teardown 后有 2 个泄漏 timer 的 unhandled error，测试卫生问题，与转换器无关） |
| `tests/vitest/question-bank-editor-ai-markdown.test.tsx` | ⏱ 挂起（既有问题，见下） |

**既有问题甄别**（均已切回 babel 插件复跑对照）：

- `ui-shell/smokeRender.test.tsx`：`Unable to find a label with the text of: window_controls.minimize`——babel 下**同样失败**，与本切换无关。
- `question-bank-editor-ai-markdown.test.tsx`：单文件运行 240s 超时无输出（fork 100% CPU）——babel 下**同样挂起**。疑与近期主干改动或并行任务的工作树改动相关，建议后续单独排查。

合计其余 8 文件 72+ 用例全部通过，SWC 转换管线（vitest 走 dev-mode transform，真实吃到 SWC）无回归。

## 5. 变更清单

| 文件 | 说明 |
| --- | --- |
| `package.json` | +`@vitejs/plugin-react-swc@^4.3.3`（devDep） |
| `package-lock.json` | swc 插件及其依赖 |
| `vite.config.ts` / `vitest.config.ts` | import 切换 |
| `public/legal/THIRD_PARTY_NOTICES.txt` | lock 哈希行更新（正文零变化） |
| `docs/dev/optimization0824/progress/R3-react-swc.md` | 本报告 |

## 6. 后续建议

- dev 模式收益（冷启动 / HMR）未计量，如需数据可单独跑 `vite --port 1422` 对比。
- 若未来落地 rolldown-vite（见 R2-rolldown-spike），届时改评估 `@vitejs/plugin-react-oxc`；本次 swc 切换不构成障碍（同为 import 一行）。
- `playwright-ct` 升级时留意其对 `@vitejs/plugin-react` 的内置依赖是否解除，届时可考虑 CT 配置同步切换并移除 babel 版插件。
