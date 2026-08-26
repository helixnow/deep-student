# Wave2 会话 C · 第 10 轮红线自证（r10-redlines）

- 时间：2026-08-26（UTC）
- 分支：`cursor/0824-wave2-mobile-uiux-a875` @ `fe8ff43c`（fix: close Wave2-C R9 chrome gaps and refresh mobile contracts）
- 基线：`origin/cursor/0824-cde6`（已 `git fetch origin cursor/0824-cde6`）
- diff 口径：`git diff --name-only origin/cursor/0824-cde6...HEAD`，共 **182 个文件**
- 本轮性质：只读 grep + 本文档，不改产品源，不 commit。

---

## 红线 1：禁改区未动 ✅

### 1a. Rust 后端（coordinator.rs / tool_loop / hooks / 缓存链 / WebDAV / S3 / FTP）

```bash
git diff --name-only origin/cursor/0824-cde6...HEAD -- src-tauri | wc -l
# → 0

git diff --name-only origin/cursor/0824-cde6...HEAD | grep -iE 'coordinator\.rs|tool_loop|src-tauri|\.rs$|\.github/workflows'
# → 无输出，exit=1
```

禁改文件在仓库中的实际位置（`git ls-files` 确认），全部不在 diff：

- `src-tauri/src/chat_v2/workspace/coordinator.rs`、`src-tauri/src/data_governance/migration/coordinator.rs`
- `src-tauri/src/chat_v2/pipeline/tool_loop.rs`、`src-tauri/src/chat_v2/pipeline/hooks.rs`
- `src-tauri/src/cloud_storage/webdav.rs`、`s3.rs`、`ftp.rs`、`src-tauri/src/vfs/repos/path_cache_repo.rs`

补充：`grep -iE 'webdav|/s3|ftp|hooks|cache'` 对 diff 清单仅命中 2 个**前端**文件——`src/features/settings/hooks/useKeyboardInset.ts`、`src/hooks/__tests__/useKeyboardHeight.contract.source.test.ts`（键盘 inset 收编，属本会话职责范围，非后端 hooks/缓存链）。

### 1b. anki / qbank 服务层

```bash
git diff --name-only origin/cursor/0824-cde6...HEAD | grep -iE 'anki|qbank|question'
# → docs/dev/wave2-C-r1/04-anki-qbank-chrome.md
#   docs/dev/wave2-C-r5/03-anki-chrome.md
#   src/components/QuestionBankManageView.tsx
```

仅文档 ×2 + 前端视图 ×1。`QuestionBankManageView.tsx` diff（+7/-5）内容为 aria-label 补齐、`[@media(pointer:coarse)]:!min-h-[44px]` 触屏热区与注释——纯 chrome 层，无任何服务层/数据层调用变更。`anki_*_service.rs`、`apkg_*.rs` 等服务层全部零改动（见 1a 的 src-tauri diff=0）。

### 1c. ComposerPanelOverlay 桌面语义

```bash
git diff --name-only origin/cursor/0824-cde6...HEAD | grep -i 'ComposerPanelOverlay'
# → 无输出，exit=1
```

`src/features/chat/components/input-bar/ComposerPanelOverlay.tsx` 及其 CT story/spec 完全不在 diff——桌面语义按定义未动。

### 1d. .github/workflows

```bash
git diff --name-only origin/cursor/0824-cde6...HEAD -- .github/ | wc -l
# → 0
```

---

## 红线 2：input-bar 产品源新增 `!min-h-11` / 内联 `after:-inset` = 0 ✅

```bash
git diff origin/cursor/0824-cde6...HEAD -- \
  'src/features/chat/components/input-bar/*.tsx' \
  'src/features/chat/components/input-bar/*.ts' \
  ':!src/features/chat/components/input-bar/__tests__' \
  | grep -E '^\+' | grep -E '!min-h-11|after:-inset'
```

结果（共 3 行，全部为注释，无一是类名）：

| 命中行 | 所在文件 | 性质 |
| --- | --- | --- |
| `+// after:-inset 伪元素外扩——伪元素会越过 gap 与相邻控件的命中区互相重叠）` | `ComposerToolbar.tsx` | `//` 注释 |
| `+          tabIndex 与 after:-inset 伪元素命中区（避免与外层触发器双重重叠） */}` | `ComposerToolbar.tsx` | JSX 注释块 |
| `+            不再用透明 after:-inset 伪元素外扩命中区（会与相邻控件命中区重叠）。` | `ContextUsagePopover.tsx` | JSX 注释块 |

- `!min-h-11`：新增行命中 **0**。
- `after:-inset`：新增行命中仅上述 3 条注释（解释为什么**不再**用伪元素外扩），符合"注释除外"豁免。
- `coarseHit.ts` 位于 `src/components/ui/coarseHit.ts`（input-bar 目录之外），其导入语句不含红线字面量，本轮无需动用该豁免。

---

## 红线 3：sessionActions 只碰 remove/clear，发送/流式段不在 diff ✅

