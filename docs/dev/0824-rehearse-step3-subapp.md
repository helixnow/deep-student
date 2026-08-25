# 0824 Step3 预演：F subapp 合入（wrapup 之后）

日期：2026-08-24  
预演分支：`cursor/0824-rehearse-step3-subapp-cde6`  
基线：`origin/cursor/0824-cde6` @ `af3e39d8`（已含 Step3 A wrapup）  
被合入：`origin/cursor/0824-theme-subapp-cde6` @ `575fee7f`（与 Step2 预演同一 tip）

结论：**可合**。合并、前后端编译门禁与冲突面定向回归全部通过；本轮没有修改
`main` 或回推 `cursor/0824-cde6`。与 Step2 预演（基线 `eec20398`，4 处冲突）相比，
本轮新增的 17 处冲突全部来自 **A wrapup 与 F 的重叠**，集中在两类：双方各自实现了
同一功能（finder 分桶、i18n mock 缓存、rAF 测试脆弱性）、以及 wrapup 在 F 已拆分/
删除的旧结构上打的补丁需要搬家。

## 提交清单

| 提交 | 内容 |
| --- | --- |
| `05479666` | merge 主提交（双亲 `af3e39d8`、`575fee7f`），21 处冲突的解决 |
| `30e47335` | cherry-pick Step2 的 `6ea10cb6`（qbank 工具描述契约补回，逐字节干净应用） |
| `cf5a01b5` | wrapup 复制失败 i18n 移植到 F 新结构（详见下） |
| `73fa72d4` | F 集成测试 i18n mock 补 defaultValue 签名（静默碰撞，详见下） |

## Step2 已有解法直接沿用的冲突（4 处）

- `package-lock.json`：保留 0824 侧。`package.json`/lock/`legal/THIRD_PARTY_NOTICES.txt`
  三者合并后与 0824 tip 逐字节一致（F 相对 main 未动这些行，差异全来自 0824 的
  dep-sweep），无需重生成。
- `public/legal/THIRD_PARTY_NOTICES.txt`：保持删除，权威路径仍是 `legal/`。
- `src/features/chat/skills/builtin-tools/qbank-tools.ts`：冲突块取 F
  （count≤50、`daily_target`、【必填】标注）；注意 **不能整文件 checkout --theirs**——
  0824 侧对同文件还有 110 行描述压缩是自动合并进来的。合并后 cherry-pick
  `6ea10cb6` 补回 9 条机器可读契约串，最终文件与 Step2 预演终态零 diff。
- `src/features/workbench/components/WorkbenchDesktop.tsx`：直接采用 Step2 解法文件
  （`git checkout 6ea10cb6 -- <file>`；两侧输入与 Step2 完全一致）。并集：
  F 的 `ImmersiveHint`/可关桌面组件 + 0824 的 `DesktopAiBriefingWidget`，
  「显示桌面组件」开关同时控制日程与 AI 简报。

## 本轮新增：wrapup × F 重叠冲突（17 处）

### finder 分桶：双方各自实现了同一功能（6 文件）

wrapup（#164 移植）与 F 各写了一套「访达按宿主分桶」：

- wrapup：`useHostFinderStore` + 静态桶映射（page/page-mobile 共桶、canvas/canvas-mobile 共桶）；
- F：`useFinderStoreFor` 每宿主独立桶 + 视图偏好继承（新桶回落旧单例偏好）+
  「活跃宿主」机制（`useActiveFinderState`，供 App 级前进/后退壳层跟随当前可见访达）+
  自带 3 个集成测试。

**取 F 全套**（learning-hub 属 F 主题域，且 F 是功能超集）：`finderStore.ts`、
`LearningHubSidebar.tsx`、`LearningHubPage.tsx`、`LearningHubNavigationContext.tsx`、
`ChatV2Page.tsx` 冲突块全取 F 侧；删除 wrapup 侧重复测试
`finderStoreHostBuckets.test.ts`（其「page 与 page-mobile 共桶」断言与 F 的每宿主
隔离设计相悖；特性由 F 的 `finder-host-buckets.test.ts` 覆盖）。
两处自动合并残留手工清理：NavigationContext 里 wrapup 的死绑定
`useHostFinderStore(FINDER_HOST_IDS.page)`（F 函数体已改用 `useActiveFinderState`）。

**有益的跨侧组合**（保留，非事故）：wrapup 把 canvas 宿主的导航位置从组件本地
state 搬进宿主桶 store（自动并入），叠在 F 的每宿主桶上之后，F 的 ChatV2Page
移动端面包屑（读 `canvasMobile` 桶）从「永远空」变成真正有数据——两侧单独都做
不到这一点。合并后无 `canvasPath`/`canvasHistory` 悬空引用。

### wrapup 补丁搬家到 F 新结构（3 处）

