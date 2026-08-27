# 0824 Wave2-B 第 2 轮 — 快照契约书面化（审阅员-快照）

- 角色边界:本文档为第 2 轮唯一产出,不改产品代码,不跑 npm/cargo/vitest,不 commit/push。
- 行号基线(撰写时工作区实况,`73be180a` + 未提交改动):
  - `snapshot.ts`(482 行)、`windowStore.ts`(607 行)、`WorkbenchDesktop.tsx`、`App.tsx`、`contentDirtyRegistry.ts`、`windowCloseGuard.ts` 相对 `061b4815` **零改动**,anchor-workbench 的行号仍逐条有效;
  - `scheduler.ts`(现 734 行)与 `core/types.ts` 带**第 2 轮实现员未提交的 canSuspend 改动**(+41 行),冻结循环整体下移约 25 行,本文行号已对现码重取;
  - `WorkbenchSettingsSection.tsx` 带**未提交的停用事务接线**(`handleModeChange` 现 293-334),其 import 的 `core/deactivationTransaction.ts` **撰写时刻尚不存在于工作区**(实现员并行中,见 §6 协调注记)。
- 必读输入:`snapshot.ts` 全文、`windowStore.ts` hydrate(518-583)、`wave2-B-r1-anchor-workbench.md` §3(deactivation/canSuspend 插入点)与 §5(快照边界)、`docs/0824-quality-review/workbench-fg.md`。

---

## 1. 契约第一条:快照只存壳(字段白名单),草稿必须走应用落库 / saveContentNow

### 1.1 白名单的规范定义

快照能且只能包含以下内容,任何超出即违约:

- **单窗壳字段(11 个,穷尽列举)**:`id / typeId / instanceKey / title / frame / restoreFrame / displayMode / minimized / zIndex / createdAt / lastFocusedAt`。规范实现即 `pickShellFields`(`snapshot.ts:274-288`),注释自述「lifecycle / payload 天然不在其中」(273)。
- **桌面级字段**:`version / windows / dockPinned / tilingRatios`(`snapshot.ts:224`)+ 可选 `wallpaper / materialTier / desktopSize`(226-256)。
- **文件头 P0 声明**(`snapshot.ts:13-16`):「白名单剥离——只保留 WorkbenchSnapshotV1 声明的字段,lifecycle / launch payload / 未知注入字段一律丢弃(快照纯净性 P0 约束)」。

### 1.2 白名单的四层结构性执行(逐层现码)

1. **采集面**:`buildSnapshot`(`snapshot.ts:291-304`)只经 `pickShellFields` 逐字段手写拷贝——没有展开运算符,没有 payload / lifecycle / 应用内部状态的任何出口。
2. **落盘面**:`persistNow` 把采集结果**再过一次** `sanitizeSnapshot`(`snapshot.ts:317`,注释「双保险」),即使有人污染了 `buildSnapshot` 的返回值,未知字段也会在写盘前被二次剥离。
3. **读入面**:`sanitizeWindow`(`snapshot.ts:119-141`)按同一 11 字段白名单校验重建对象;`sanitizeSnapshot`(182-258)对桌面级字段同样白名单重建;版本迁移 `migrateSnapshotShape`(155-176)对未来版本也只做「按 v1 白名单 best-effort」——**任何版本的快照读进来都不可能带出白名单外字段**。
4. **恢复面**:`windowStore.hydrate` 整体替换时 `launchPayloads: {}`、`transientPhases: {}` 并注释「快照绝不含 payload / 瞬态标记」(`windowStore.ts:570-580`);`preserveExisting` 分支(520-523,`mergeHydratedWindows` 255-270)只保留**活窗**已有的 payload,快照窗永远以空 payload 进场;文件头不变量 4「transientPhases 为派生 UI 状态,绝不持久化」(`windowStore.ts:16`)。

恢复路径上还有一层业务过滤同属「只存壳」精神:`pruneSnapshotWindows`(`WorkbenchDesktop.tsx:173-200`)丢弃已删资源与投射专属窗(pomodoro),`normalizeSingletonAppWindows`(`core/snapshotWindowPolicy.ts:7-22`)把 single 化应用的多快照窗收敛为一个并清 instanceKey——**恢复面允许收窄,绝不允许放大**(不得往恢复结果里补白名单外数据)。

