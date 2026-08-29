# Wave2-B 第 7 轮测试台账

> 角色:台账员(测试)。本文件只记账,不改产品代码,不 commit/push(父代理统一处置)。
> 台账口径:以撰写时 `git status` 实况为准(9 个 *test* 文件:3 modified + 6 untracked,
> 合计 +214/-8 行级改动 + 926 行新文件)。**全部为用例文本,本轮未执行任何 vitest/tsc/编译,
> 红绿预期均为静态读码推断,第 8 轮统一执行验证。**

## 一、git status 实况(撰写时)

```
 M src/features/pdf/components/__tests__/PdfSelectionActions.test.tsx      (+44/-8)
 M src/features/workbench/core/__tests__/scheduler.canSuspend.test.ts      (+137)
 M src/shared/notes/__tests__/saveTextAsNote.test.ts                       (+41)
?? src/features/learning-hub/__tests__/tabRestoreRebind.source.test.ts     (158 行)
?? src/features/learning-hub/__tests__/tabsPersistenceWriteThrough.test.ts (174 行)
?? src/features/workbench/core/__tests__/deactivation.cancel-matrix.test.ts (146 行)
?? src/features/workbench/core/__tests__/handoff.legacyRoundtrip.test.ts   (143 行)
?? src/features/workbench/core/__tests__/handoffDescriptor.test.ts         (264 行)
?? tests/vitest/workbenchActiveSmallScreenContract.test.ts                 (41 行)
```

与第 6 轮预告(ledger §6.4)八主题对照:dirty 取消矩阵 ✅、冻结保护 ✅、跨断点焦点 ✅、
标签移动后恢复 ✅、保存部分成功 ✅、划词单链路 ✅、handoff 双向 ✅;**书签交错本轮截稿时无新档**
(见 §三.1)。

## 二、逐文件红→绿预期

> 「预期绿」= 被测产品行为已在第 2–6 轮落地,用例为回归钉;若第 8 轮跑红,即为对应落地面的
> 回归信号,按「测试对、代码错」优先排查产品侧。所有预期均**未经执行验证**。

### 1. `src/shared/notes/__tests__/saveTextAsNote.test.ts`(M,+41)— 保存部分成功

- **追加内容**:3 条 `saveTextAsNoteAndNotify` 端到端用例——① landed:'folder' 时 toast 文案
  为「已保存到所选目录」;② 兼容后端落根(回查未命中)时 landed:'root' + toast「已保存到资源库
  根目录」且不得含「所选目录」字样;③ createNote 失败时 `{ok:false, error}` + error 级 toast
  (不得报 success)。
- **动机**:既有单元层断言(`notifySaveTextAsNoteResult`)挡不住组合函数把 landed 或 error
  传丢的回归,端到端再锁一遍(文件头注已自述)。
- **红→绿预期**:**预期直接绿**(P6 保存链第 3 轮落地、第 6 轮复核通过)。跑红 → 
  `saveTextAsNoteAndNotify` 组合层丢 landed/error,或 toast 文案 key(`saveAsNoteSuccessInFolder`
  / `saveAsNoteSuccessAtRoot`)变更未同步。注意 ②③ 断言的是中文渲染文案,i18n mock 口径变化会误红。

### 2. `src/features/workbench/core/__tests__/scheduler.canSuspend.test.ts`(M,+137)— 冻结保护(缝二)

- **追加内容**:两组共 5 例——① 多 dirty 窗穿插:6 窗超预算时两个 dirty 窗逐个越过、冻结恰落
  其后两个干净窗,断言 frozen 总数恰为 2(验证 skip 不扣 `used` 的记账不多冻不少冻);
  ② exam 单资源工作区(instanceKey=null)四例:dirty exam 经 `getResourceWorkspaceActive('exam')`
  解析后不冻、无 checker 对照组照常冻、活跃资源切走后恢复可冻(证明解析是活的非注册时快照)、
  `setWindowDirty` 兜底独立生效。测试内用 `registerTestApp` 以生产同形参数注册 exam
  (canSuspend 与 `createContentApp.resolveDirtyResourceId` 逐字同构,不 import 真实 register 避免
  拉入 React lazy/i18next 链)。
- **红→绿预期**:**预期直接绿**(S1–S3 第 2 轮落地,exam 纳入 canSuspend 为第 6 轮补丁)。
  跑红 → 调度器预算记账错位(skip 误扣 used)、resourceWorkspaceRegistry 解析断链、或 exam
  canSuspend 桥接回归。文件内注释已自述「书写为预期绿,未执行验证」。

### 3. `src/features/pdf/components/__tests__/PdfSelectionActions.test.tsx`(M,+44/-8)— 划词单链路(P7)

