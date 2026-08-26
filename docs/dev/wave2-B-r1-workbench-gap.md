# Wave2-B 第 1 轮:Workbench 调度/快照/切壳 差距调研(调研员-工作台)

- 范围:`src/features/workbench/core/{scheduler,snapshot,windowStore,workbenchBus,legacyNavigationMap}.ts`、`components/{WorkbenchDesktop,WindowBody,ExposeOverlay}.tsx`、`agent/AgentBridge.tsx`、`src/App.tsx` 工作台激活段、`WorkbenchSettingsSection.tsx`。
- 方法:静态源码复核(逐条核对 `docs/0824-quality-review/workbench-fg.md` 引用行号)+ 外部调研(macOS Mission Control / AppKit 状态恢复、Arc Spaces、Stage Manager、iOS Scene 生命周期、Chrome tab discard)。本轮不编译、不测试、不改产品代码。
- 输入评审:`docs/0824-quality-review/workbench-fg.md`(总判定 FAIL,两条状态安全缝)、`docs/0824-quality-review/cross-cutting.md` §三(Composer×移动 PASS,不需 Workbench 侧返工)。

---

## 一、第一优先:两条 FAIL 缝的现码复核

评审文档基于 `origin/cursor/0824-cde6@2d41ea8b`;本轮在 `cursor/0824-wave2-desktop-subapps-a875 @ 061b4815/82e016b7` 工作树逐条重验。结论:**两条缝均仍然存在,评审引用的行号大体准确,个别有 2–4 行漂移,以下为当前树的精确行号。**

### 缝一:Workbench 卸载/切壳绕过脏数据协议 —— 复核确认

触发路径有三条,全部绕过 `canClose`:

1. **设置页关闭「学习桌面」**:`handleModeChange` 先落盘 `desktop.workbenchMode=false`,只额外关闭原生 browser,随后直接 `workbenchBus.setEnabled(false)` 并派发 `WORKBENCH_MODE_CHANGED`(`src/features/settings/components/WorkbenchSettingsSection.tsx:292-309`;评审引用 292-308,当前为 292-309,内容一致)。全程没有枚举窗口、没有询问任何 `canClose`。
2. **断点持续切壳**:`App.tsx` 的 250ms 迟滞只防瞬时抖动(`src/App.tsx:849-857`,注释本身在 842-848 明确承认「整壳硬切会绕过未保存确认与 windowCloseGuard」);迟滞到期后 `workbenchActive` 直接翻 false(`src/App.tsx:858`),渲染分支立即卸载 `LazyWorkbenchDesktop` 整棵树(`src/App.tsx:2810-2816`)。
3. **卸载清理不含 dirty preflight**:`WorkbenchDesktop` 的卸载 cleanup 只做 `flushSnapshot()`、注销 Dock provider、清投射、停调度器(`src/features/workbench/components/WorkbenchDesktop.tsx:466-475`,启动/清理 effect 整体在 418-476)。

而快照契约明确只存壳:`pickShellFields` 白名单只有 id/typeId/instanceKey/title/frame/displayMode/minimized/zIndex 等几何字段(`src/features/workbench/core/snapshot.ts:274-288`,头注 13-16 声明「lifecycle / launch payload 一律丢弃」);`hydrate` 整体替换时清空 `launchPayloads`(`src/features/workbench/core/windowStore.ts:570-575`)。因此:

- 多实例 note/textbook/file 凭 `instanceKey` 可找回资源,但未保存正文不在快照里;
- exam/essay/translation 是 `instanceKey=null` 的单实例工作区(`src/features/workbench/core/workbenchBus.ts:58`,`RESOURCE_WORKSPACE_TYPE_IDS`),当前选中资源存于模块级 `activeResources` 注册表与 `ResourceAppWorkspace` 本地 state(`src/features/workbench/apps/content/resourceWorkspaceRegistry.ts:3,43-62`),既不进快照、也无 handoff,壳一卸载即失。

关窗协议本身是完整的:`workbenchBus.closeWindow` 走 `confirmWindowClose`(`workbenchBus.ts:421-429`),`confirmWindowClose` 有 single-flight 与 `canClose` 询问(`src/features/workbench/core/windowCloseGuard.ts:69-82`),内容应用的 `canClose` 支持「保存并关闭 / 放弃 / 取消」三态(`src/features/workbench/apps/content/createContentApp.tsx:55-79`)。**问题不是协议缺失,而是三条卸载路径都不经过这套协议。**

