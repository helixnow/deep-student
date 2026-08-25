# 0824-g 域分支 draft PR 说明（备用正文）

日期：2026-08-25。`gh` 在本环境只读，无法直接创建 PR；以下为八个域分支对
`cursor/0824-cde6` 的 draft PR 正文，可直接用于
`gh pr create --draft --base cursor/0824-cde6 --head <分支>`。

统一背景：G（mobile 主题，tip `4ab24435`）已于合并提交 `79362482` 正式进入
0824，0824 当前 tip 为 `c119f92b`。八个分支中六个建于官方合并之前、各自独立
构造了 0824×G（与 0824 存在多重 merge-base，GitHub 展示的 diff 会偏大）；
anki 与 shell 两支不含 G 整体合并（单一 merge-base `362dd2df`，GitHub diff
即真实增量）。每节给出「相对最新 0824 tip 的净差异」（`git diff c119f92b..tip`）
作为评审时的真实剩余价值口径。

---

## 1. landing — `cursor/0824-g-landing-cde6`

**标题**：`[draft] 0824×G landing 备份树：--no-ff 全量合并 G 的独立落地`

- 基线 `362dd2df` 上直接 `--no-ff` 合并 G tip `4ab24435`，52 处冲突
  （45 内容 + 7 modify/delete）逐文件裁决，冲突取 step5-fg/step3-fg/
  step5-mobile 已验证终态；随后把 G 热区重放到拆分输入栏
  （`5e57228f`）并对齐壳层契约（`36fcb9fe`）。分支 tip `fe7a61f9`。
- 官方 G 合并已落地，本 PR 的价值收敛为与官方裁决的对照：相对最新 0824
  净差异 43 files（+511/−802），核心是 split input bar 热区重放、
  `legacyNavigationMap`/`responsive-utilities` 收敛与报告
  `docs/dev/0824-g-landing.md`（含 52 处冲突逐文件裁决表）。
- 门禁（`5e57228f` 上）：`npm ci` ✓；`npm run build`（含 typecheck）✓；
  `cargo check --lib` ✓ 0 error；G/F/B/D 关键契约 25 files/174 tests ✓；
  InputBar 全目录 19 files/171 tests ✓。
- 评审建议：以 tip-to-tip diff 对照官方合并，摘取 landing 树中更优的
  hunks（尤其输入栏热区与壳层契约对齐），不整支合入。

## 2. i18n — `cursor/0824-g-fix-i18n-cde6`

**标题**：`[draft] 0824×G i18n/a11y 收口：回填被 G blob 覆盖的 aria-label`

- 在自构 0824×G 上做全量 i18n/a11y 扫描，修复 4 处 step6-fg 预演漏做的
  织合项（`SkillsList` 收藏/编辑/更多、`AnkiTasksApp` 清空搜索的
  aria-label 硬编码英文），全部对齐既有 i18n key，未新造命名空间。
  分支 tip `308cfdab`。
- 4 处代码修复与官方 0824 树已逐字节一致（被官方合并吸收）；净差异仅
  3 files（+114/−137）：收口报告 `docs/dev/0824-g-i18n.md`、
  `docs/0824-MERGE-PLAN.md`、`ReviewQuestionsView.confirmation.test.tsx`
  微对齐（−2 行）。
- 门禁：`npm run check:i18n` ✓；a11y/i18n 定向 Vitest 15 files/61 tests ✓；
  MCP 契约 + input-bar 全目录 22 files/184 tests ✓（拆分未回退）。
- 评审建议：主要收取报告与测试对齐，属低风险 docs/tests PR。

## 3. invariants — `cursor/0824-g-fix-invariants-cde6`

**标题**：`[draft] 0824×G 不变量总审：12 项 PASS + leftovers-safe 回填`

- 对含 G 的 0824 树做 12 项不变量总审（pipeline hooks/`GenerativeUiExecutor`、
  `utf8_stream` 生产调用方、`model_special_tokens`、GenUI 只读闪卡、
  `cardAgent.startGeneration` 路由、附件 200/50MB、HPIAS 会话隔离、
  Rust 18 block allowlist、URL 消毒链等）。初审第 10 项 FAIL（G tip 缺
  leftovers-safe 加固），合入 `0aab5fd7` 修复（`c6176207`）后 12/12 PASS，
  报告含逐项源码行号证据。分支 tip `ccf0075d`。
- 净差异 6 files（+153/−193）：`0824-g-invariants.md`、
  `0824-leftover-audit.md` 更新与 `SkillsList`/`AnkiTasksApp` 少量收敛。
- 门禁：typecheck ✓ 0 error；定向 Vitest 11 files/131 tests ✓。
- 评审建议：审计报告是主要交付物；官方 0824 基线本就含 leftovers-safe，
  重点核对官方树在 12 项上与报告结论一致。

## 4. anki — `cursor/0824-g-fix-anki-cde6`

**标题**：`[draft] 0824×G Anki/练习/作文域收口：恢复 G 触控约束 + 回归测试`

- 不整体合并 G，按域修复被 D/F 后续提交覆盖的 G coarse-pointer 44px
  约束（ReviewQuestionsView 快速重做、作文域等）；保持
  `cardAgent.startGeneration` 制卡路由与 GenUI 只读闪卡边界；导入选择器
  与 locale 解耦；新增三份回归测试（`LibraryScreen`、
  `TodayScreen.emptyLibrary`、`reviewActivityStreak`）。分支 tip `e1edaa44`。