- `useMessageActions.ts`（UD）：0824 上这个 hook 是**死代码**（无人 import），
  wrapup 的一行 i18n 修补（复制失败提示 `getErrorMessage(error)` →
  `t('common:copy_failed')`）打在了死文件上；F 删除该文件正确。跟随删除，并把
  修补移植到 F 结构中活着的三个复制处理器（`MessageItem.tsx`、
  `ParallelVariantView.tsx`、`useChatPageEvents.ts`），即 `cf5a01b5`。
- `InputBarUI.tsx`：F 把辅助函数拆到 `inputBarConfig.ts` /
  `attachmentModeHelpers.ts` / `ComposerToolbar.tsx`，巨型冲突块实为「F 已拆走的
  基线代码」，取 F 侧删除。wrapup 对该文件仅 4 个语义修补：50MB 图片上限与超时
  i18n 已自动合并存活；唯一丢失的 OCR 阶段标签 i18n
  （`'OCR'` → `t('learningHub:processing.ocrRecognizing')`）手工移植进
  `attachmentModeHelpers.ts` 的 `getStageLabel`。
- `TranslateWorkbench.tsx`：导入区并集（wrapup 的 `DEFAULT_MAX_UPLOAD_FILE_SIZE`
  + F 的 `registerContentSaveHandler`/翻译预设导入）。

### 测试冲突：对齐当前实现（8 文件）

- `tests/ct/mocks/react-i18next.tsx`：两侧同一修复（按 ns 缓存 `t` 防自激循环），
  取 F 写法。
- mindmap 两测试：合并后的 `MindMapCanvas` 同时满足两侧断言，
  `canvasHoverClarity` 取并集（F 的 `isHoverPath`/`isCoarsePointer` 断言 + wrapup 的
  `hoverPathEdgeKeys?.has(edgeKey)` 精确断言）；`blankedTextInteraction` 的
  react-i18next mock 取 wrapup 的「展开真实模块」写法（F 最小面 mock 的超集）。
- `ReferenceSelector.test.tsx` 同上取 wrapup mock 写法。
- `DockWindowList.test.tsx`（rAF 脆弱断言两种修法，取 F 的等真实一帧）、
  `StatusBar.test.tsx`（F 多一条 `data-macos-chrome` 断言，实现支持，取 F）。
- `NotesBacklinksPanel.test.tsx` 断言取并集（出链不漏别名 + 入链行名为来源笔记名）；
  `NotesSearchOverlay.test.tsx` 取 F 的宽松前缀匹配；`NotesWorkspaceApp.test.tsx`
  全取 F（新增 wiki 链接重命名同步、IME 建夹、分页截断等用例，是行为超集），
  去掉一行与 wrapup 已并入注释重复的注释。

## 静默契约碰撞（Git 无文本冲突、定向回归抓到）

`learning-hub-sidebar.integration.test.tsx` 首跑失败：0824 genui 主题在 Sidebar
挂载的 `LearningHubGenerativeBriefing` 用 `t(key, { defaultValue })` 签名，F 的
测试 mock 只处理 `t(key, 'fallback')` 字符串签名，把 options 对象当 React 子节点
渲染直接炸 render。修 mock 补上 defaultValue 语义（真实 i18next 行为），不改产品
代码；随后该测试通过。

## 门禁

| 命令 | 结果 |
| --- | --- |
| `npm ci` | ✅ 1192 packages |
| `npm run version:generate && npm run licenses:check` | ✅ `[license-compliance] OK` |
| `npm run typecheck` | ✅ 0 错误 |
| `npx vite build` | ✅ 2m，仅既有 chunk 体积/循环 chunk 警告 |
| `cargo +stable check --manifest-path src-tauri/Cargo.toml --lib --locked` | ✅ Rust 1.98，无 error（需 `protobuf-compiler` 系统包） |
| 冲突面定向 vitest（15 文件：qbank 契约、workbench shell/desktop、finder 分桶三件套、notes 四件套、mindmap 两件、StatusBar/DockWindowList/AiBriefing/p11） | ✅ 207/207（含修复 mock 后复跑） |
| F 重构面 input-bar 全目录 vitest | ✅ 19 文件 / 171 tests |

本机 Rust 验证补装了 stable 1.98、Tauri Linux 系统依赖、protobuf-compiler，并下载
gitignored 的 PDFium 动态库；下载脚本改写的已跟踪 license 文本已还原，环境产物
未进入提交。

## 给正式合并代理的提示

1. `qbank-tools.ts` 千万不要整文件取 F——0824 侧的 110 行描述压缩在非冲突区。
2. finder 分桶取 F 全套后，记得删 `finderStoreHostBuckets.test.ts`、清
   NavigationContext 死绑定；`FINDER_HOST_IDS` 两侧同名同值，消费方不受影响。
3. wrapup 的 OCR i18n 修补要跟着 `getStageLabel` 搬进 `attachmentModeHelpers.ts`，
   否则静默丢失（typecheck/build 都不报）。
4. 复制失败 i18n 要移植到 `MessageItem` / `ParallelVariantView` /
   `useChatPageEvents` 三处，别只跟随删除 `useMessageActions.ts`。