### 缝二:内存冻结绕过同一协议 —— 复核确认

- 调度器预算超限后从 background 窗口按 `lastFocusedAt` LRU 选冻结候选,候选过滤只看三件事:档位是 background(`src/features/workbench/core/scheduler.ts:548-550`)、预取豁免期(`scheduler.ts:554`)、`keepAliveWhenOccluded` 注册属性(`scheduler.ts:121-123,528`)。**没有任何 dirty / `canClose` / `canSuspend` 检查**(整个冻结判定块 `scheduler.ts:545-571`;评审引用 542-575,漂移 3 行,结论不变)。预算常量:默认 12、macOS 9(`scheduler.ts:44-45`),冻结宽限 2500ms(`scheduler.ts:49`)。
- `WindowBody` 遇 `frozen` 直接 return `FrozenPlaceholder`,整棵应用子树卸载(`src/features/workbench/components/WindowBody.tsx:186-194`;评审引用 184-193,漂移 2 行)。
- dirty registry 是「视图挂载注册、卸载注销」模式(`src/features/workbench/apps/content/contentDirtyRegistry.ts:28-44` 注册 checker,`66-82` 注册 save handler;评审引用 24-43/62-81,漂移 4 行)。真实消费者:
  - Translation 注册 dirty checker(`src/components/TranslateWorkbench.tsx:386-392`)与 save handler(`TranslateWorkbench.tsx:423-429`);
  - Essay 只注册 dirty checker(`src/components/EssayGradingWorkbench.tsx:233-239`);
  - Notes 标题/正文分别注册(`src/features/notes/NotesEditorHeader.tsx:113`、`src/features/notes/NotesCrepeEditor.tsx:1469`);Exam 在 `src/features/learning-hub/apps/views/ExamContentView.tsx:494`。

  组件被冻结卸载 ⇒ checker 与 save 挂点同步消失 ⇒ 唤醒只能从落库状态重建。评审推理成立:「关窗会询问」推不出「冻结安全」。
- 一个对修复重要的新发现:**每窗同步脏标记 API 已存在但覆盖不全。** `setWindowDirty / isWindowDirty`(`windowCloseGuard.ts:23-32`)是 windowId 键控、同步可查的脏信号,当前只有 NotesWorkspaceApp 在维护(`src/features/workbench/apps/notes/NotesWorkspaceApp.tsx:1093-1095`),exam/essay/translation 及多实例内容窗都没有打红点。这意味着调度器即便今天就地消费 `isWindowDirty`,也只保护 Notes 一类;`canSuspend` 方案必须先把 `contentDirtyRegistry` 桥接到每窗标记(见 §四-B)。

### 两条缝的共同根因

窗口生命周期(scheduler/windowStore)与编辑生命周期(contentDirtyRegistry/canClose)是两套互不知晓的状态机:前者认为「卸载 DOM 是无损的渲染优化」,后者假设「卸载只发生在 canClose 通过之后」。切壳与冻结正好落在两者的缝隙里。

---

## 二、外部调研:成熟系统怎么处理同一问题

### 1. macOS Mission Control / AppKit(窗口—空间—恢复的分层)

- **退出是事务,不是开关。** Cocoa 的退出链路是 `applicationShouldTerminate:` → 可返回 `NSTerminateLater`(异步逐文档保存)→ `replyToApplicationShouldTerminate:`;任何一个文档取消,整个退出回滚,应用保持运行。关键契约:退出**不会**自动触发每窗 `windowShouldClose:`,框架要求应用自己保证等价确认发生——这正是 Workbench 缺的「deactivation transaction」的原型:枚举窗口、逐窗确认、可取消、可回滚。
- **壳状态与文档内容分两条恢复轨道。** Resume(`encodeRestorableStateWithCoder:` / `restoreWindowWithIdentifier:state:completionHandler:`)恢复窗口几何、选区、滚动位置等 UI 状态;未保存正文由 NSDocument 的 autosave-in-place 单独兜底。两轨互不依赖:UI 状态丢了不丢数据,数据由更强的机制保护。Workbench 目前只有第一轨(壳快照),第二轨(编辑内容 checkpoint)完全缺失——这是把 `snapshot.ts` 白名单当成「防丢数据措施」属于错误安全感的结构性原因。
- **Sudden/Automatic Termination 是显式声明的能力。** 应用只有在「无未保存状态」时才允许系统静默终止,工作期间用 `disableAutomaticTermination:` 显式退出该资格。对应到 Workbench:窗口应当能声明「我现在不可冻结」,而不是靠 `keepAliveWhenOccluded` 这种按 typeId 的静态白名单(`scheduler.ts:121-123`)。
- Mission Control 的 Spaces 只管窗口分组与展示,从不介入数据生命周期——「壳的空间管理」与「内容的保存协议」严格分层。