- **追加/强化内容**:① 新增「恰好一条 toolbar」挂载断言(单工具条契约:学习动作只由共享
  SelectionToolbar 承载,viewer 内建 ds-highlight-menu 只留选色+复制由 source 契约锁);
  ② locator 回调(onQuoteToChat)命中时**双通道全静默**(PREFILL 与裸 CHAT_V2_SET_INPUT 均 0);
  ③ PREFILL 降级路径 detail 整形断言 `{content, autoSend:false, sourceName}`(documentTitle →
  sourceName 不丢、不伪造页码);④ 「无裸通道」用例反空转加固:同时断言 PREFILL===1(证明点击
  确实走完派发路径,裸通道 0 不是空转);⑤ 头注补第 7 条 documentTitle 契约说明。
- **第 1 轮遗留(P7 测试对齐/waitFor 化)的处置**:该文件对两个懒加载弹层(ExplainPopover/
  TranslationPopover)采用 `vi.mock` 模块级拦截——lazy `import()` 目标被 mock 后同步可得,
  **同步断言不再依赖微任务时序,r1「预计跑红需 findBy/waitFor」的对齐路径以 mock 方式消化**,
  无需 waitFor 化。
- **红→绿预期**:**预期直接绿**(P7 第 4 轮落地、行为测试第 6 轮已改 PREFILL 口径)。跑红 →
  工具条二次挂载回归、PREFILL detail 混入多余字段(如 locator 可得时误带 page)、或 PDF 域
  重新出现裸 CHAT_V2_SET_INPUT 派发。风险提示:`getAllByRole('toolbar')` 若共享层内部结构
  变化(嵌套 role)可能误红,第 8 轮跑红先核对 DOM 快照再定性。

### 4. `src/features/workbench/core/__tests__/deactivation.cancel-matrix.test.ts`(新,146 行)— dirty 取消矩阵(缝一)

- **内容**:`runWorkbenchDeactivationTransaction` 取消矩阵,`describe.each` 三种 reason
  ('mode-off'/'breakpoint'/'app-exit')×两种拒绝源(dirty essay 经 contentDirtyRegistry
  checker;canClose=false 守卫窗)→ 全部 `ok:false` 且**零副作用**(dirty 窗与已放行的干净窗
  都不被关,windowCount 不变);另 1 例全干净桌面 `ok:true` 且 phase 1 成功同样不关窗(关窗属
  调用方 phase 2)。typeId 加 `deact-matrix-` 前缀避免与既有 `deactivationTransaction.test.ts`
  注册冲突;与其**互补不重复**(single-flight 用例不重写)。
- **红→绿预期**:**预期直接绿**(P1 两阶段事务第 2 轮落地、第 6 轮复核通过)。跑红 → 事务
  phase 1 泄漏副作用(预检中途关窗)或 reason 分叉处理不一致。

### 5. `src/features/workbench/core/__tests__/handoffDescriptor.test.ts`(新,264 行)— handoff 纯函数层

- **内容**:P3 descriptor 四条主线——① serialize/build/parse 往返与逐字段 sanitize(appType
  非法整体作废;resourceId/innerRoute 坏则字段级收敛不作废整体;控制字符剥离;超长截断;
  `__proto__`/多余字段丢弃);② consume 一次即清(有效/损坏载荷都先删存储条目,二次消费 null);
  ③ 陈旧作废(`DEFAULT_HANDOFF_MAX_AGE_MS` 严格大于语义边界例、自定义 maxAgeMs、Infinity 关闭);
  ④ 坏 payload 一律 null 不抛错,storage 读取抛错静默 null。storage 全程注入内存 mock,不碰
  jsdom localStorage。
- **红→绿预期**:**预期直接绿**(P3 第 5 轮落地、第 6 轮 handoff 复核四条全过)。跑红 → 
  sanitize 白名单或新鲜度判定边界(等号语义)与实现漂移。

### 6. `src/features/workbench/core/__tests__/handoff.legacyRoundtrip.test.ts`(新,143 行)— handoff 双向

- **内容**:① build+save → consume 资源级往返无损(appType/resourceId/innerRoute 逐字段一致)、
  一次即清;② `handoffWorkbenchToLegacyShell`:有焦点窗(note/textbook,命中经典壳映射)时
  descriptor 写入默认 localStorage 并返回同一三元组、落盘后可被 consume 取回闭环;无焦点窗
  返回 null 且不写 storage。windowStore/workbenchBus/通知/i18n 全 mock,只测交接链路本身。
- **红→绿预期**:**预期直接绿**。跑红 → `handoffWorkbenchToLegacyShell` 采集口径(focusStack
  栈顶)或默认 storage 落盘路径回归;注意本文件 mock 的 windowStore 形状
  (`{windows, focusStack}`)若与真实 store 接口漂移会误红,先对形状再定性。

