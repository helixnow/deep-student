# 闪卡复习 / FSRS / 卡库界面:0824 改造质量评审

对照:`v0.9.44` → `origin/cursor/0824-cde6` @ `2d41ea8b`。
范围:`src/features/flashcards/**` 与 `src-tauri/src/fsrs_review_service.rs`(`spaced_repetition.rs`、`review_plan_service.rs` 在此区间**零 diff**,不展开)。

## 结论

这块整体是**质量中上的净改善**。四个功能性修复(多级撤销 + 作答用时上报、后台窗口快捷键门控、空库/完成态区分、统计页容错)都对准真实痛点,状态机实现考虑了跨窗口竞态,且每一项都带针对性回归测试;Rust 侧新增的回流查询职责单一、有集成测试。但存在**一个实锤的用户可见缺陷**(APKG 导入成功提示的卡片数恒为 0,且被错误的测试 mock 固化),以及**一处系统性的实现方式债**(触屏 44px 适配以 56 处内联 Tailwind arbitrary variant 散布落地,与 CSS 层兜底互相重复)。前者是一行修复,后者建议在下一轮下沉到组件层。

改动体量:产品代码 13 个文件、+670/−95;配套新增测试 8 个文件、+651 行。测试与产品代码的比例和对位关系在本仓各主题里属于较好的一档。

## 改得好的部分

### 多级撤销 + 作答用时(fsrsReviewStore)

这是本区间技术含量最高的改动。旧版 `lastReview` 是单槽——评第二张卡后第一张就永远无法撤销;新版换成有界回执栈:

```86:93:src/features/flashcards/store/fsrsReviewStore.ts
export const REVIEW_UNDO_LIMIT = 20;

/** 单次作答用时上限：超过按上限截断（对齐 Anki max answer time：挂机不应污染用时统计） */
export const MAX_ANSWER_DURATION_MS = 10 * 60_000;

function pushReviewReceipt(history: ReviewReceipt[], receipt: ReviewReceipt): ReviewReceipt[] {
  const next = [...history, receipt];
  return next.length > REVIEW_UNDO_LIMIT ? next.slice(next.length - REVIEW_UNDO_LIMIT) : next;
}
```

实现细节经得起推敲:

- **弹栈按 `logId` 而不是按栈顶位置**(`fsrsReviewStore.ts:1398-1400`),注释明确说明是防 `await` 期间 reconcile 已改栈的竞态;后端 `fsrs_undo_last_review` 本就带 `expectedLogId` CAS 语义,前后端契约对得上。同一张卡在会话内评两次(Again 重入队)再连续撤销两次的场景也成立——每次弹栈后卡片的"最后一条 log"恰好回退到下一张回执的 `expectedLogId`。
- **跨窗口竞态处理是升级而非遗漏**:他端评分时,不仅剔除该卡的过期回执,还清洗**其余回执的队列快照**,防止后续 undo 用旧快照把他端已评的卡"复活"回本轮队列(`fsrsReviewStore.ts:1062-1069`);Agent 外部改动路径同样从"只查栈顶"升级为 `.some()` 扫全栈(`fsrsReviewStore.ts:909-911`)。
- **诚实的统计回退**:撤销后 `sessionStreak: 0` 并注释"诚实归零而非猜测之前的连击值"——宁可保守也不造假,这个取舍值得肯定。
- 作答用时打通了一条**旧版断头链路**:后端 `fsrs_rate` 的 `durationMs: Option<i64>` 参数和 review log 的 `duration_ms` 列在 v0.9.44 就存在,但前端从未传过。新版翻面记录 `flippedAtMs`,评分时 `Math.min(Math.max(0, Date.now() - flippedAtMs), MAX_ANSWER_DURATION_MS)` 截断上报,无翻面时刻时诚实传 `null`(`fsrsReviewStore.ts:1157-1159`),所有收面路径(评分/跳过/暂停/reconcile/退出)都同步清空 `flippedAtMs`,没漏。

配套 214 行专项测试(`tests/vitest/flashcards/fsrsReviewStore.undo-duration.test.ts`)覆盖了用时上报、截断、null 路径、逆序多级撤销和他端评分剔栈,断言粒度到 invoke 参数级,是本区间质量最高的测试文件。

### 后台窗口快捷键门控

旧版 `ReviewSessionScreen` 无条件在 `window` 上挂 keydown——工作台同时开两个闪卡窗口(或复习窗口退到后台)时,空格/评分键会被后台实例抢走。新版通过 `isActive` prop 门控:

```363:366:src/features/flashcards/screens/ReviewSessionScreen.tsx
  useEventRegistry(
    isActive ? [{ target: 'window', type: 'keydown', listener: onKeyDown }] : [],
    [isActive, onKeyDown],
  );
```