### 1.3 推论:草稿的唯一合法去处

- 快照能恢复的上限 = 窗口壳 + 几何 + z 序 + Dock 固定区 + 平铺比例 + 壁纸/材质 + 保存时桌面尺寸。**未保存正文不在任何快照层**。
- 因此「用户不丢草稿」只能靠两条正路,与快照无关:
  1. **应用自身落库**(笔记/翻译/作文/题目集各自的持久化通道);
  2. **`saveContentNow`**(`contentDirtyRegistry.ts:93-103`)+ `hasContentSaveHandler`(85-87)——「保存并关闭 / 保存后停用」链路的显式挂点,脏判定用 `isContentDirty`(47-60,checker 抛错按 dirty 处理,fail-closed)。
- 单实例工作区(exam/essay/translation,`instanceKey=null`,`workbenchBus.ts:58`)连「当前选中资源」都在组件本地态与模块级注册表里,壳一卸即失——这是设计后果,不是快照的 bug;补救靠停用事务(§2)与 handoff descriptor(第 5 轮预排),**不是**靠给快照加字段。

## 2. 契约第二条:停用事务与快照的时序分工

停用事务(`runWorkbenchDeactivationTransaction`,插入点见 anchor-workbench §3.1 T1-T6)与快照各管一半,时序如下:

### 2.1 事务成功(所有窗确认可关 / 已保存)→ 快照在壳卸载时 flush

1. 事务逐窗 `confirmWindowClose`(`windowCloseGuard.ts:69-82`)/ `saveContentNow` 通过,**此阶段不动快照**——窗口仍全部活着,常规防抖保存(`saveSnapshot`,`snapshot.ts:355-365`,由 `WorkbenchDesktop.tsx:424-428` 的 store 订阅驱动)照常运转;
2. 调用方随后才允许落盘 `desktop.workbenchMode=false` / 提交断点、翻 `workbenchActive`(现码接线:`WorkbenchSettingsSection.tsx:293-334`,事务 ok 前「不 setMode、不 persist、不动 bus、不派发事件」,295-318);
3. 壳卸载时 `WorkbenchDesktop` cleanup 执行**唯一一次强制 flush**:`void flushSnapshot()`(`WorkbenchDesktop.tsx:466-475`,注释「先落盘(buildSnapshot 同步采集,provider 仍在)再注销」)。`flushSnapshot`(`snapshot.ts:368-375`)清防抖定时器、跳过内容去重强制写;`persistNow` 的写入串行化(310-311,339-344)保证旧防抖写不会晚于退出 flush 覆盖新值。

**规范**:事务本体结束时不需要自己调 `flushSnapshot`——cleanup 兜底已存在且必然执行;事务若额外 flush(anchor §3.1 T1 列为可选)只允许作为「成功路径最后一步」的提前落盘,不得移动、不得替代 cleanup 里的那一次(T6:cleanup 保持现状,unmount 不能异步阻塞)。

### 2.2 事务取消(任一窗拒绝 / 保存失败)→ 快照保持,什么都不做

- Workbench 保持激活:不 persist 模式、不派发 `WORKbench_MODE_CHANGED`、开关 UI 不离开 true(现码 `WorkbenchSettingsSection.tsx:304-317` 即此语义:「UI 从未离开 true,无需回滚」);
- **禁止**在取消路径上调 `flushSnapshot`,也禁止清空/改写快照——窗口集合没有变化,防抖机制自会在下一次真实变更时保存;取消路径上任何快照写动作都是无因写盘,且若与并行的窗口操作交错,可能把中间态强写为「最后已知布局」;
- **尤其禁止**把「取消了,但先把脏窗内容存进快照垫背」当成折中方案——这直接违反 §1(见 §4 红线)。

### 2.3 断点路径同型