5. 定向回归必须包含 `learning-hub-sidebar.integration.test.tsx`（defaultValue mock
   碰撞）与 `phase4QbankToolsContract.test.ts`（Step2 契约补回是否仍在）。

## 第八轮复查（B+D 合入后，2026-08-25）

复查基线：`origin/cursor/0824-cde6` @ `4f05d227`（较本预演基线 `af3e39d8`
多了 Step4 B cloud `0e32e0fe` 与 Step5 D anki `a8185664` 及各自后续修复）。

**结论：上述 21 处裁决全部仍成立，逐字节可原样套用。** 依据：

- 21 个冲突文件 + `finderStoreHostBuckets.test.ts` + 全部补丁搬家目标文件
  （MessageItem / ParallelVariantView / useChatPageEvents /
  attachmentModeHelpers / sidebar 集成测试 / finder-host-buckets 测试）在
  `af3e39d8..4f05d227` 间 0824 侧零改动；在 `4f05d227` 上重放 F（`575fee7f`
  仍是 theme-subapp 远端 tip）合并，原 21 处冲突块与本预演逐字节相同。
- 重放树套用本预演全部裁决 + 下述 7 处新冲突解法后：typecheck 0 错误；
  原冲突面定向 vitest 13 文件 195/195；新冲突面 8 文件 80/80。
- lockfile 冲突取 0824 侧（ours）仍逐字节等于新 tip；`package.json` 与
  `legal/THIRD_PARTY_NOTICES.txt`（含 B 的 unicode-normalization 重生成）自动
  合并即达 tip 内容，仍无需重生成——但校验基准应换成 `4f05d227`。

### B+D 带来的新增冲突（7 处，全部 D×F；B 与 F 零重叠）

在 `4f05d227` 上重放共 28 个冲突文件 = 原 21 + 以下 7 个（源头是 theme-anki
的 `9fda519a` / `07146ea9` / `3434fed6` / `984ea373` 与 F 的重叠；F 与 B/D 的
Rust 改动文件交集为空）：

1. `src/features/anki/generateCardsFromText.ts`（AA 双加）：D、F 独立实现了
   同一共享制卡入口，唯一语义差异是 D 用 `cardAgent.startGeneration`（非阻塞
   直启后端管线，任务台跟踪进度），F 用 `cardAgent.generateCards`（阻塞）。
   合并后 CardAgent 两个方法都在，但 D 已把生产路径迁到 `startGeneration`
   并退役 ChatV2AnkiAdapter，**取 D（ours）侧**。
2. `src/features/anki/__tests__/generateCardsFromText.test.ts`（AA）：9 个冲突
   块全是上述 API 改名的镜像，**取 D 侧**。
3. `src/features/chat/services/selectionCardGeneration.ts`：两个冲突块（头注释
   + `startGeneration` 调用），两侧全量差异恰好只有这两块，**可整文件取 ours**。
4. `src/components/EssayGradingWorkbench.tsx`、
   `src/components/essay-grading/GradingMain.tsx`、
   `src/components/essay-grading/ResultPanel.tsx`：正交功能并集。非冲突区已
   自动并入 D 的复习/作文制卡入口，冲突块全部**取 F 侧**（`handleUndoSuggestion`
   反向锚定撤销、`handleSaveAsNote` 存为笔记、`onApplySuggestion` 签名放宽为
   `SuggestionChange`；依赖的 `src/essay-grading/suggestionAnchors.ts` 由 F
   自动并入）。**严禁整文件 checkout 任何一侧**，否则丢 D 的入口或 F 的功能。
5. `docs/user-guide/12-Anki制卡与模板.md`：单块修订注释冲突，取并集。

交叉验证：`cursor/0824-rehearse-step3-fg-cde6` 的 `2016f748`（F+G 刷新到
`4f05d227`）对第 1-3 项的解法与上述逐字节一致，第 4 项仅差 G 的移动端增量
（`sm:`→`md:` 断点、44px 触控热区），可作第二参照。

### 官方合并时新增注意

6. `pdfSelectionToolbar.source.test.ts` 含 `not.toContain('ChatV2AnkiAdapter')`
   防复活断言；F 侧 `src/components/anki/cardforge/adapters/**` 相对 merge-base
   未改动，合并会静默保持 D 的删除——不要手工恢复该目录。
7. 新冲突面定向回归 8 文件：`generateCardsFromText.test.ts`、
   `selectionCardGeneration.test.ts`、`pdfSelectionToolbar.source.test.ts`、
   `tests/vitest/anki/cardforge/CardAgent.test.ts`、
   `tests/vitest/generative-ui/flashcardDisplayOnly.test.ts`、
   `suggestionAnchors.test.ts`、`essayContentState.test.ts`、`radarLabel.test.ts`。
8. F 自身带 Rust 改动（qbank_executor / dstu handlers / vfs migration 等），
   虽与 B/D 零文件交集，cargo 门禁仍要跑。
