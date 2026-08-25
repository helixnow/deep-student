# 0824 G 隔离枝产品差异总审

## 结论

- 审计基线是最新 `origin/cursor/0824-cde6` @ `c119f92ba8b4`；其中正式 G 合并为
  `793624829f02`，随后 `8a350d146` 修复了
  `ReviewQuestionsView.confirmation.test.tsx` 的 `initReactI18next` mock。
- 题列 9 个隔离分支全部存在，含可选的
  `cursor/0824-g-fix-gates-c824`。
- 忽略纯文档后，建议从隔离枝**按 hunk 重放** 23 个文件级条目：Anki/练习/作文
  12 项、chat 契约 5 项、shell 2 项、gates 测试 4 项。
- 不建议 cherry-pick 任一隔离枝的 merge、整提交或整文件。多个隔离枝仍以
  `362dd2df` 为产品基线；直接整树比较中的 605/554 文件大头是“正式 0824 已有、
  隔离枝没有”的反向差异，不是 0824 缺失。
- 尤其不要从 gates 枝恢复 `TextbookCard` / legacy notes 模块；正式 0824 的删除是
  G/F 的显式裁决，恢复会把约 9.7k 行退役树重新带回。

`TAKE` 表示只取表中点名 hunk，并在当前 0824 上重新适配；`SKIP` 表示正式 0824
已等价/更强，或隔离枝版本会回退现有能力。

## 输入与方法

| ref | 审计 tip | 对最新 0824 的非 docs 直接差异文件数 |
| --- | --- | ---: |
| `origin/cursor/0824-cde6` | `c119f92ba8b4` | 基线 |
| `origin/cursor/0824-g-landing-cde6` | `fe7a61f96e53` | 41 |
| `origin/cursor/0824-g-fix-i18n-cde6` | `308cfdab0b40` | 1 |
| `origin/cursor/0824-g-fix-invariants-cde6` | `ccf0075dd256` | 3 |
| `origin/cursor/0824-g-fix-anki-cde6` | `e1edaa44b6f5` | 605 |
| `origin/cursor/0824-g-fix-chat-b0d6` | `e11fc8d24feb` | 47 |
| `origin/cursor/0824-g-fix-reading-cde6` | `6702f972687d` | 2 |
| `origin/cursor/0824-g-fix-shell-cde6` | `064beb1520a8` | 554 |
| `origin/cursor/0824-g-fix-governance-cde6` | `7c02962b5338` | 22 |
| `origin/cursor/0824-g-fix-gates-c824` | `d4dace83318d` | 52 |

审计不是把 direct diff 的 `+` 行机械视为可取项，而是：

1. 先对最新两端树做非 docs direct diff；
2. 再从各枝相对共同基线/merge 后修复提交中提取该枝真正编写的产品 hunk；
3. 逐 hunk 检查正式 0824 是否已等价落地、是否已有更强实现，以及隔离枝是否会
   覆盖 `8a350d14`、G 热区、i18n、`isActive` 返回键门禁或 legacy 删除；
4. 对 partial-domain 枝，把“隔离枝缺正式 G”与“正式 0824 缺隔离枝修复”分开。

纯文档（`docs/**`、Markdown）不进入判断。测试、locale 和产品 CSS 属产品文件，
纳入本审计。

## TAKE：0824 确实缺失的有价值 hunk（全表）

### Anki / 练习 / 作文（来源 `g-fix-anki`）