### 2. Arc Spaces(空间、休眠、归档三层降级)

- Arc 对不活跃标签是**三层降级**:suspend(内存卸载、侧栏项与状态保留)→ auto-archive(默认 12h,移入 Archive,可随时恢复)→ 永不静默删除。每一层都保留「回来的路」:归档标签在 Command Bar 可搜可还原。
- 关键差异:浏览器标签的「状态」几乎全部可从 URL 重建,所以 Arc 敢激进休眠;Workbench 的 essay/translation 窗口状态不可从 `typeId+instanceKey` 重建(单实例、`instanceKey=null`、选中资源在本地 state),**降级前提不成立却用了同样激进的冻结策略**。
- Arc 的 Space 是「上下文容器」:每个 Space 有独立 Pinned/Unpinned 区与主题,切 Space 不销毁其他 Space 的标签。对照 Workbench 的双壳切换:切壳更像「删除整个 Space」而非「切走」,这是产品语义上的额外落差。

### 3. Stage Manager(集合切换从不卸载)

- Stage Manager 的核心语义:中央舞台 + 左侧最近集合条;切换集合只是**换哪个集合上台,离台窗口继续存活**(缩略图还是 live view)。窗口分组随窗口存续持久;关掉窗口才打破分组。
- 对照:Workbench 的模式切换把「切走」实现成了「全部关闭且不确认」。Stage Manager 证明桌面级形态切换(开/关 Stage Manager 本身)也不销毁窗口,只改变布局呈现——这支持 §四-D 的「紧凑形态」方向:形态切换与生命周期终止解耦。

### 4. 补充参照:iOS Scene 与 Chrome tab discard(冻结协议的两个业界基线)

- **iOS**:场景进后台(`sceneDidEnterBackground`)是最后的可靠保存点,系统随时可能回收 suspended 场景;框架契约是「先保存、后挂起」,且状态恢复(`stateRestorationActivity`)与数据保存分离。Workbench 的 frozen 相当于 iOS 的 scene disconnect,但没有给应用任何 `sceneDidDisconnect` 等价回调——`WindowBody` 只是停止渲染子树,应用子组件只能靠 React unmount cleanup 兜底,而 cleanup 里没人做保存。
- **Chrome Memory Saver**:有未提交表单输入或活跃 `beforeunload` 处理器的标签**不会被 discard**(除非极端内存压力);discard 时不触发 `beforeunload/unload`,官方指引是「hidden 时就保存,不要指望卸载事件」。这是 `canSuspend` 的最直接原型:**回收器负责询问「可否回收」,内容方负责随时可回收(checkpoint 前移)**,两边各承担一半。

---

## 三、差距清单

