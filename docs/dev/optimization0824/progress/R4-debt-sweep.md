# R4 质量债清扫：R1–R3 遗留项收口（SA-R4-10）

> 分支：`cursor/optimization0824-5575`
> 日期：2026-08-24
> 子代理：SA-R4-10
> 模型：`claude-fable-5-thinking-xhigh`
> 输入：`docs/dev/optimization0824/progress/` 全部 29 份 R1/R2/R3 报告复查

## 0. TL;DR

复查全部 R1/R2/R3 报告后落地 **5 项真实修复**（外加 2 项确认、2 项跳过/让渡）：
文档纠偏、两个既有 vitest 问题根因修复（含一个 240s+ 挂死）、
新增 3 条日文 PDF 不崩溃守卫测试。`typecheck` / 相关 vitest 全部通过。

> 并发说明：同轮次另一子代理在本报告撰写期间推送了 `d248cbab`
> （pdf 资产运行时化 + `config/pdfjs-local-assets.json` 单一清单 + worker
> viteStaticCopy 化）与 `82bbc874`（workflow 注释修正）。rebase 时凡与上游
> 重叠的部分一律让渡上游实现，本报告逐条标注了让渡情况。

## 1. 任务清单逐条结论

### 1.1 ✅ done — docs/THIRD_PARTY_LICENSES.md 过时行

- **hello-pangea**：NPM Apache-2.0 代表性依赖行仍列 `@hello-pangea/dnd`
  （R2-dnd-migration §5 与 R3-remove-dnd-dep §4 两轮标注"下次触碰时顺带清理"）——已移除。
- **claude-code**：全文 `rg -i "claude|anthropic"` 零匹配，`@anthropic-ai/claude-code`
  的提及在更早轮次已清干净，本轮无需改动（确认项）。
- 顺带把头部 `生成时间 / Generated: 2026-07-14` 改为 `更新时间 / Updated: 2026-08-24`
  （该文件是手工维护的策略文档，非生成物，旧措辞+旧日期双重误导）。

### 1.2 ✅ done（并发落地，让渡上游）— ci.yml bundle-size 注释 +5% → +3%

R3-bundle-baseline §5 遗留项 1：脚本（`scripts/check-bundle-size.mjs`，HEADROOM=1.03）
早已收紧为 +3%，但 `.github/workflows/ci.yml` 的 `Bundle size check` 步骤注释仍写
"+5%"。本代理提交了仅注释的修正 hunk；rebase 时发现并行子代理 `82bbc874`
已落地更详细的同义修正（含基线 commit 引用），冲突解决时采纳上游版本。
**当前分支注释已正确显示 +3%**，目标达成，实现归属上游。

### 1.3 ✅ done（确认项）— @hello-pangea/dnd 已彻底移除

`package.json`、`package-lock.json`（含独占传递依赖 `css-box-model`/`raf-schd`）、
`legal/THIRD_PARTY_NOTICES.txt` 三处 `rg "hello-pangea"` 均零匹配，
与 R3-remove-dnd-dep 报告一致。仓库内剩余提及仅两处 src 注释
（`useTouchFriendlyDndSensors.ts` 长按语义来源、`VendorSidebar.tsx` 迁移前行为对照），
属 R3 §4 明确保留的历史语义说明，非引用，不动。

### 1.4 ✅ done — R3-react-swc §4 两个既有 vitest 问题均已根因修复

**(a) `tests/vitest/ui-shell/smokeRender.test.tsx` 失败**（1/2，babel/swc 下均复现）：

- 根因：vitest 的 i18n mock（`tests/ct/mocks/react-i18next.tsx`）会把 key 解析成
  zh-CN 语言包真实文案（`window_controls.minimize` → `最小化`），而测试断言的是
  原始 key——是语言包补齐译文后测试没跟上，与转换器无关（印证 R3 判断）。
- 修复：改为 `import zhCommon from '@/locales/zh-CN/common.json'` 后按解析值断言，
  文案再变更也不会碎。**2/2 通过。**