| 路径 | 0824 现状 | 隔离枝更好在哪 | 建议 |
| --- | --- | --- | --- |
| `src/components/__tests__/ReviewQuestionsView.confirmation.test.tsx` | 有删除二次确认测试，也有最新 `initReactI18next` mock；没有“选中错题必须走共享 `generateCardsFromText` / CardAgent 入口”的回归测试。 | 隔离枝 mock 共享入口并断言 `content`、`deckName`、`maxCards`，能防止错题制卡重回旁路。隔离枝同时删了 `initReactI18next`，该部分不能取。 | **TAKE**：仅重放 hoisted mock、`beforeEach` 和新用例；保留 0824 的 `initReactI18next`。 |
| `src/components/essay-grading/ResultPanel.tsx` | copy/export 已是 coarse 44px，retry 也已有 44px；但结果栏 header 在 coarse 下仍为 41px，且“存为笔记”仍是 40px。 | 隔离枝给 header 增加 `shrink-0` + coarse `h-11`，并把 save-note 从 coarse `h-10/w-10` 提到 `h-11/w-11`。 | **TAKE**：只取这两个热区 hunk；不要取隔离枝 `sm`/`md` 可见断点差异。 |
| `src/components/essay-grading/__tests__/ResultPanel.actions.test.tsx` | 文件不存在；作文的锚定 apply/undo、存笔记、制卡常显/禁用态缺少组合回归。 | 隔离枝新增 2 个用例，同时锁定 apply/undo、save-note、make-cards 以及 coarse class。 | **TAKE**：新增测试，并与上行 `ResultPanel` hunk 一起落。 |
| `src/components/practice/DailyPracticeMode.tsx` | 上/下月按钮已有 44px，但两个 icon-only 按钮没有可访问名。 | 隔离枝增加 `aria-label={t('daily.previousMonth')}` / `nextMonth`。 | **TAKE**：只取两个 aria-label；其余热区已落地。 |
| `src/locales/en-US/practice.json` | 无 `daily.previousMonth` / `daily.nextMonth`。 | 提供英文可访问名。 | **TAKE**：增加两个 key。 |
| `src/locales/zh-CN/practice.json` | 无 `daily.previousMonth` / `daily.nextMonth`。 | 提供中文可访问名。 | **TAKE**：增加两个 key。 |
| `src/locales/en-US/flashcards.json` | `today.streakHint` 仍称“按每卡最近复习估算”，与当前“优先完整日志、不可用才 fallback”的实现不符。 | 隔离枝文案准确描述 local-day 日志计算与 fallback。 | **TAKE**。 |
| `src/locales/zh-CN/flashcards.json` | 同上，中文提示仍只描述估算路径。 | 隔离枝文案与真实/回退双路径一致。 | **TAKE**。 |
| `src/features/flashcards/screens/LibraryScreen.tsx` | 搜索、批量、分页、空态动作大多已是 coarse 44px；手动建卡 front/back 两个输入仍只有 `h-10`。 | 隔离枝只在 coarse 指针下把两个输入升为 `h-11`，不改变桌面密度。 | **TAKE**：仅两个 composer input class。 |
| `tests/vitest/flashcards/LibraryScreen.test.tsx` | 没有从空卡库 `.apkg` 入口到 file picker、`import_apkg_to_library`、due refresh、列表刷新和成功通知的链路测试。 | 隔离枝覆盖完整导入闭环；后续 `309e92a7` 已把 picker 标题断言从 locale 精确值改为 `.apkg` 语义匹配。 | **TAKE**：取 `309e92a7` 后的最终测试 hunk。 |
| `tests/vitest/flashcards/TodayScreen.emptyLibrary.test.tsx` | 文件不存在；产品实现已能区分空卡库，但没有防“空库显示 100%/今日完成”的回归。 | 隔离枝断言空库 onboarding、0% ring、无 `allDone`，并覆盖跳转卡库。 | **TAKE**。 |
| `tests/vitest/flashcards/reviewActivityStreak.test.ts` | 文件不存在；当前 streak helper 无直接日历边界测试。 | 隔离枝覆盖今天连续、昨天延续并由 stats 补今天、断档和历史最长 streak。 | **TAKE**。 |

### Chat 拆分契约（来源 `g-fix-chat`）

