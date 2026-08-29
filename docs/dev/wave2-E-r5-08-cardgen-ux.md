# Wave2-E R5-08：制卡产物「未入队收件箱」与复习队列视觉分离（SOTA-制卡 UX）

日期：2026-08-26
范围：`src/features/flashcards/screens/LibraryScreen.tsx`、`src/features/flashcards/library/libraryView.ts`、
`src/features/flashcards/library/library.css`（本轮独占文件）。
不改 GenUI preview、不改 workbench 壳、不改 FSRS 调度、不改 `flashcards.json`（新词条全部走 `defaultValue`）。

## 背景

制卡链路（chat / task / apkg 导入）产出的卡片落库后是 `enqueued=false`（未入队 FSRS），
不会出现在到期队列，但在卡片库里与已入队 / 已到期的卡**混排在同一张平铺列表**中，
只靠一枚 10px 的「未入队」灰徽标区分。用户刚生成一批卡后打开库页，
「哪些是新产物、哪些是今天要复习的」需要逐行读徽标才能分辨；
把整批产物送进复习计划也只能先全选再点批量条的「入队」。

## 方案：分区渲染（隔离队列），不新增任何数据链路

把当前页可见卡按 `enqueued` 分成两个视觉分区：

1. **收件箱（inbox）**：`notEnqueued` 卡。暖色（`--warning`）区头 + 分区淡暖底色 +
   每行左缘 2px 标带；区头右侧常驻「加入复习（N）」按钮，一键把当前页全部未入队卡入队。
2. **复习队列（scheduled）**：已入队（含暂停）卡。仅当上方存在收件箱时才渲染区头
   （标题 + 总数 + 到期数），收件箱为空时渲染结果与旧版完全一致（零视觉回归）。

「加入复习」不新写任何请求链路：

- 区头按钮 → 既有 `bulkEnqueue(ids)`（store `runBulkMutation` → `enqueueAnkiLibraryCard`，
  已入队卡自动跳过，逐卡聚合失败、结束后统一 refresh + `requestFlashcardsDueRefresh`）；
- 单行按钮 → 既有 `enqueueCard`（未改动）；
- 批量条的「入队（N）」按选中集合工作，与分区按钮并存（语义不同：选中 vs 当前页全部未入队）。

## 改动明细

### `library/libraryView.ts`（纯函数层）

- 新增 `LibraryQueueSections` 与 `partitionLibraryQueues(items)`：按 `card.enqueued`
  稳定分区为 `{ inbox, scheduled }`，组内保持传入顺序（筛选/排序由调用方先做）。
- 新增 `countDueCards(items)`：`isDue && !suspended` 计数，供 scheduled 区头展示到期数。

### `screens/LibraryScreen.tsx`

- `visibleItems` 改为 `filter → sort → partition` 后按 `[...inbox, ...scheduled]` 拼接，
  **渲染顺序 = 键盘 ↑↓ 导航顺序 = shift 连选顺序**（三者都以 `visibleItems` 为序，语义不漂移）；
  全选、批量条、`filteredCount` 等下游逻辑不感知分区（同一集合，仅重排）。
- 行渲染抽成 `renderCardRow`（两个分区共用同一 `LibraryCardRow` 调用，行为完全一致）。
- 新增 `handleEnqueueInbox`：`bulkEnqueue(inboxItems.map(id))`，与其它操作共用
  `rowBusy`（`busyCardId || bulkBusy`）禁用互斥。
- 分区均为 `<section aria-label=…>`，收件箱区头含 Tray 图标、标题、数量 chip、说明文案、CTA。

### `library/library.css`

- 新增 `fc-lib-queue-*`：区头（inbox 暖色底 / scheduled 中性底）、标题、数量 chip、
  说明文案（含 `data-tone='due'` 到期强调）、`margin-left:auto` 的 CTA。
- 收件箱行左缘标带用 `.fc-lib-row::before` 伪元素承载（行本身 `position:relative` 已有），
  不与行 focus-visible 的 inset box-shadow 焦点环冲突；分区底色放在 section 容器上，
  行 hover / 选中背景照常覆盖其上（不动 `.fc-lib-row[data-selected]` 的特异性关系）。
- 窄屏（≤480px）隐藏非到期说明文案给标题 + CTA 让位；CTA 沿用
  `[@media(pointer:coarse)]:!min-h-11` 触控基线。

### 词条（全部 `defaultValue`，未动 `flashcards.json`）

| key | defaultValue |
| --- | --- |
| `library.queue.inboxTitle` | 已生成 · 待入队 |
| `library.queue.inboxHint` | 尚未进入复习计划，不会出现在到期队列 |
| `library.queue.enqueueAll` | 加入复习（{{count}}） |
| `library.queue.scheduledTitle` | 复习队列 |
| `library.queue.dueCount` | {{count}} 张已到期 |

## 边界与口径

- 分区作用于**当前页**（后端 `list_anki_library_cards` 仅支持 search/page，与既有
  筛选/排序的客户端口径一致）；「加入复习（N）」的 N 也是当前页未入队数，不是全库。
- 状态筛选与分区正交：`notEnqueued` 筛选 → 只剩收件箱（区头 + CTA 仍在）；
  `due` 筛选 → 收件箱必空（未入队卡 `isDue=false`），渲染与旧版一致。
- `bulkEnqueue` 失败聚合语义不变：部分失败走既有 `bulkPartialFailure` 错误条。

## 未动

GenUI preview（`AnkiCardPreviewPanel` 及行内模板预览调用原样）、workbench 壳、
FSRS 调度/入队后端语义、`LibraryCardRow.tsx`、`libraryStore.ts`、`flashcards.json`。
本轮按约定未运行测试、未提交。