### 7. `tests/vitest/workbenchActiveSmallScreenContract.test.ts`(新,41 行)— 跨断点焦点/窄窗不换壳

- **内容**:App.tsx 源码契约(readFileSync)三条——① `workbenchActive` 声明全文件唯一且
  **逐字等于** `const workbenchActive = workbenchMode && !isMobilePlatform();`;② 声明不含
  shellStableSmallScreen/isSmallScreen 窄窗条件;③ `shellStableSmallScreen` 不得再以声明/
  setter/hook/逻辑运算形式存在(注释留档豁免)。
- **红→绿预期**:**预期直接绿**(第 2 轮 P1c 已删硬切,第 6 轮 handoff 复核确认表达式)。
  跑红 → 窄窗换壳条件回潮(真回归)或仅仅是该行重排版/改名(需人工判别后收敛断言——
  逐字符串锚是刻意的钉死设计,格式化误红属可接受成本)。

### 8. `src/features/learning-hub/__tests__/tabRestoreRebind.source.test.ts`(新,158 行)— 标签移动后恢复(P8,源码契约)

- **内容**:LearningHubPage 模块私有逻辑(未导出、本轮禁改实现)走源码契约断言:
  ① 恢复校验必须 `dstu.get('/' + resourceId)`、`dstu.get(tab.dstuPath)` 绝迹(移动≠失效);
  ② 成功分支重绑最新 `node.path/node.name`(空值回退不刷空白),提交步 `{...tab, ...rebind}`
  展开合并;③ 只有 `VfsErrorCode.NOT_FOUND` 才删标签——`invalidIds.add(` 全文件唯一、
  NOT_FOUND 后无 else 落网、提交步唯一删除路径且无 `.filter(`;④ `savePersistedTabs` 缓存写入
  位于 try 之外且先于 `localStorage.setItem`(写透时序),payload 版本化、storage 失败静默;
  ⑤ 惰性初始化经 `loadPersistedTabs`。锚点缺失时抛可读错误提示「实现已重构请同步更新」。
- **红→绿预期**:**预期直接绿**(P8 第 3 轮落地)。跑红分两类:锚点字符串因重构漂移(按文件
  头约定优先删本文件、保留行为测试)vs 语义真回归(如出现第二个 invalidIds.add)。

### 9. `src/features/learning-hub/__tests__/tabsPersistenceWriteThrough.test.ts`(新,174 行)— 标签持久化(P8,探测式行为测试)

- **内容**:P8-1 写透缓存的**行为**测试,探测式写法(与第 2 轮 closeTabGate.test.ts 同范式):
  依次探测 4 个候选模块路径(`../tabsPersistence` 等),若第 8 轮实现员把 save/loadPersistedTabs
  抽成独立模块即自动激活;未抽出则整组 `describe.skip`。用例:save 后篡改 localStorage 为过期
  快照 → load 命中缓存非旧数据;setItem 抛 QuotaExceeded → save 不抛且缓存照常;payload
  version=2 + key 沿用 v1;「重启」用例需缓存重置钩子,无钩子单独 skip。
- **红→绿预期**:**当前形态预期整组 skip(灰,非红)**——同语义防线由 §8 源码契约兜底。
  第 8 轮若抽出纯函数模块则自动转为行为断言,预期绿;届时按 §8 文件头约定删源码契约文件。

## 三、缺口与记账

1. **书签交错(八主题之四)截稿时无新档**:本台账撰写时 git status 无对应新/改测试文件。
   既有覆盖:第 3 轮已入库的 `previewPersistence.bookmarkRace.test.ts`(书签竞态红转绿)与
   `previewPersistence.test.ts` 跨窗口交错用例 + flush 分写断言(均随 `6fe01f2a` 提交,同样
   未执行)。若该写手在本台账落笔后交档,追加记账入本文件,不重写本节。
2. **第 8 轮执行清单**:上表 9 文件 + 第 2–4 轮已入库未执行的测试文本(deactivationTransaction
   / scheduler.canSuspend 第 2 轮基线段 / closeTabGate / saveTextAsNote 第 3 轮段 /
   previewPersistence 两文件 / pdfViewState / pdfSearch / imageSanitize / todoQuickAddParser /
   openResourceActionHandlers / localGraph / NotesSearchOverlay 等)统一跑;红灯按「先对锚点/
   mock 形状,再定性产品回归」次序排查。
3. **本轮零产品代码改动**(台账员职权自证):git status 中除上列 *test* 文件外无任何
   modified/untracked 源码;两份 docs(本文件 + ledger 追加)为仅有的非测试产出。
4. 未 commit/push,未标记 Goal complete;执行权与提交权均在父代理/第 8 轮。