**(b) `tests/vitest/question-bank-editor-ai-markdown.test.tsx` 挂起**（240s+ 无输出，fork 100% CPU）：

- 排查方法：`kill -USR1` 打开 fork 的 inspector，经 CDP `Debugger.pause`（V8 中断，
  可打断忙循环）反复采样 JS 栈 + `Runtime.evaluate` 观测 DOM。
- 根因：测试 mock `useQbankAiGrading: () => ({ ..., resetState: vi.fn() })`
  **每次渲染返回新的 `vi.fn()`**；而组件把 `resetState`（真实 hook 里是稳定的
  `useCallback`，见 `QuestionBankEditor.tsx:521` 注释）放进了切题重置 effect 的依赖。
  于是：渲染 → effect 依赖变化重跑 → `setSelectedOptions(new Set())` 等新身份
  setState → 再渲染 → 无限循环。循环经微任务推进，绕过 React 的嵌套 update 检测
  （全程零 console 告警），`act()` 永远排不空队列，事件循环被堵死——连 5s 测试
  超时定时器都无法触发，表现为整文件挂死。初期采样总落在 OverlayScrollbars 的
  update/getComputedStyle 上，系每轮循环中最重的帧，为伴生热点而非根因
  （已用「mock 掉滚动条仍挂」的对照探针排除）。
- 修复：mock 工厂内创建一次回调并复用（同时补上真实 hook 有的 `retryGrading`），
  附注释解释身份稳定性要求。**挂死 → 175ms 通过。**
- 组件本身无 bug：生产路径回调稳定，不会进入该循环。

**(c) 附带核验**：R3 提到的 `useSessionLifecycle.test.tsx` teardown 泄漏 timer
unhandled error，本轮复跑（3/3 通过）已不复现，无需处理。

### 1.5 ✅ done — CJK/日文 PDF 不崩溃最小测试

R1-static-assets-audit §3.3 与 R2-pdfjs-subset §5 都要求的用例，落在
`tests/vitest/pdf/pdfjsCMapSubsetNoCrash.test.ts`（node 环境，3 用例，~290ms）：

1. 子集语义守卫：`UniJIS-UCS2-H` / `Adobe-Japan1-UCS2` 在、`90ms-RKSJ-H` 不在；
2. 保留路径：程序化构造未内嵌字体的日文 CID 字体 PDF（`UniJIS-UCS2-H`，
   `<30423044>` = あい），在按白名单复刻的临时 cmaps 子集目录下 getDocument /
   getOperatorList / getTextContent 全通，且文本层提取出 `あ`；
3. 裁剪路径：同构 PDF 改用已裁掉的遗留编码 `90ms-RKSJ-H`（Shift-JIS `<82A082A2>`），
   pdfjs 默认 `ignoreErrors` 下仅降级、**全链路 resolve 不崩溃**——把 R2 §1.3
   的"不 crash"论证变成可回归的断言。

与并行子代理 `d248cbab` 落地的 `tests/vitest/pdf/pdfCjkNoCrash.test.ts` 互补而不重复：
上游用例走 `PDF_OPTIONS` 三级 fallback（简中命中 + 日文遗留降级 + 远程恢复），
本用例走**不带 fallback 的原生 pdfjs 链路**，另补了"现代日文 PDF（UniJIS-UCS2）
不依赖 fallback 就可用"的正向断言。白名单消费上游的
`config/pdfjs-local-assets.json` 单一清单（本代理原实现的 `scripts/pdfjs-cmap-subset.mjs`
共享模块与上游 JSON 方案重复，rebase 时删除让渡）。

### 1.6 ✅ done（部分让渡上游）— 死代码 / 重复 worker 引用 / 错误注释