| # | 差距 | 现码证据 | 业界参照 | 优先级 |
|---|------|----------|----------|--------|
| G1 | 模式关闭/断点切壳无 deactivation 事务,卸载不询问 `canClose` | `WorkbenchSettingsSection.tsx:292-309`;`App.tsx:849-858,2810-2816`;`WorkbenchDesktop.tsx:466-475` | AppKit `applicationShouldTerminate:` + `NSTerminateLater` 可取消可回滚 | **P0(评审缝一)** |
| G2 | 冻结候选不查脏状态,卸载子树连带注销 dirty/save 挂点 | `scheduler.ts:545-571`(无 dirty 过滤);`WindowBody.tsx:186-194`;`contentDirtyRegistry.ts:28-44,66-82` | Chrome 不 discard 有未提交输入的标签;iOS 先保存后挂起 | **P0(评审缝二)** |
| G3 | 每窗脏标记覆盖不全:只有 Notes 调 `setWindowDirty`,exam/essay/translation 无红点、无同步可查信号 | `windowCloseGuard.ts:23-32`;`NotesWorkspaceApp.tsx:1093-1095`(唯一调用方) | Chrome 以 renderer 侧信号(表单输入)统一上报 | P0 前置(G1/G2 的数据源) |
| G4 | 壳快照只存几何,无内容 checkpoint 轨道;单实例工作区选中资源不进任何持久层 | `snapshot.ts:274-288`;`windowStore.ts:570-575`;`resourceWorkspaceRegistry.ts:3,60-62` | AppKit 双轨:Resume 恢复 UI,autosave 保护内容 | P1 |
| G5 | 切壳无 handoff:焦点窗上下文不迁移,经典壳落在与 Workbench 无关的旧 `currentView` | `legacyNavigationMap.ts:75-135` 只处理新 launch/activate,不迁移既有窗口 | Arc 切 Space 保留上下文;Stage Manager 切集合不重置 | P1 |
| G6 | 冻结无 `prepareSuspend` 回调:应用没有「挂起前最后保存」的挂点 | `WindowBody.tsx:186-194` 直接 return 占位,无任何通知链 | iOS `sceneDidEnterBackground`;Chrome 建议 visibilitychange 时保存 | P1(与 G2 同修) |
| G7 | 桌面平台按宽度 <768px 换壳,把「布局问题」升级成「生命周期问题」 | `App.tsx:858`(`!shellStableSmallScreen` 参与 workbenchActive) | Stage Manager 形态切换不销毁窗口;Arc 窄窗只折叠侧栏 | P1(方案重议,见 §四-D) |
| G8 | `keepAliveWhenOccluded` 是 typeId 静态白名单,不是数据安全策略 | `scheduler.ts:121-123` | macOS Automatic Termination 是实例级动态声明 | P2(被 canSuspend 取代) |
| G9 | Exposé 活体 DOM 同屏缩放的内存压力(当前减压手段恰是危险的冻结) | `ExposeOverlay.tsx:1-33`(头注:不卸载不截图,transform 缩放;重窗仅降级视觉特效) | Mission Control / Stage Manager 用合成器缩略图 | **后置第 8 轮,本轮只书面化** |

不返工项:评审确认做对的边界(移动平台恒走经典壳、`WindowBody` 的 `isActive/isVisible/isSuspended` 下传、legacy 降级通道、冲突裁决)全部保留,本轮差距清单不触碰。Composer×移动在 cross-cutting.md 为静态 PASS,与本面无耦合返工。

---

## 四、可静态落地子集(不动运行时行为验证,纯代码可实现)

### A. Workbench deactivation transaction(修 G1)

单一入口函数,模式关闭、断点切壳、应用退出三条路径共用:

```
requestWorkbenchDeactivation(reason: 'mode-off' | 'breakpoint' | 'app-quit')
  → 枚举 useWindowStore.getState().windows
  → 逐窗顺序 await confirmWindowClose(id)   // 复用 windowCloseGuard 的 single-flight,
                                            // 顺序 await 与 useWorkbenchShortcuts.ts:240 的
                                            // 「关闭所有窗口」既有实践一致
  → 任一返回 false ⇒ 整体取消:不写 workbenchMode、不派发事件、模式开关 UI 回滚
  → 全部通过 ⇒ flushSnapshot() → 落盘设置 → 派发 WORKBENCH_MODE_CHANGED
```

改造点(均为已读文件内的局部改动):
1. `WorkbenchSettingsSection.handleModeChange`(292-309):`enabled=false` 分支先 await 事务,取消则 `setMode(true)` 回滚且不 persist;
2. `App.tsx:849-857` 迟滞 effect:250ms 稳定后不直接提交 `shellStableSmallScreen`,改为先跑同一事务,取消则不提交(窄窗策略若采 D-方案一,此分支整体消失);
3. `WorkbenchDesktop.tsx:466-475` 卸载 cleanup 保持现状(事务在卸载前完成,cleanup 只做善后)。

静态可验证:vitest 断言「一个 `canClose=false` 的窗口存在时,handleModeChange(false) 后 `desktop.workbenchMode` 未写入、`WORKBENCH_MODE_CHANGED` 未派发」。