- 单一 merge-base `362dd2df`，GitHub diff 即真实增量：18 files，+546/−46。
  分支不含官方 G 合并，合入前建议先 merge 最新 0824 验证无冲突。
- 特别价值：`TodayScreen.emptyLibrary.test.tsx` 覆盖覆盖表中 #160
  `LEFTOVER` 的一份缺失回归测试（见 `docs/dev/0824-coverage.md`）。
- 门禁：定向 Vitest 20 files/189 tests ✓；typecheck ✓。

## 5. chat — `cursor/0824-g-fix-chat-b0d6`

**标题**：`[draft] 0824×G 聊天/输入栏域终审：拆分组件承接 G 热区`

- 聊天域终审。保留 0824 的 `InputBarUI` 拆分编排（不恢复 G 的 3922 行
  monolith），把 G coarse 增量按职责重放到 `ComposerToolbar`/
  `AttachmentPanelBody` 等拆分组件；`MessageItem`/`ChatV2Page`/
  `useChatPageLayout` 接收 G 44px 热区与移动布局并保留只读会话门禁；
  新增 `InputBarUI.mobileSplitContract.source.test.ts` 防止拆分被旧
  monolith 覆盖。分支 tip `e11fc8d2`。
- 净差异 50 files（+681/−861），含 `chatV2SendButtonContract` 等测试对齐
  与域报告 `docs/dev/0824-g-chat.md`（输入栏冲突逐文件取舍表）。
- 门禁：input-bar 20 files/176 tests ✓；chat 域 145 files/1110 tests ✓；
  `npm run build` ✓。
- 评审建议：对照官方合并的输入栏所有权划分，优先摘取 mobileSplitContract
  源码契约与发送按钮契约对齐。

## 6. reading — `cursor/0824-g-fix-reading-cde6`

**标题**：`[draft] 0824×G 阅读/访达/PDF 域预演：清单化合并 + 域门禁`

- 按第九轮 checklist（`0824-g-merge-checklist.md`）在 `362dd2df` 上构造
  0824×G：44 路径逐字节取授权 blob（脚本实证）、7 处 modify/delete 显式
  `git rm`、织合 `SkillsList`/`AnkiTasksApp`、静默重放两文件主动放置；
  产出域报告供官方合并代理取用。分支 tip `6702f972`。
- 官方 G 合并已落地；净差异仅 4 files（+190/−139），主要是报告
  `docs/dev/0824-g-reading.md` 与 `ComposerToolbar`/测试微对齐。
- 门禁：typecheck 0 错误 ✓；`npx vite build` ✓；域内 Vitest
  41 files/225 tests ✓（learning-hub/finder/PDF 全域）。
- 评审建议：收取报告与 `ComposerToolbar` 对齐；其余已被官方合并吸收，
  属低风险 docs/tests PR。

## 7. shell — `cursor/0824-g-fix-shell-cde6`

**标题**：`[draft] 0824×G 工作台/壳层落地：G coarse 热区 + 死代码清除`

- 只落 G 的工作台/壳层/死代码面：`App`/`ModernSidebar`/`DsDialog`/
  `VendorSidebar` 等按 base→G→step5-fg 三方对比重放 G 热区（含 dnd-kit
  迁移上的重放，不回退 @hello-pangea/dnd）；删除 legacy notes 死代码
  37 文件约 11k 行；报告含「删除 vs 复活风险」逐项清单。分支 tip `064beb15`。
- 单一 merge-base `362dd2df`，GitHub diff：51 files，+224/−11252。
  官方 G 合并已删除其中 36 个文件；本分支相对最新 0824 的独有删除仅剩
  `src/features/notes/__tests__/PreviewPanel.i18n.test.ts`（step5-fg 与
  官方合并均漏删），另有壳层热区重放与 mobile 契约测试差异需逐项对照。
- 门禁：壳层批 9 files/126 tests ✓；触及面批 13 files/110 tests ✓；
  typecheck ✓ 0 error。
- 评审建议：先收 `PreviewPanel.i18n.test.ts` 漏删与报告；壳层热区 hunks
  与官方树 diff 后按需摘取。

## 8. governance — `cursor/0824-g-fix-governance-cde6`

**标题**：`[draft] 0824×G 治理/设置面权威三方解 + 52 路径冲突剧本`

- 治理/设置/云存储 8 文件给出权威三方解（A a11y + B sync + G 热区三方
  审查后落地）；其余 44 冲突路径按已验证预演机械占位并逐文件标注来源。
  交叉核对发现两条 FG 预演线的系统性缺陷：step5-fg 在 6 个设置文件上
  静默丢失 G 热区（`DataGovernanceDashboard`/`McpEditorSection`/
  `McpToolsSection`/`OcrEngineCard`/`OcrEngineTestPanel`/`VendorSidebar`）；
  step5-fg 未采纳 F 的 `InputBarUI` 拆分（其 blob 若用于合并会回退官方
  已落地结构，禁用）。分支 tip `7c02962b`。
- 净差异 24 files（+304/−482），含冲突剧本报告
  `docs/dev/0824-g-fix-governance.md`。
- 门禁（`cd535fe5` 上）：typecheck ✓；定向 Vitest 22 files/142 tests ✓。
- 评审建议：优先核对官方 G 合并在上述 6 个设置文件上是否吸收了 G 热区
  （本 PR 的交叉核对是关键输入）；治理 8 文件三方解与官方树 diff 后摘取。