| 路径 | 0824 现状 | 隔离枝更好在哪 | 建议 |
| --- | --- | --- | --- |
| `src/features/chat/components/input-bar/__tests__/InputBarUI.mobileSplitContract.source.test.ts` | 文件不存在；正式 0824 已完成 `InputBarUI` 拆分和 G hotzone 重放，但没有单一契约防止旧胖文件回流。 | 隔离枝锁定 Composer/Attachment 所有权、coarse 44px、iOS 16px、compact hints 及 OCR i18n helper。 | **TAKE**。 |
| `src/features/chat/pages/__tests__/sessionSidebarTypography.test.tsx` | 生产 `SessionSidebarContent` 已用 `text-ui`，测试仍期待 `text-[13px]`。 | 隔离枝把普通/选中项断言同步到语义字号 token。 | **TAKE**。 |
| `tests/vitest/chatV2ComposerPanelTokensContract.test.ts` | 测试仍从 `InputBarUI.tsx` 查 attachment panel token，和拆分后的职责边界不符。 | 隔离枝改从 `AttachmentPanelBody.tsx` 检查 muted/control/focus token，并保留负向颜色断言。 | **TAKE**。 |
| `tests/vitest/chatV2InputBarRadiusContract.test.ts` | 测试仍从 `InputBarUI.tsx` 查 `iconButtonClass`、thinking runtime、send/stop。 | 隔离枝改查 `ComposerToolbar.tsx`，继续锁定 shell control radius 与仅 send/stop 圆形。 | **TAKE**。 |
| `tests/vitest/chatV2SendButtonContract.test.ts` | 测试仍假定箭头、按钮 class 与 empty-state 判定都在 `InputBarUI`。 | 隔离枝最终版按 split ownership 检查 Toolbar，并锁定 `isComposerEmpty` prop 传递及 coarse 44px。 | **TAKE**：取 `7890d318` 后最终 hunk。 |

### Shell / dead-code（来源 `g-fix-shell`）

| 路径 | 0824 现状 | 隔离枝更好在哪 | 建议 |
| --- | --- | --- | --- |
| `src/components/ui/DsDialog.tsx` | AlertDialog 的 cancel/confirm 已有 coarse `min-h-11`，可选 secondary action 没有。 | 隔离枝让三种页脚动作遵守同一 44px 触控基线。 | **TAKE**：只取 secondary button 的 class。 |
| `src/features/notes/__tests__/PreviewPanel.i18n.test.ts` | 测试仍存在并 `readFileSync('../PreviewPanel.tsx')`，但正式 0824 已按 G 删除 `PreviewPanel.tsx`；这是确定性的孤儿测试。 | 隔离枝随退役组件删除该测试，和当前产品树一致。 | **TAKE**：删除测试文件；locale 孤儿 key 是否清理由后续 i18n 清扫决定。 |

### Gates 契约修复（来源 `g-fix-gates`）

| 路径 | 0824 现状 | 隔离枝更好在哪 | 建议 |
| --- | --- | --- | --- |
| `src/features/workbench/apps/desktop/__tests__/desktopGlobalSearch.test.ts` | 只 mock `i18next`，仍可能加载真实 `@/i18n` bootstrap；mock 也缺 `isInitialized`。 | 隔离枝同时隔离 `@/i18n`，并补完整 i18next 初始化契约，避免收集阶段失败。 | **TAKE**。 |
| `tests/vitest/data-governance/DataGovernanceDashboard.backup-restore-ui.test.tsx` | `backupAndExportZip` 断言仍少最新可选 E2EE 参数槽。 | 隔离枝补完整调用签名，不删业务断言。 | **TAKE**。 |
| `tests/vitest/data-governance/DataGovernanceDashboard.restore-operations.test.tsx` | ZIP import 测试绕过了新增可选密码确认层，`importZip` / `exportZip` 断言也是旧签名。 | 隔离枝真实点击空密码确认层，并对最终 API 的全部可选参数做断言；`bd9437c4` 再补齐最后一个 import 参数。 | **TAKE**：取 gates tip 最终版，不取中间提交。 |
| `tests/vitest/settings/OpenSourceAcknowledgementsSection.test.tsx` | 全套件全局固定桌面 viewport，却有一个用例声称验证移动内联分支。 | 隔离枝改为每用例默认桌面、移动用例显式 390px，桌面 Dialog 与移动 inline 都真正被覆盖。 | **TAKE**。 |

