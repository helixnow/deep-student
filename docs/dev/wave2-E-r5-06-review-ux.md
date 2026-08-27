# Wave2-E R5-06 复习会话 UX 打磨（SOTA-复习）

轮次：0824 Wave2-E 第 5 轮。范围独占：`src/features/flashcards/screens/ReviewSessionScreen.tsx`、
`src/features/flashcards/review/*`（新建 `review/UndoNudge.tsx`）。
不改 `FlashcardsAppWindow.tsx`、FSRS 算法、隐私 opt-in、`flashcards.json`（避免与并行角色冲突）。

## 本轮落地

### 1. 评分后可见的撤销入口（`review/UndoNudge.tsx`，新建）

- 评分落地后（撤销栈栈顶 `lastReview.logId` 变为新值），评分栏上方出现一条瞬态提示：
  「已评：良好 · [撤销评分 Z]」，点击按钮即调用既有 `undoLastReview()`。
- 纯前端瞬态 UI，8s TTL 自动隐藏；再评一张 / 撤销 / 会话重置（栈顶变化）时重置。
- 以「挂载时的栈顶」为基线，只对挂载后新增的评分弹提示——会话中途重挂载（切 tab 回来）不重复打扰。
- 回执 `rating` 缺失（外部 reconcile 剔除过回执）时降级为通用文案「已记录复习」。
- 不新增撤销通路：与工具栏撤销按钮、快捷键 Z / Ctrl/Cmd+Z、完成态撤销按钮共用同一 store action。

### 2. 本卡作答用时显示 60s 封顶（只显示，不落库）

- `ReviewSessionScreen` 顶部计时 chip：本卡用时 ≥ 60s 后定格显示 `1:00+`，
  tooltip 换成说明文案（超过 1 分钟，仅显示封顶，不影响统计）。
- 仅 UI 层封顶（`CARD_TIMER_DISPLAY_CAP_MS = 60_000`）。落库的作答用时不受影响，
  仍由 store 侧 `MAX_ANSWER_DURATION_MS`（10 min，对齐 Anki max answer time）截断。

### 3. 键盘 1–4 / 空格：已存在，未重复造

盘点确认以下键位在 `ReviewSessionScreen.onKeyDown` 已实现，本轮不动：

- `Space` / `Enter`：未翻面翻面；已翻面评 Good（3）。
- `1–4`（含 Numpad）：翻面后评分。
- `Z` / `Ctrl/Cmd+Z`：撤销；`E` 编辑；`S` 跳过。
- 后台实例不接管快捷键（`isActive` 门控）、输入态/IME 保护（`isEditableTarget`、`isComposing`）均已有。

## 拟增 locale key（待 locale 负责人合入 flashcards.json）

本轮新词条一律 `t(key, { defaultValue: '...' })`（defaultValue 为英文，与 `fallbackLng: en-US` 一致），
不直接改 `flashcards.json`。拟增：

| key | en-US | zh-CN |
| --- | --- | --- |
| `review.undoNudgeRated` | `Rated {{rating}}` | `已评：{{rating}}` |
| `review.undoNudgeGeneric` | `Review recorded` | `已记录复习` |
| `review.cardTimeCappedTitle` | `Over 1 minute on this card (display capped; stats unaffected)` | `本卡用时已超过 1 分钟（仅显示封顶，不影响统计）` |

插值：`review.undoNudgeRated` 的 `{{rating}}` 传入既有档位词条
（`session.again` / `session.hard` / `session.good` / `session.easy`）。

复用的既有 key（不新增）：`session.undo`（撤销按钮文案）、`review.sessionTimeTitle`、`review.cardTimeTitle`。

## 边界与不变量

- 未改动：`FlashcardsAppWindow.tsx`、`fsrsReviewStore` / FSRS 调度、隐私 opt-in、`flashcards.json`。
- UndoNudge 不引入新 CSS 文件、不动 `flashcards.css`（并行角色可能持有），样式全部走 Tailwind
  工具类 + 既有 `wb-fc-keycap`。
- 本轮按指令未跑测试、未提交 commit。
