# 0824 预演：F subapp 合入（rehearsal）

日期：2026-08-24  
预演分支：`cursor/0824-rehearse-subapp-cde6`（不回推 0824，仅预演）  
基准：`origin/cursor/0824-cde6` @ `8361e6b7`（已含 E #213 + C #214）  
被合入：`origin/cursor/0824-theme-subapp-cde6` @ `115b202a`（主题仓 F，#176 系）

结论：**可合**。冲突 3 处、全部低风险；四项编译门禁全绿；无需产品代码补丁。

## 1. 合并记录

Merge commit：`d44b4235`（`merge: rehearse theme-F subapp (115b202a) into 0824`）。

冲突与解法（按「产品代码留 F、构建听 #213」）：

| 文件 | 冲突 | 解法 |
|---|---|---|
| `package-lock.json` | content | 取 0824 基线侧（#213 重生成后的 lock）。F 侧 `package.json` 与基线完全一致（F 仅从 lock 删了 12 行传递依赖记录），无需重生成，`npm ci` 通过验证。 |
| `src/features/chat/skills/builtin-tools/qbank-tools.ts` | 2 处 hunk | 全取 F：`qbank_get_daily_practice` 的 `count` 上限 20→50、描述补【必填】；`qbank_get_check_in_calendar` 新增可选 `daily_target`。F 对应的 Rust 侧 `qbank_executor.rs` 已由 git 自动并入，schema 与执行器语义一致。 |
| `src/features/workbench/components/WorkbenchDesktop.tsx` | import 冲突 | 取并集：保留基线侧 `DesktopAiBriefingWidget` 与 F 侧 `ImmersiveHint` 两个 import。正文两个组件均被渲染（559 行 / 616 行），两个组件文件都存在，无二义。 |

与 #214 的交叉面符合预期——文本冲突少：`TranslateWorkbench.tsx`、
`ChatV2Page.tsx`、`ExamContentView.tsx`、`LearningHubSidebar.tsx`、
`NotesContextPanel.tsx`、`commands.rs` 等均由 git 自动合并成功。
建议回归点（自动合并≠语义无碰撞）：TranslateWorkbench 的分栏/流式渲染、
ChatV2 页面挂载 generative-ui 面板的路径、学习中心考试视图。

## 2. 编译门禁（全部通过）

| 门禁 | 结果 |
|---|---|
| `npm ci` | ✅ |
| `npm run typecheck` | ✅（同 step 1 备忘：需先 `npm run version:generate` 生成 gitignored 的 `src/version.ts`） |
| `npx vite build` | ✅ 1m15s，仅 chunk 体积警告 |
| `cargo check --manifest-path src-tauri/Cargo.toml --lib` | ✅ 3m08s，仅 22 条既有警告 |

环境备忘（本轮门禁失败全部是环境问题，与合并无关，重放时先备好）：

- Rust 需 stable ≥ 1.85（依赖 `ppt-rs 0.2.14` 要 edition2024；1.83 直接解析失败）。
- Linux 侧 cargo check 需要：`libgtk-3-dev libwebkit2gtk-4.1-dev
  libayatana-appindicator3-dev librsvg2-dev libsoup-3.0-dev
  libjavascriptcoregtk-4.1-dev protobuf-compiler`。
- Tauri build.rs 强校验 `src-tauri/resources/pdfium/libpdfium.so`，
  先跑 `bash scripts/download-pdfium.sh`（脚本会覆写 licenses/，注意别把它带进提交）。

## 3. 与 G mobile（后续第 21 步 / #172 系）冲突预备策略

总方针沿用 MERGE-PLAN 第 5 节：**主体用 F，重放 G 热区增量**。
即冲突文件以 F（本预演结果）为基底整版保留，G 的移动端适配作为
「热区补丁」逐块重放，而不是让 git 在整文件层面二选一。

### 3.1 干跑数据（本预演 HEAD `d44b4235` × G tip `4ab24435`）

- F 与 G 相对 0824 基线的改动文件交集：84 个。
- 真实 merge 干跑冲突：**25 个文件**（已 abort，未留痕）：

```text
src/components/ReviewQuestionsView.tsx
src/components/essay-grading/StreamingAnnotatedText.tsx
src/components/shared/Resizable.tsx
src/components/skills-management/SkillsManagementPage.tsx
src/components/ui/DsDialog.tsx
src/features/anki-tasks/AnkiTasksApp.tsx
src/features/anki-tasks/components/SessionRow.tsx
src/features/chat/components/input-bar/InputBarUI.tsx
src/features/flashcards/screens/StatisticsScreen.tsx
src/features/flashcards/screens/TodayScreen.tsx
src/features/learning-hub/apps/views/EpubPreview.tsx
src/features/learning-hub/apps/views/FileContentView.tsx
src/features/learning-hub/apps/views/TextbookContentView.tsx
src/features/learning-hub/apps/views/media/VideoPlayer.tsx
src/features/learning-hub/components/finder/FinderToolbar.tsx
src/features/learning-hub/views/IndexStatusView.tsx
src/features/notes/components/NoteTagsEditor.tsx
src/features/notes/reference-selector/ReferenceSelector.tsx
src/features/notes/reference-selector/__tests__/ReferenceSelector.test.tsx
src/features/pdf/components/EnhancedPdfViewer.tsx
src/features/settings/components/VendorSidebar.tsx
src/features/todo/components/TodoMainPanel.tsx
src/features/workbench/apps/notes/NotesWorkspaceApp.css
src/features/workbench/components/ExposeOverlay.css
src/features/workbench/core/legacyNavigationMap.ts
```

### 3.2 重放方法（到第 21 步执行）

1. 冲突文件先 `git checkout --ours`（= F/本预演侧）拿到基底。
2. 对每个文件用 `git diff <merge-base> origin/cursor/0824-theme-mobile-cde6
   -- <file>` 提取 G 的增量，只重放移动端热区：断点/媒体查询、触控目标
   尺寸、`safe-area`、抽屉化/底栏导航、滚动容器改造；G 对同一行的
   桌面语义改写一律弃掉，以 F 为准。
3. 分组提示：
   - workbench CSS（`NotesWorkspaceApp.css`、`ExposeOverlay.css` 等）：
     F 是结构性重写，G 多为响应式覆盖——把 G 的规则追加为独立
     `@media` 块，不改 F 的选择器结构。
   - `legacyNavigationMap.ts`：F 与 G 都动过路由映射；以 F 表为准，
     逐条补 G 新增的 legacy key，不删 F 的映射。
   - 测试（`ReferenceSelector.test.tsx` 等）：按 MERGE-PLAN 第 7 节
     ——产品改动不被旧测试覆盖；断言跟随合并后的产品行为改写。
   - `IndexStatusView.tsx`、`VendorSidebar.tsx` 不在 F 改动集里
     （冲突来自基线侧 #213/#214 的改动 × G），解法是「基线为主、
     重放 G 热区」，同一手法。
4. lock / NOTICES 若再冲突：仍按主题仓规则重生成，不手改。
5. 重放完跑同一套四项门禁 + TranslateWorkbench / workbench 桌面
   / learning-hub 三个回归点。

## 4. 后续

- 本分支仅预演存档；0824 正式吸收 F 时按第 1 节解法重放即可
  （或直接 merge 本分支验证过的 tree）。
- 不推 0824、不动 main。