链路完整:工作台的 `AppWindowProps.isActive` → `FlashcardsAppWindow` → `FlashcardsApp` → `ReviewSessionScreen`,且 `isActive = true` 缺省保证独立宿主(非工作台)行为不变。有对应交互测试(inactive 时空格不翻面、rerender 到 active 后恢复)。

### 空库不再显示"100% 完成"

旧版 `progress = todayTarget > 0 ? ... : stats ? 1 : 0`——空卡库会渲染出 100% 进度环加"今日全部完成",对新用户是明确的误导。新版:

```140:147:src/features/flashcards/screens/TodayScreen.tsx
  // 无到期且今日未复习时没有可完成的目标，进度按 0 呈现——
  // 旧实现在 stats 存在时回落到 1，空卡库会显示「100%」这种伪完成态。
  const progress = todayTarget > 0 ? doneToday / todayTarget : 0;
  const progressPercent = Math.round(progress * 100);
  const learningCount = stats == null ? null : stats.learning + stats.relearning;
  // 卡库为空：走建库引导，而不是「今日全部完成」
  const libraryEmpty = stats != null && stats.total === 0;
  const showDoneState = doneToday > 0 && !libraryEmpty;
```

空库态给建库引导(主按钮跳卡库)、图标从"完成绿"换成 idle 蓝(CSS 里 `data-tone` 区分并注释了为什么),空态语义三分(library-empty / done / idle)。修复方向和实现都对。

### 统计页失败不再拖垮调度设置

旧版把 `SchedulerSettingsSection` 包在 stats 成功分支里——统计接口一挂,读写完全独立的 `scheduler_config` 的设置区也跟着不可用。新版在错误分支单独渲染设置区(`StatisticsScreen.tsx:285-289`),并有明确的回归测试("keeps scheduler settings reachable when statistics loading fails")。成功分支里设置区从统计面板上方挪到下方也有测试锁定 DOM 顺序。小瑕疵:错误态设置区在顶部、成功态在底部,两态之间位置会跳,以及这一处的注释用了英文(全文件其余注释是中文)——都不影响功能。

### Rust 侧:回流查询与 nullable 容错

`list_feedback_rows`(`fsrs_review_service.rs:1929-1975`)是为制卡管线的复习画像(anki.md 范围)提供的只读联表,但作为 FSRS 服务的新公共入口,其本身质量在本评审范围内:

- `limit.min(2000)` 硬上限、排除已删卡/错误卡/已删任务、**保留 suspended 卡并注释了为什么**("leech 自动暂停的卡恰是最需要反馈的薄弱点")——这类"为什么不过滤"的注释是好习惯。
- 担心过的两个坑都验证不存在:`INNER JOIN document_tasks` 不会漏掉手动建卡(`save_anki_cards` 每次都创建 `document_tasks` 行,`anki_connect.rs:769-780`),APKG 导入同理;`ORDER BY s.lapses DESC` 无索引但在 2000 行上限、本地 SQLite、非热路径(制卡前一次性调用)下可接受。
- 有独立集成测试(`src-tauri/tests/anki_fsrs_feedback.rs`)覆盖排序、limit 与排除规则。

另一处 `COALESCE(tags_json, '[]')`(`fsrs_review_service.rs:1079`)修的是真雷:旧版 `row.get::<String>` 遇到遗留 NULL 会让整批入队查询失败。且它不是孤立打补丁——同一提交(`0105a7eb`)配了 `V20260824__normalize_anki_card_optional_json.sql` 迁移把存量 NULL 归一化,SQL 层 COALESCE 只作残留兜底,属于正确的纵深做法。

## 实锤缺陷:APKG 导入计数恒为 0

后端 `ApkgImportResult` 带 `#[serde(rename_all = "camelCase")]`(`apkg_importer_service.rs:78-82`),前端拿到的是 `importedCards`;但新增的 `importApkg` 读的是 snake_case:

```373:376:src/features/flashcards/store/libraryStore.ts
        const result = await invoke<{ imported_cards?: number }>('import_apkg_to_library', { path });
        requestFlashcardsDueRefresh();
        await get().refresh();
        return { status: 'imported' as const, importedCards: result?.imported_cards ?? 0 };
```

`imported_cards` 永远 undefined,成功 toast 的 `{ count }` 恒为 0。导入本身、队列刷新、列表刷新都正常,所以是纯提示缺陷——但对"导入了 300 张卡却提示 0 张"的用户来说足以引发误判。

更值得记一笔的是缺陷的**产生方式**:这个错误契约抄自命令面板的旧代码(`anki.commands.ts:18` 从 v0.9.44 起就读 `imported_cards`,注释还声称"字段与 Rust ApkgImportResult serde 输出一致"——注释本身就是错的),新代码沿用了错误声明而没有核对 serde 属性;而且新增的组件测试把 mock 也写成了 snake_case:

```138:138:tests/vitest/flashcards/LibraryScreen.test.tsx
    mocks.invoke.mockResolvedValue({ imported_cards: 12 });
```