## SKIP：完整排除表

### 按分支核销

| 分支 | 0824 现状 | 隔离枝差异及为何不取 | 建议 |
| --- | --- | --- | --- |
| `g-landing`（41 文件） | 正式 `79362482` 已用更新的逐文件裁决合 G，并把 landing 的 `AttachmentPanelBody`、`InputBarUI` 与 secondary-shell 修复等价落地。 | 37 个冲突文件是较旧裁决；正式版额外保留 i18n、更多 coarse hotzone 与 F split。review test 缺最新 mock；`finderStore.ts` 仅多一个全仓无 import 的 `useHostFinderStore` alias；`generateCardsFromText.ts` 与 `ComposerToolbar.tsx` 仅注释差异。 | **SKIP 全枝**；不要 cherry-pick。 |
| `g-fix-i18n`（1 文件） | `ReviewQuestionsView.confirmation.test.tsx` 已由 `8a350d14` 增加必需的 `initReactI18next`。 | 隔离枝反而缺该 mock。其 SkillsList/AnkiTasks i18n 修复已经正式落地，因此不再出现在 direct diff。 | **SKIP**。 |
| `g-fix-invariants`（3 文件） | 正式版保留 `initReactI18next`，SkillsList favorite/edit/more 与 AnkiTasks clear 均走 i18n。 | 隔离枝三处 residual 分别删除 mock、把 SkillsList aria 退回 `"favorite"/"edit"/"more"`、把 clear 退回 `"clear"`。leftovers-safe 不变量已在正式基线。 | **SKIP**。 |
| `g-fix-anki`（605 文件） | 正式 0824 含完整 G；该枝只做 Anki 域，故 589 个 direct-diff 路径主要是隔离枝缺正式 G。 | `95d50747` 的 17 个产品路径已逐项核销：`TodayScreen.tsx` 已等价落地，另外 16 个仍在 direct diff；12 个文件的特定 hunk 在 TAKE 表，5 个不取路径见下表。 | **只取 TAKE 表 hunk**。 |
| `g-fix-chat`（47 文件） | 正式版已完成 InputBar split + G 重放。 | 5 个测试路径在 TAKE 表；`AttachmentPanelBody.tsx` 仅格式差异，`ComposerToolbar.tsx` 仅注释差异；其余 40 路径是较旧的非 chat 冲突裁决，正式版更新。 | **只取 5 个测试**。 |
| `g-fix-reading`（2 文件） | 正式版 ComposerToolbar 行为与 reading 枝一致，并有最新 review test mock。 | `ComposerToolbar.tsx` 只差注释；review test 会删 `initReactI18next`。Finder/PDF 正式实现已含 reading 枝验证的关键热区。 | **SKIP**。 |
| `g-fix-shell`（554 文件） | 正式版含完整 G；shell 枝只落 shell/dead-code 域。其修复提交 50 路径中 37 路径已逐 blob/语义落地。 | 541 个其它 direct-diff 路径是该 partial 枝缺正式 G；修复提交剩余 13 个 residual 中 2 个在 TAKE 表，另外 11 个会删除/弱化正式 notes mobile 热区或高特异性 coarse CSS。 | **只取 2 项**。 |
| `g-fix-governance`（22 文件） | 正式版使用更新的 authoritative governance + split InputBar 裁决。 | 隔离枝在 `InputBarUI`/Toolbar/AttachmentPanel 缺正式重放的 44px hunk；其余文件是旧 FG 占位，常见回退包括 i18n、Expose、legacy navigation 和 notes CSS。 | **SKIP 全枝**。 |
| `g-fix-gates`（52 文件） | 正式版按 G/F 显式删除 legacy notes，并保留 Finder/PDF/MCP/Vendor 最新 coarse 规则。 | 4 个测试路径在 TAKE 表；其余 48 路径中 39 个复活退役模块，9 个会弱化正式热区或只是注释差。 | **只取 4 个测试**。 |