```bash
git diff --stat origin/cursor/0824-cde6...HEAD -- src/features/chat/core/store/sessionActions.ts
# → 1 file changed, 38 insertions(+), 12 deletions(-)

git diff -U0 origin/cursor/0824-cde6...HEAD -- src/features/chat/core/store/sessionActions.ts | grep -E '^@@'
# → @@ -10,0 +11 @@        （import cancelPdfProcessing）
#   @@ -75,0 +77,14 @@     （新增 cancelAttachmentProcessing 辅助函数）
#   @@ -217,0 +233,16 @@   （removeAttachment：cancel + pdfProcessingStore 清理移至 sourceId 门控）
#   @@ -226,12 +256,0 @@   （removeAttachment：删除旧的 resourceId 门控下清理）
#   @@ -262,0 +282,7 @@    （clearAttachments：逐个 fire-and-forget 取消）
```

hunk 归属核对（HEAD 行号）：

- `removeAttachment` 定义于 L219，`clearAttachments` 定义于 L266——全部 5 个 hunk（新侧最大触及行 288）都落在这两个 action 与其支撑代码（import + 辅助函数）内。
- 发送/流式段位置：`currentStreamingMessageId`/`streamingVariantIds` 初始化在 L471-473，`_abortCallback` 在 L609，`continueMessage`/`sendMessage` 回退逻辑在 L644-664——**均在最后一个 hunk（L288）之后，零触碰**。

```bash
grep -nE 'sendMessage|stream|Stream|abort' src/features/chat/core/store/sessionActions.ts | head
# → 首个命中 L471，晚于全部 hunk
```

---

## 红线 4：不变量 18 仍在（口径同 r1/08 报告 §4）✅

### 4a. Flow legal/NOTICES

```bash
ls -la legal/THIRD_PARTY_NOTICES.txt
# → -rw-r--r-- 1.25MB，在位

rg -n 'flowtoken|@xyflow' legal/THIRD_PARTY_NOTICES.txt | head -4
# → L3810 NPM: @nvq/flowtoken@2.0.6
#   L4167 NPM: @xyflow/react@12.11.2
#   L4170 NPM: @xyflow/system@0.0.79
```

### 4b. Composer* 拆分仍在

```bash
ls src/features/chat/components/input-bar/ | grep -E '^Composer|composerDraft'
# → composerDraftStorage.ts / ComposerInlinePanel.tsx / ComposerPanel(/ComposerPanel.tsx)
#   ComposerPanelOverlay.tsx / ComposerPlusMenu.tsx / ComposerTextarea.tsx / ComposerToolbar.tsx
```

契约守卫 `__tests__/InputBarUI.mobileSplitContract.source.test.ts` 在位（ls 确认）。

### 4c. G 44px token

```bash
grep -n 'control-height-touch' src/styles/shadcn-variables.css src/styles/responsive-utilities.css
# → shadcn-variables.css L41  --control-height-touch: 44px;
#   shadcn-variables.css L42  --touch-target-size: var(--control-height-touch);
#   responsive-utilities.css L159  min-height: var(--control-height-touch, 44px);
```

另有 `responsive-utilities.css` L30-32 `.touch-target{min-height:44px!important; min-width:44px!important}`（coarse pointer 档）与 L134 抽屉导航行 44px 基线，均在位。

### 4d. safe-area

```bash
rg -n 'safe-area' src/app/shell/mobileShell.ts | head -6
# → L4-8 四向 var(--android-safe-area-*, env(safe-area-inset-*, 0px))
#   L13-14 --mobile-safe-area-top/bottom 变量名导出

rg -n 'safe-area-inset' src/styles/ios-safe-area.css | head
# → L21-24 :root 四向 env() 映射 + L27-28 --mobile-safe-area-* 兜底
```

### 4e. Android back

```bash
ls src/app/navigation/androidBackCoordinator.ts
# → 在位

rg -n 'installAndroidBackBridge' src/App.tsx
# → L91 import { installAndroidBackBridge, registerBackHandler, BACK_PRIORITY }
#   L1567 installAndroidBackBridge();
```

---

## 结论

四项红线全部通过：

1. 禁改区（coordinator.rs / tool_loop / hooks / 缓存链 / anki·qbank 服务层 / ComposerPanelOverlay 桌面语义 / WebDAV·S3·FTP rust / workflows）在 182 文件 diff 中零命中；
2. input-bar 产品源新增 `!min-h-11` = 0、内联 `after:-inset` = 0（仅 3 条解释性注释，符合豁免）；
3. `sessionActions.ts` 全部 5 个 hunk 落在 remove/clear 语义（`removeAttachment` / `clearAttachments` + 支撑 import/辅助函数），发送/流式段（L471+）零触碰；
4. 不变量 18 五要素（Flow NOTICES、Composer* 拆分、44px token、safe-area、Android back 桥）全部在位。

本轮为只读自证，未 commit。