- **worker 链路**：核验 R1-WI-5 收敛后状态——全库 `pdf.worker` 引用唯一化
  （`EnhancedPdfViewer.tsx` → `pdf.worker.wrapper.mjs` → `pdf.worker.min.mjs`），
  v3 UMD 死文件无复活迹象。针对审计 §3.4 指出的"升级 pdfjs-dist 后 public/ 副本
  静默过期"风险，本代理曾提交字节一致守卫测试；rebase 时发现上游 `d248cbab`
  已落地根治方案（删除 public/ 手工副本，worker 改由 viteStaticCopy 从
  node_modules 拷贝，并带 `pdfStaticAssets.test.ts` 单一来源契约测试），
  守卫测试随之失效删除，风险面归零由上游实现承担。
- **cmap 白名单重复定义**：见 §1.5，单一事实来源为上游
  `config/pdfjs-local-assets.json`，本代理新测试同样消费该清单。
- **死代码排查**：`scroll-theme.ts` 三个 `@internal` 兼容导出被
  `scrollbarVisualContract.test.ts` 消费，非死代码，保留；两处 hello-pangea
  历史注释按 R3 决议保留（见 §1.3）。

### 1.7 本报告

即本文件，含逐条 done/skipped 与验证记录。

## 2. 跳过/让渡项（skipped）

| 项 | 原因 |
| --- | --- |
| `pdf.worker.min.mjs` 改为 viteStaticCopy 从 node_modules 拷贝（审计 §3.4 的另一半建议） | 本代理原判定为"无浏览器环境无法验证 dev 模式，风险大于收益"而跳过；并行子代理 `d248cbab` 已带测试落地，冲突解决时全盘采纳上游实现。 |
| `COORDINATION.md` WI 状态表更新 | 母代理维护的热点文件，多子代理并发轮次里易冲突，按任务约束避开。 |
| tsconfig / model2_pipeline / tool_loop / session_export / builtin-tools 区域 | 任务明确要求避开的大热点，未触碰（rebase 中 tsconfig 相关冲突一律采上游）。 |

## 3. 验证（rebase 到 `d248cbab` 之后复跑）

| 检查 | 结果 |
| --- | --- |
| `npx tsc --noEmit -p tsconfig.json` | exit 0（需先 `version:generate`，生成物 gitignored） |
| `npx vitest run tests/vitest/ui-shell/smokeRender.test.tsx` | 2/2 ✅（修复前 1/2） |
| `npx vitest run tests/vitest/question-bank-editor-ai-markdown.test.tsx` | 1/1 ✅ ~175ms（修复前 240s+ 挂死） |
| `npx vitest run tests/vitest/pdf/` | 全部 ✅（本轮新增 3 + 上游 pdfCjkNoCrash/pdfStaticAssets） |
| `npx vitest run tests/vitest/chat-v2/useSessionLifecycle.test.tsx` | 3/3 ✅ 无 unhandled error |
| R3 抽样过的另 7 个文件（smoke / errorBoundaryCopy / useChatSession 等） | 68/68 ✅ 无回归 |
| `npx eslint <改动文件>` | 0 error |

（rebase 前曾以等价的白名单重构完整跑过 `npx vite build`：exit 0，
`dist/cmaps` 68 文件、`dist/wasm` 6 文件与 R2 报告逐一致；rebase 后
`vite.config.ts` 全盘采上游版本，未再引入配置改动。）

## 4. 变更清单（最终提交内容）

| 文件 | 变更 |
| --- | --- |
| `docs/THIRD_PARTY_LICENSES.md` | 移除 Apache-2.0 行 `@hello-pangea/dnd`；日期行纠偏 |
| `tests/vitest/ui-shell/smokeRender.test.tsx` | 按 zh-CN 语言包解析值断言 aria-label |
| `tests/vitest/question-bank-editor-ai-markdown.test.tsx` | mock 回调身份稳定化（修挂死） |
| `tests/vitest/pdf/pdfjsCMapSubsetNoCrash.test.ts` | 新增：日文 PDF 不崩溃 ×3（消费上游 JSON 清单） |
| `docs/dev/optimization0824/progress/R4-debt-sweep.md` | 本报告 |