### `g-fix-anki` 中不取的 5 个产品路径

| 路径 | 0824 现状 | 隔离枝版本 | 建议 |
| --- | --- | --- | --- |
| `src/components/ReviewQuestionsView.tsx` | coarse 指针行/checkbox/chevron/sort 热区更完整；quick-redo 44px 已在位。 | 改用窄屏断点而非 pointer 语义，并丢 sort coarse class；quick-redo 只是 class 顺序差。 | **SKIP**。 |
| `src/components/practice/PracticeLauncher.tsx` | 保留 `isActive`，隐藏 keep-alive 实例不会注册 Android back handler；tag/返回热区已落地。 | 丢 `isActive` 及向 Timed/Mock/Paper 的传递。 | **SKIP**。 |
| `src/features/chat/plugins/blocks/ankiCardsBlock.tsx` | 正式版在 task controls、批量操作、分页、布局切换及 inline action 上已有更多/更大的 coarse 热区。 | 隔离枝缺这些正式 hunk，部分 44px 还从 `min-*` 改成固定 `h/w`。 | **SKIP**。 |
| `src/features/flashcards/library/library.css` | chip 已 44×44，且 coarse 设备行内 action 常显并有 44px 兜底。 | 仅 chip 达 44px；行内 action 仍依赖 `hover:none`，会漏掉报告 hover 能力的触屏平板。 | **SKIP**。 |
| `src/features/flashcards/screens/TodayScreen.tsx` | 与隔离枝修复后 blob 等价。 | 没有剩余价值。 | **SKIP**。 |

### `g-fix-shell` 中不取的 11 个 residual 路径

| 路径集合 | 0824 现状 | 隔离枝版本 | 建议 |
| --- | --- | --- | --- |
| `src/features/notes/AIDiffPanel.tsx`; `NotesContextPanel.tsx`; `NotesContextPanel.css`; `NotesCrepeEditor.tsx`; `NotesLibraryManager.tsx`; `components/FindReplacePanel.tsx`; `components/NotesEditorHeader.tsx`; `components/NotesEditorHeader.css`; `components/NotesEditorToolbar.tsx` | 正式版已落 G 的 notes editor coarse 热区。 | shell 枝明确把这些移动域 hunk 留给别的代理，因此版本更旧；例如多个 `!min-h-11/!min-w-11` 缺失或降为无 `!`。 | **SKIP**。 |
| `src/features/settings/components/VendorSidebar.tsx` | coarse 平板行高与拖拽指示常显都在位。 | 仅注释表述不同，行为没有更强。 | **SKIP**。 |
| `src/shared/styles/deep-student.css` | 有源序靠后的高特异性 coarse `!min-h/!min-w` 兜底，防 20–24px legacy class 压过热区。 | 删除该兜底。 | **SKIP**。 |

### `g-fix-gates` 中不取的 48 个路径