测试绿、生产错——mock 固化了错误契约,这正是 `chatApi.contract.test.ts` 这类契约测试要防的问题。修复本身是三行(`libraryStore.ts`、`anki.commands.ts`、测试 mock 各一处),建议顺手把两处一起修掉。

## 次级风险

**手动建卡的失败恢复路径会产生重复卡。**`createCard` 先 `saveAnkiCards` 落库、再 `enqueueAnkiLibraryCard` 入队(`libraryStore.ts:334-347`),注释写明"入队失败不吞"。但入队失败时整体走 catch 返回 false,composer 保留草稿——用户按提示重试会**再走一遍完整保存**。由于每次 `save_anki_cards` 都生成新的 `document_id`(UUID),内容级去重仅在文档作用域内生效(`anki_connect.rs:851` "按当前文档内 id 更新,再按内容映射"),重试必然新建第二张同内容卡,而第一张还留在库里且未入队。低频边缘场景,但"报错→重试"是用户最自然的动作,这条路径值得在后续加一层"savedId 已存在则只补入队"的记忆。

**撤销栈的快照陈旧窗口随栈深放大。**`reconcileAgentCardContent` 只回填活动队列的卡片内容(`fsrsReviewStore.ts:978-994`),不触碰回执里的 `queueSnapshot`;外部编辑某张卡后,撤销**另一张**卡会把整队回滚到含旧内容的快照。这个行为旧版单槽时代就存在,不是本轮引入,但栈深从 1 变 20 后暴露面变大。评分/暂停类外部变更已经做了快照清洗(见前文),唯独内容类变更没有——有 `fsrs://changed` 事件再调和兜底,属可接受折衷,但代码里没有注释说明这是已知取舍,后来者容易当成遗漏再修一遍。

## 明显优化空间

**触屏 44px 的落地方式是补丁式的。**统计一下:7 个 TSX 文件里共 **56 处** `[@media(pointer:coarse)]:!min-h-11` 之类的内联 arbitrary variant(LibraryScreen 18 处、ReviewSessionScreen 14 处、LibraryCardRow 9 处……),同时 CSS 层又有 `.fc-lib-row-actions button`、`.wb-fcx-cta`、`.fc-lib-create-cta` 等 coarse 兜底——TodayScreen 的主 CTA 甚至两头都设了(`className="wb-fcx-cta [@media(pointer:coarse)]:!min-h-11"` + CSS 里 `.wb-fcx-cta { min-height: 44px }`)。git 历史印证了成因:光本范围就有 9 个 `fix(flashcards): enlarge leftover ...` 提交,是多轮扫尾逐个打点,而不是一次性方案。CSS 注释里点出了根因——"DsButton 在 lg 断点后压缩高度,宽屏触屏平板会跌破触控基线"——**根因在 DsButton,修在了每个调用点**。正确解法是给 DsButton 加 coarse-pointer 的尺寸下限(或一个 `touchSafe` variant),56 处内联类和大半 CSS 兜底可以整体删除;现状每新增一个按钮都要记得手抄一串 arbitrary variant,`!important` 前缀也会压制未来的合法覆盖。功能上没错,维护性上是明确的债。

**同一行为写了两份测试。**`TodayScreen.emptyLibrary.test.tsx`(110 行,手写 i18n 字典)和 `todayScreenEmptyLibrary.test.tsx`(147 行,解析真实 zh-CN locale)都是本轮新增、都测空库空态,连文件名都只差大小写风格——明显是不同轮次的 agent 各写了一份没有合并。第二份的"走真实文案,缺 key 断言即败"策略更好,建议保留它、删掉第一份。

**作答用时的口径注释与 Anki 不符。**实现记录的是"翻面→评分"(`flippedAtMs` 在 flip 时才落,`fsrsReviewStore.ts:1122`),不含正面回忆时间;而注释声称"对齐 Anki max answer time"——Anki 的计时起点是**亮题**,默认上限 60 秒,这里是亮答案起算、上限 10 分钟,两个维度都不同。当前 `duration_ms` 只进统计不进调度,无实际风险;但如果未来把 review log 喂给 FSRS optimizer(它期望 Anki 口径的 answer time),这个偏差会系统性低估用时。至少应把注释改准,理想情况把起点挪到出题时刻。

## 汇总

| 项 | 判定 |
| --- | --- |
| 多级撤销 / 作答用时 | 好,竞态处理和测试是亮点 |
| 快捷键前台门控、空库态、统计页容错 | 好,小而准的真修复 |
| Rust 回流查询 + nullable 容错 | 好,有迁移和集成测试配套 |
| APKG 导入计数 | 缺陷,契约错误且被测试 mock 固化,建议连命令面板一起修 |
| 建卡失败重试、撤销快照陈旧 | 边缘风险,可接受但值得注释/加固 |
| 触屏 44px 落地方式、重复测试、用时口径注释 | 明显优化空间,建议下一轮收敛到 DsButton / 合并测试 / 修正注释 |