### B. `canSuspend` / `prepareSuspend` 契约(修 G2/G3/G6/G8)

两步走,第一步纯静态即可关死数据丢失路径:

1. **冻结候选过滤(最小改动)**:`scheduler.ts:548-550` 的候选筛选追加同步谓词——`isWindowDirty(win.id)` 为真的窗口跳过冻结(保持 background,DOM 隐藏但存活)。`isWindowDirty` 已是同步、windowId 键控(`windowCloseGuard.ts:30-32`),调度器可零成本消费;scheduler 不 import React,依赖方向 core→core,无环。
2. **脏信号补全(G3)**:让 `WindowBody`(或 `createContentApp` 的宿主层)按 `contentDirtyRegistry.isContentDirty(typeId, resourceId)` 的轮询/事件桥把结果写入 `setWindowDirty(windowId, …)`;essay/translation 的 resourceId 用 `getResourceWorkspaceActive(type)` 解析(与 `createContentApp.tsx:57-61` 的 canClose 解析逻辑同源)。附带收益:exam/essay/translation 的标题栏红点(`WindowTitleBar.tsx:145`)开始工作。
3. **AppDefinition 扩展(后续轮)**:`canSuspend?: (instanceKey) => boolean` + `prepareSuspend?: (instanceKey) => Promise<void>`;调度器对 dirty 候选先调 `prepareSuspend`(内部走 `saveContentNow`),保存成功才允许 frozen;失败保持 background。`keepAliveWhenOccluded` 白名单(G8)降级为纯性能提示,不再承担数据安全职责。

必须同时写进契约的不变量:**dirty 窗永不 frozen ⇒ 预算可能超限 ⇒ 超限时按「多冻干净窗、其次收紧 visible 档节流」消化,绝不反向牺牲脏窗**(与 Chrome「极端内存压力才碰受保护标签」一致,但我们没有极端档,一律不碰)。

### C. Handoff descriptor(修 G4/G5)

双向、显式、可校验的小结构,不合并 Finder bucket:

```ts
interface WorkbenchHandoffDescriptor {
  version: 1;
  appType: string;            // 焦点窗 typeId
  resourceId: string | null;  // instanceKey 或 getResourceWorkspaceActive(type)
  innerRoute?: string;        // 应用内部路由(可选,应用自愿提供)
  savedAt: number;
}
```

- **Workbench → 经典壳**:deactivation 事务通过后、卸载前,从焦点窗采集 descriptor,写独立 settings key(如 `desktop.workbenchHandoff`,不混入 `desktop.workbenchSnapshot`,保持 `sanitizeSnapshot` 白名单纯净性不变);经典壳挂载时消费一次并清除,经 `legacyNavigationMap.translateLegacyNavigation` 既有映射落到对应 view(`legacyNavigationMap.ts:75-135`,资源类 → learning-hub + openResource,零新导航协议)。
- **经典壳 → Workbench**:复用 `workbenchBus.launch({ typeId, instanceKey })` 打开同一资源,总线已具备(`workbenchBus.ts:200-239`)。
- 单实例工作区(exam/essay/translation)的 resourceId 采集点就是 `resourceWorkspaceRegistry.getResourceWorkspaceActive`(`resourceWorkspaceRegistry.ts:60-62`)——这补上了评审缝一指出的「从 launcher 打开则连重建选中项的 payload 都没有」。
- 静态可验证:sanitize 函数 + 「descriptor 写入→消费→清除」的纯函数测试。

### D. 桌面窄窗策略(G7,按评审建议 2 重议)

评审建议 2 原文方向:「桌面平台不要仅因宽度 <768px 自动换壳;若坚持按宽度换壳,必须走第 1 条事务」。两案对比:

| | 方案一:紧凑形态(不换壳) | 方案二:保留换壳但走事务 |
|---|---|---|
| 行为 | 桌面平台恒 Workbench;<768px 时 Workbench 进 compact(窗口自动 maximized、Dock 折叠),仅 `isMobilePlatform()` 进经典壳 | 维持现状路由,断点稳定后先跑 A 事务,任一窗取消则不切 |
| 既有支撑 | `windowStore.ts:36,307,319` 已有 `SMALL_DESKTOP_WIDTH=1280` 下自动 maximized 开窗;子应用已按容器宽度支持 compact(评审「做对了什么」§2);Finder 工具栏容器宽度驱动 compact(评审引用) | A 事务本身;`App.tsx:849-857` 迟滞保留 |
| 风险 | Dock/菜单栏/Exposé 在 <768px 的可用性需要一轮 UI 打磨;紧凑形态是新表面 | 用户在窄窗下被弹「N 个确认对话框」体验差;dirty 窗多时切壳事实上不可达;handoff(C)成为硬依赖 |
| 与业界对照 | Stage Manager/Arc:形态切换不销毁会话 | 无直接对应(业界没有「窗口变窄就杀会话」的先例) |

**本轮推荐:方案一为目标态,方案二为过渡护栏。** 理由:(a) 业界无「宽度触发生命周期终止」先例,窄窗换壳把布局问题升级成了数据安全问题;(b) 方案一使 `App.tsx:849-857` 整段迟滞与其风险注释可删,root cause 消失;(c) 即便采方案一,A 事务仍需存在(模式开关、退出两条路径不消失),两案不互斥。**最终决策留给评审第 2 轮合议,本轮不改代码。**

---

## 五、Agent 结合点

`AgentBridge` 以 `workbenchActive` 同步启停 StageManager 与总线(`src/features/workbench/agent/AgentBridge.tsx:18-31`),Agent 运行时(observe/act/waitFor,`workbenchBus.ts:248-283`)因此与两条缝直接相关:

1. **deactivation 事务须对 Agent 可见。** 切壳瞬间 `workbenchBus.setEnabled(false)`(`AgentBridge.tsx:21,28`),进行中的 `actAgent/waitForAgent` 会静默失效(activation waiters 以 not-ready 冲刷,`workbenchBus.ts:97-100,131-138`)。事务应在开始时广播「deactivating」状态,让 StageManager 拒绝新 act 并给结构化错误码(现有 `WORKBENCH_DISABLED` 回执模式可复用,`workbenchBus.ts:289-295`),而不是让 Agent 的 10s 超时(`workbenchBus.ts:56`)背锅。
2. **`canSuspend` 保护 Agent 目标窗。** Agent 正在 observe/act 的窗口若被冻结,子树卸载即 `ACTIVATION_NOT_READY`(`workbenchBus.ts:365-372`)。调度器已有的 `requestWakePrefetch`(`scheduler.ts:458-464`)可由 Agent 运行时在 act 前调用,把目标窗预取出冻结候选——这是零新 API 的既有结合点,建议在 agentRuntime 落 act 前显式调用。
3. **事务本身可成为 Agent 语义动作。** 「保存全部并退出桌面」适合暴露为 StageManager 的 app_command:Agent 逐窗触发 save handler(`saveContentNow`,`contentDirtyRegistry.ts:93-103`)后再走事务,给自动化流程一条不弹对话框的确定性退出路径。
4. **handoff descriptor 供 Agent 读取。** Agent 在双壳环境下回答「用户刚才在编辑什么」需要跨壳连续性;descriptor 是现成的结构化答案源,可挂进 `getAgentCapabilities` 的上下文。

---

## 六、后置项与边界声明

- **Exposé 活体 DOM(G9)后置第 8 轮,本轮仅书面化:** 现实现对窗口 DOM 施加 transform 缩放、明确「不卸载不截图」,重窗降级只关 backdrop-filter/box-shadow 视觉特效(`src/features/workbench/components/ExposeOverlay.tsx:1-33` 头注,含 `beginExposeHeavyContentPause` 挂点 29-32)。业界终态是合成器缩略图(Mission Control),对应改造是快照缩略图替代活体缩放;但评审已明确顺序约束——**修性能之前必须先保证冻结不丢草稿(缝二)**,否则 Exposé 减压手段恰好扩大数据丢失面。第 8 轮前不动。
- 本轮为静态调研:未编译、未运行测试、未做真机验证;所有行号以 `cursor/0824-wave2-desktop-subapps-a875` 当前工作树为准。§四各子集的「静态可验证」指可用现有 vitest 基础设施书写的断言,本轮未执行。
- 桌面窄窗最终策略待第 2 轮评审合议;本文仅给出对比与推荐。