`App.tsx:850-857` 的 `setShellStableSmallScreen` 提交点(T3)接事务后,时序与 2.1/2.2 完全相同:事务 ok → 提交断点 → 壳卸载 → cleanup flush;事务取消 → 不提交,保持宽壳,快照保持防抖常态。撰写时刻 `App.tsx` 尚未接线(842-858 仍为基线原码),实现员接线时以本节为验收口径。

## 3. 契约第三条:冻结不写快照草稿;解冻只能重建已落库状态

### 3.1 冻结与快照互不相识(现码事实)

- 冻结判定完全在 `scheduler.ts` 内(冻结循环现码 575-602),对 `snapshot.ts` **零调用**;冻结/解冻改的是 `lifecycles`,而 lifecycle 根本不在快照白名单里(§1.1)——冻结一个窗,快照内容一个字节都不变(该窗的壳字段照旧)。
- `WindowBody` 遇 frozen 卸载整棵应用子树只渲染占位卡(`WindowBody.tsx:186-194`);dirty checker 与 save handler 随视图卸载注销(`contentDirtyRegistry.ts:28-44,66-82`)。**卸载即失忆,快照不是也不得成为失忆的补偿层。**
- 解冻(占位卡点击 `handleWake`,`WindowBody.tsx:164-172`;或预取回 background,`scheduler.ts` requestWakePrefetch 段)只是把 lifecycle 抬回来重新挂载 `<App/>`——应用重新挂载后能拿到的只有:自己落库的数据 + 壳字段(typeId/instanceKey 定位资源)。**launchPayload 此时也未必还在**(payload 只在开窗时注入,hydrate 后为空),应用不得假设解冻 ≠ 冷启动。

### 3.2 第 2 轮 canSuspend 落地后的契约表述(对现码)

工作区已有实现(未提交):

- `AppDefinition.canSuspend?` / `prepareSuspend?`(`core/types.ts:476,482`):canSuspend 返回 false = 不可冻;**调度器热路径不 await**,返回 Promise 视为可冻,异步结果仅供非热路径;`prepareSuspend` 调度器绝不自动调用(482 前注释)。
- 调度器 skip:`scheduler.ts:585` `if (isWindowDirty(win.id) || !canSuspendNow(win)) continue;` ——位于预取豁免(584)之后、`selected.add`(586)与 `used -= memoryWeightOf`(595)之前,**脏窗不进 selected、不进 freezeCandidateSince、不扣预算**(注释 570-574「宁可多冻干净窗,绝不冻脏窗」),预算记账正确(anchor §3.2 S2 的警告已被遵守);`canSuspendNow`(140-147)回调抛异常按「不可冻」处理(fail-closed,与 `isContentDirty` 同向)。

由此契约第三条完整表述为三段:

1. **脏窗不冻**:`isWindowDirty` 或 `canSuspend===false` 的 background 窗永远保持 background,子树与 checker 都活着,草稿留在内存——这是内存态的保全手段,与快照无关;
2. **冻结不产生任何快照写入需求**:冻结前后快照内容不变;实现「冻结前抢救草稿」的唯一合法通道是 `prepareSuspend`(显式、非热路径、保存到**应用库**),不是往快照塞;
3. **解冻 = 从已落库状态重建**:干净窗被冻结意味着它没有未保存内容,重建无损;任何「解冻后草稿还在」的期待,必须由第 1、2 段在冻结前兑现,不得由快照层兑现。

## 4. 红线:任何人往快照塞 launchPayload / 正文,立即打回

第 2 轮实现若出现以下任一形态,一律列为红线违规,审阅不予通过:

| # | 违规形态 | 会撞上的现码防线 | 为什么是红线 |
|---|---|---|---|
| R1 | `pickShellFields` 加字段(payload/正文/编辑器状态/lifecycle) | 违反 `snapshot.ts:13-16` P0 声明;台账 18 不变量第 6 条「第 2 轮实现明令不得往快照塞草稿」 | 快照走 settings 明文存储(`get_setting/save_setting`,非 Tauri 回退 localStorage,`snapshot.ts:81-94`),塞正文 = 把未保存内容旁路到无版本、无冲突控制、无加密口径的通道 |
| R2 | 绕过 `pickShellFields`,在 `buildSnapshot` 返回值上补属性 | 被 `persistNow:317` 二次 sanitize 剥掉——**改动静默失效**,制造「以为保住了草稿」的假安全感,比显式失败更危险 | 同上;且掩盖真正该做的 saveContentNow 接线 |
| R3 | 给 `WorkbenchSnapshotV1` / `sanitizeWindow` / `sanitizeSnapshot` 扩白名单放行 payload 类字段 | 三层防线(§1.2 的 2/3/4)同时失守;`hydrate:570-575` 的清空还会与之打架 | 白名单是契约本体;扩名单 = 改契约,不在第 2 轮授权内 |
| R4 | 停用事务取消/失败路径把脏窗内容序列化进快照「垫背」 | §2.2 禁止;快照层没有该数据的读者(hydrate 不会还原它) | 写了也没人恢复,纯数据泄漏面 |
| R5 | `prepareSuspend` / canSuspend 实现把「保存」实现为写快照 | §3.2 第 2 段;保存必须走 `saveContentNow` / 应用落库 | 冻结抢救通道被偷换成违约通道 |

判别口径给锚定员复核用:`git diff` 中凡触及 `snapshot.ts` 的 `pickShellFields / sanitizeWindow / sanitizeSnapshot / WorkbenchSnapshotV1`(types.ts 中的接口声明)任一处,默认红线嫌疑,需逐字段说明仍在壳语义内(例如未来真有 v2 壳字段,须走 `migrateSnapshotShape` 显式分支 + 台账报备,不属本轮)。

## 5. Exposé 活体 DOM:仍后置第 8 轮

- 现状:`ExposeOverlay.tsx` 头注自述「不卸载不截图,transform 缩放」——全部窗口活体 DOM 同屏,是已知内存压力源(fg「优化顺序」第 6 条;台账 P9)。
- 顺序约束再次书面化:**先缝二(canSuspend)落稳,才允许动 Exposé 性能**。理由是评审原文:当前减压手段(冻结)恰好可能把后台脏编辑器冻掉——在 dirty 窗保护生效前上任何「更激进的内存回收 / 快照缩略图」都会扩大丢草稿面。
- 第 8 轮若做「快照缩略图」方案,注意名词撞车:那是**像素级视觉快照**(截图/位图缓存),与本文的布局快照(`WorkbenchSnapshotV1`)是两个系统——缩略图同样**不得**进 `desktop.workbenchSnapshot` 这个 settings key,也不得借 `WorkbenchSnapshotV1` 结构存放。本轮除本节记账外,Exposé 零改动。

## 6. 协调注记(给锚定员-复核与台账员)

1. 撰写时刻工作区有三个未提交产品改动:`scheduler.ts` / `core/types.ts`(缝二 canSuspend,已按 anchor §3.2 落位,预算记账正确,见 §3.2)、`WorkbenchSettingsSection.tsx`(缝一接线,`handleModeChange:293-334`)。**`WorkbenchSettingsSection.tsx:49` import 的 `core/deactivationTransaction.ts` 此刻尚不存在**——实现员-缝一并行中,合并前该文件必须到位,否则编译必红;其实现须符合 §2 时序(尤其:事务本体不得在取消路径动快照)。
2. 缝二实现当前未触碰 `snapshot.ts` / `windowStore.ts` / `WorkbenchDesktop.tsx`(git diff 证实)——快照契约四层防线在第 2 轮改动后**原样成立**,无行号漂移;`scheduler.ts` 冻结循环行号相对 anchor 文档(542-571)整体 +25 至 575-602,锚定员复核时以本文 §3.2 行号为准。
3. i18n 已核:设置页新增的 `workbench:deactivation.dirtyBlocked / .cancelled`(`WorkbenchSettingsSection.tsx:313-314`)在 `src/locales/zh-CN/workbench.json:544-547` 与 `en-US/workbench.json:544-547` 双语均已补齐(工作区未提交改动)。
4. 本文档未跑任何编译/测试;所有「成立/正确」判定均为静态读码结论。