| 路径集合 | 0824 现状 | 隔离枝版本 | 建议 |
| --- | --- | --- | --- |
| `src/components/TextbookCard.tsx`; `src/features/notes/DndFileTree/**`; `InvalidReferenceOverlay.tsx`; `NotesContext.tsx`; `NotesHeader.tsx`; `NotesHome.tsx`; `NotesSidebarV2.tsx`; `NotesTabsBar.tsx`; `PreviewPanel.tsx`; `notes/__tests__/NoteTagsEditor.test.tsx`; `notes/__tests__/NotesSidebarSearch.test.tsx`; `notes/components/AddReferenceDropdown.tsx`; `NoteTagsEditor.tsx`; `NotesSidebarSearch.tsx`; `notes/dialogs/NotesLibraryDialog.tsx`; `TrashDialog.tsx`; `notes/preview/**`; `notes/reference-selector/**`; `notes/styles/dnd-file-tree.css`; `notes-home.css`; `notes-tabs-bar.css`; `src/features/workbench/apps/notes/workspaceShared.tsx`（共 39 路径） | 正式版已按 G/F 删除退役 notes 树；`TextbookCard` 在 `src` 无生产 import，仅 stale scan-data 字符串命中。 | gates 枝为通过旧树 typecheck，把约 9.7k 行模块及 `NotesContext` dialog state 整体复活。与正式 merge 的明确删除方向冲突。 | **SKIP**，严禁整提交取 `444eb022` / `7e9714bc`。 |
| `src/components/__tests__/ReviewQuestionsView.confirmation.test.tsx` | 有 `8a350d14` 的完整 i18n mock。 | gates tip 缺该 mock。 | **SKIP**。 |
| `src/features/chat/components/input-bar/ComposerToolbar.tsx` | 行为完整。 | 仅注释更短。 | **SKIP**。 |
| `src/features/learning-hub/components/finder/FinderToolbar.tsx` | compact overflow 32/40px 视觉外还有 `after:-inset-1`，实际命中区 ≥44px。 | 删除伪元素扩区。 | **SKIP**。 |
| `src/features/pdf/components/EnhancedPdfViewer.tsx` | outline/thumbnails/bookmarks/highlights 四个移动 tab 均有 coarse `min-h-11`。 | bookmarks/highlights 两个 tab 丢 44px。 | **SKIP**。 |
| `src/features/settings/components/McpToolsSection.tsx` | quick action 与 preset add 在 coarse 下 44px。 | 删除两处热区。 | **SKIP**。 |
| `src/features/settings/components/VendorSidebar.tsx` | coarse 平板行高和拖拽指示常显在位。 | 删除两项。 | **SKIP**。 |
| `src/features/workbench/components/DesktopContextMenu.css`; `EmptyDesktop.css` | 触控行为相同，正式注释更明确区分细指针密度。 | 仅注释差。 | **SKIP**。 |
| `src/styles/responsive-utilities.css` | legacy `.rct-tree` 已随退役树删除；现代 workbench notes 有自己的规则。 | 重新增加 legacy `.rct-tree` drawer 规则。 | **SKIP**。 |

## 落地顺序建议

1. 先取 `g-fix-anki` 的 12 项；`ResultPanel` 与其新测试、Daily aria 与双语 key
   分别成原子组。
2. 再取 chat 的 5 个纯契约测试；这些测试应以当前 Toolbar/Attachment 格式适配，
   不要 checkout 隔离枝源文件。
3. 取 `DsDialog` secondary 热区并删除孤儿 `PreviewPanel.i18n.test.ts`。
4. 最后取 gates 的 4 个测试修复，按当前 API 类型复核参数位。
5. 定向跑上述测试，再跑 typecheck；不要为让旧测试通过而复活 legacy notes。

## 可复现命令

非 docs 直接差异计数使用：

```bash
git diff --name-only \
  origin/cursor/0824-cde6 \
  origin/<隔离枝> \
  -- ':(exclude)docs/**' ':(exclude)**/*.md'
```

分支 authored hunk 使用对应 merge 后修复提交核销：

- landing：`5e57228f`、`36fcb9fe`
- Anki：`95d50747`、`309e92a7`
- chat：`e7d0a3d2`、`7890d318`，以及 merge 中新增的 split contract
- shell：`904b0fd0`
- gates：`444eb022`、`7e9714bc`、`b8dbaafd`、`94daf74a`、`6a339d9e`、
  `bd9437c4`

最终建议以本报告 TAKE 表为准，而不是以上提交为 cherry-pick 单位。
