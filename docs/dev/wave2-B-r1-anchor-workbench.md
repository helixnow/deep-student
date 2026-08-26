# 0824 Wave2-B 第 1 轮锚定 — workbench 核心域（宿主 / 调度 / 快照 / 总线）

- 基线：`/workspace @ 061b4815`（工作区 tip `82e016b7` 为空的分支起始提交，`git diff 061b4815..HEAD` 为空，下列行号即 061b4815 现码行号）。
- 方法：指定文件从头到尾全量阅读（非关键词扫描），逐条对照 `docs/0824-quality-review/workbench-fg.md` 复核行号。
- 角色边界：本轮只锚定，不改产品代码，不实现修复；第 3 节是给第 2 轮实现员的插入点地图。

---

## 1. 文件职责、关键类型/函数、生命周期状态机

### 1.1 生命周期状态机总览（先看这个）

窗口内容存在五个实际状态，其中四个是 `WindowLifecycle` 显式档位，第五个（unmounted）是 React 树的物理事实：

| 状态 | 判定者 | 判定条件 | WindowBody 渲染行为 |
|---|---|---|---|
| `focused` | scheduler | 焦点栈顶且非 minimized（`scheduler.ts:527`） | 完整挂载，`isActive=true`（`WindowBody.tsx:176`） |
| `visible` | scheduler | 非栈顶但有可见面积（`scheduler.ts:531`） | 完整挂载，`isVisible=true` + throttle hint（`WindowBody.tsx:177,182`） |
| `background` | scheduler | minimized，或被上层矩形并集完全遮挡且非 `keepAliveWhenOccluded`（`scheduler.ts:526,528-530`） | **DOM 保留但停绘**：`visibility:hidden` + `contentVisibility:hidden`，`isSuspended=true` 下传（`WindowBody.tsx:215,222-226,239`）。React 子树仍挂载，dirty checker 仍在。 |
| `frozen` | scheduler | 预算超限时对 background 按 `lastFocusedAt` LRU 冻结，宽限 2500ms（`scheduler.ts:542-571`） | **卸载整棵应用子树**，只渲染 `FrozenPlaceholder` 玻璃占位卡（`WindowBody.tsx:186-194`）。点击占位卡 `handleWake`（164-172）focusWindow + 乐观解冻 + `recomputeLifecycles()`。 |
| unmounted | store / App 壳 | `closeWindow` 从 store 删除（`windowStore.ts:348-364`），或 `workbenchActive` 翻 false 时整棵 `LazyWorkbenchDesktop` 卸载（`App.tsx:2810-2815`） | 整窗消失。关窗路径走 `canClose`；**壳卸载路径不走**（见第 2 节缝一）。 |

状态迁移要点：

- `focused/visible → background`：遮挡或最小化，DOM 保留，无任何应用侧回调。
- `background → frozen`：**唯一卸载应用子树而不询问任何人的迁移**（缝二核心）。候选先进 `pendingFreezeIds` 宽限（`scheduler.ts:558-562`），宽限内被聚焦/解除压力则取消。
- `frozen → focused`：占位卡点击（`WindowBody.tsx:164-172`）或 `requestWakePrefetch` 预取回 background（`scheduler.ts:458-464`）。唤醒只能从已持久化数据重建。
- hydrate 初始：栈顶 `focused`、其余 `background`（`windowStore.ts:554-558`），随后 snapshot.ts 的逐帧唤醒每帧提一个 `background→visible`（`snapshot.ts:429-477`），完毕后 `recomputeLifecycles()` 收敛真值。

### 1.2 `src/features/workbench/core/scheduler.ts`（709 行）

职责：四档生命周期判定 + 内存预算冻结 + 渲染节流提示（render hints）。

- 常量：`DEFAULT_MEMORY_BUDGET = 12`（44）、`MACOS_MEMORY_BUDGET = 9`（45）、`FREEZE_GRACE_MS = 2500`（49）、`WAKE_PREFETCH_MS = 4000`（51）。
- `memoryWeightOf`（117-119）：读 `AppDefinition.memoryWeight`（缺省 1）；`keepsAliveWhenOccluded`（121-123）：遮挡不降 background 的唯一白名单口子。
- `useWindowLifecycle(windowId)`（138-147）：WindowBody 消费的 hook，显式 lifecycle 优先，否则按焦点栈派生。
- `recomputeLifecycles()`（490-609）：全量重算核心。四档判定 525-532；焦点切换 defocus 宽限 535-540；**预算冻结选择循环 542-571**（候选 = `next[win.id] === 'background'` 按 `lastFocusedAt` 升序，548-550；预取豁免 skip 554；宽限计时 556-562；`used -= memoryWeightOf(win)` 564）；写回 `state.setLifecycles(next)` 592-594。
- render hints：`WindowRenderHint`（198-210），`computeHint`（266-306），`refreshRenderHints`（309-341），`getWindowRenderHint`/`subscribeRenderHints`/`useWindowRenderHint`（357-380）。
- 活动降频：`reportSchedulerActivity`（392-401）、`beginSchedulerDragActivity`（416-443，拖拽 begin/end 深度计数）。
- `startScheduler()`（643-709）：订阅 store（windows/focusStack/tilingRatios 立即重算，desktopSize 防抖 160ms），返回停止函数；`armTransientTimer`（616-631）武装宽限/豁免到期的自动补算。
- 测试钩子：`setFreezeGraceOverride`（104-106）、`setSchedulerNowForTests`（113-115）、`resetSchedulerTransientsForTests`（467-479）。

### 1.3 `src/features/workbench/core/snapshot.ts`（483 行）

职责：布局快照的分层防抖持久化、白名单 sanitize、跨分辨率恢复、逐帧唤醒。

- key：`WORKBENCH_SNAPSHOT_KEY = 'desktop.workbenchSnapshot'`（36），layout 层 2s / meta 层 10s 防抖（37-39）。
- `sanitizeWindow`（119-141）：单窗白名单，字段仅 `id/typeId/instanceKey/title/frame/restoreFrame/displayMode/minimized/zIndex/createdAt/lastFocusedAt`。
- `sanitizeSnapshot`（182-258）：结构性坏数据 → null + warn；`migrateSnapshotShape`（155-176）容错版本迁移。
- `pickShellFields`（274-288）：**只提取壳字段**（详见第 5 节）。
- `buildSnapshot`（291-304）→ `persistNow`（313-345，双保险再过一次 sanitizer 317）→ `saveSnapshot`（355-365）/ `flushSnapshot`（368-375，退出前强制写）。
- `loadSnapshot`（382-401）：读 + parse + sanitize，任何失败 null 不抛；停放 desktopSize 给 store。
- 逐帧唤醒 `runStagedWake`（429-477），模块加载即 `registerPostHydrateHook(runStagedWake)`（482）。

### 1.4 `src/features/workbench/components/WindowBody.tsx`（254 行）

职责：生命周期感知的应用内容挂载壳，四档策略的执行者。

- `ActivationPendingMarker`/`ActivationReadyMarker`（33-51）：向 workbenchBus 登记激活可送达性（Suspense fallback 提交 = pending，App 子树 effects 装好 = ready；宿主卸载时 `clearWindowActivation`）。
- `FrozenPlaceholder`（96-123）：frozen 档唯一渲染物，`onWake` 点击唤醒。
- 主组件（129-251）：`lifecycle === 'frozen'` 时 return 占位卡（186-194）——**此分支下 `<App/>` 子树整体卸载**；background 时双隐藏但子树保留（215,219-227）；`isActive/isVisible/renderThrottleMs/isSuspended` 下传（232-242）。
- `handleWake`（164-172）：focusWindow + 乐观改 lifecycles + `recomputeLifecycles()`。

### 1.5 `src/features/workbench/components/WorkbenchDesktop.tsx`（662 行）

职责：桌面总装（层序、启动链路、持久化订阅、卸载清理）。

- 设置读取（99-139）+ `workbench:settings-changed` 热更新（336-367）。
- 快照恢复业务过滤：`PROJECTION_ONLY_TYPE_IDS`（146）、`migrateLegacyNotesSnapshotWindows`（150-167）、`pruneSnapshotWindows`（173-200，已删资源壳丢弃）。
- **启动链路 + 卸载清理 effect（418-476）**：`startScheduler`（420）→ `registerSystemProjections`（421）→ `registerDockPinnedProvider`（422）→ store 订阅触发 `saveSnapshot()`（424-428）→ 按 `restoreSession` 设置决定是否 `loadSnapshot → pruneSnapshotWindows → hydrate`（429-464）。**卸载清理（466-475）：unsubscribe → `void flushSnapshot()` → 注销 provider → disposeProjections → stopScheduler。没有任何逐窗 canClose 枚举。**
- 「恢复上次桌面」CTA `restoreLastSession`（479-491）。
- 窗口渲染：`windowsFingerprint` selector（520-530）→ `orderedWindows` → `WindowShell` 列表（603-610）。

### 1.6 `src/features/workbench/core/legacyNavigationMap.ts`（145 行）

职责：workbench 关闭时把 `launch/activate` 请求翻译回 legacy CustomEvent 导航（详见第 4 节）。

- `RESOURCE_TYPE_IDS`（30-41）→ learning-hub + openResource；`VIEW_BY_TYPE_ID`（43-54）→ 各视图；`LEGACY_NOOP_TYPE_IDS`（59）pomodoro 静默 / browser+flashcards 提示「仅桌面端可用」。
- `translateLegacyNavigation`（75-135）：纯事件派发，无状态迁移。
- `installLegacyNavigationFallback`（140-144）：App 启动时幂等注册（`App.tsx:809` 调用）。

### 1.7 `src/features/workbench/apps/content/contentDirtyRegistry.ts`（110 行）

职责：编辑类视图（note/essay/translation/exam）的脏状态与保存挂点注册表——`AppDefinition.canClose` 的数据源。

- `registerContentDirtyChecker`（28-44）：**React 视图挂载时注册、卸载时注销**（返回注销函数）——这正是冻结丢草稿的结构性根源：frozen 卸载子树 → checker 随之消失。
- `isContentDirty`（47-60）：任一 checker true 即 dirty；checker 抛错按 dirty 处理（fail-closed）。
- `registerContentSaveHandler`（66-82）/ `hasContentSaveHandler`（85-87）/ `saveContentNow`（93-103）：「保存并关闭」链路。
- 键规范化 `keyOf`（20-22）走 `normalizeResourceInstanceKey`，路径别名不绕保护。
- 真实消费者（复核过）：`TranslateWorkbench.tsx:387-391`（checker）+ `424-428`（save handler）；`EssayGradingWorkbench.tsx:234-238`（仅 checker）；`NotesCrepeEditor.tsx:1467-1473`、`NotesEditorHeader.tsx:111-114`；`ExamContentView.tsx:494-497`。

### 1.8 `src/features/workbench/core/workbenchBus.ts`（431 行）

职责：三分打开语义（launch / activate / project）+ legacy 降级 + 激活就绪握手 + ACR agent 入口。

- `setEnabled/isEnabled`（186-192）：由 AgentBridge 和设置页驱动的总闸。
- `registerLegacyFallback`（195-197）；`launch`（200-239）：`!enabled` 时只转 legacyFallback 返回 null（201-204）；notes/资源工作区特判（206-231）。
- 激活就绪：`markWindowActivationPending/Ready`（82-90）、`clearWindowActivation`（97-100）、`waitForActivationTarget`（102-129，10s 超时）；store 订阅清理已关窗口（131-138）。
- `activateDetailed`（286-385）：`!enabled` → legacyFallback + `WORKBENCH_DISABLED` 回执（288-296）；single 按 typeId / multi 按 instanceKey / 空 key 回落焦点窗（334-351）；`fallbackLaunch`（352-355）。
- `closeWindow`（422-429）：**唯一走 `confirmWindowClose`（canClose 拦截）的关窗入口**。
- 辅助（本轮相关）：`confirmWindowClose` 在 `core/windowCloseGuard.ts:69-82`（single-flight 询问 `AppDefinition.canClose`）；同文件 `setWindowDirty/isWindowDirty`（23-32）是标题栏红点的窗口级脏标记。

### 1.9 `src/features/workbench/core/windowStore.ts`（608 行）

职责：窗口状态机唯一真相源（zustand），结构性不变量见文件头 8-16。

- state：`windows / focusStack / lifecycles / launchPayloads / tilingRatios / desktopSize / transientPhases`（275-281）。
- `openWindow`（283-346）：multi/single 去重、级联落位 `nextCascadeOrigin`（82-114）、background 开窗不夺焦（309-311,329-332）。
- `closeWindow`（348-364）：**纯删除，不含任何确认**——确认在上游 `workbenchBus.closeWindow`。
- `focusWindow`（366-387）：栈顶 no-op；`maybeCompactZ`（153-162）zIndex 紧凑重排。
- `setLifecycles`（481）：scheduler 的写回口。
- `hydrate`（518-583）：跨分辨率自适应 `adaptFrameToDesktop`（187-213）、zIndex 归一化、**初始 lifecycles 栈顶 focused / 其余 background**（554-558）、`launchPayloads` 整体替换时清空（570-575 注释「快照绝不含 payload」）、末尾 `postHydrateHook?.()`（582）。
- `registerPostHydrateHook`（223-225）、`setPendingRestoreDesktopSize`（174-179）。

### 1.10 `src/features/workbench/agent/AgentBridge.tsx`（53 行）

职责：App 根部常驻挂载点，把 `workbenchActive` 同步到 bus 与 stageManager。

- `useLayoutEffect`（19-31）：`!workbenchActive` → `workbenchBus.setEnabled(false)` 直接返回；active → `stageManager.start()` + `setEnabled(true)`，cleanup 反向。**翻 false 是即时同步动作，无任何 dirty preflight。**
- `useEffect`（33-48）：`setupAgentBridge()` 一次性装拆。

### 1.11 `src/App.tsx` 的 workbenchActive / 断点 / LazyWorkbenchDesktop 段

- 深路径导入 + lazy chunk：156-164（`importWorkbenchDesktop` 163，`LazyWorkbenchDesktop` 164）；模块级预热 168-180（localStorage 同步预读 + `!isMobilePlatform()` 护栏）。
- `WORKBENCH_MODE_CACHE_KEY = 'desktop.workbenchMode'`（166）。
- `workbenchMode` state（799-807，缺失键 → true 产品默认）；effect 808-840：`installLegacyNavigationFallback()`（809）、`resolveWorkbenchModeEnabled` 异步校准（818-830）、监听 `WORKBENCH_MODE_CHANGED` 即时翻转（831-835）。
- **断点迟滞（842-857）**：注释自认「isSmallScreen 在 768 边界即时翻转会整壳硬切…绕过 ResourceAppWorkspace 的未保存确认与 windowCloseGuard」（845-847）；`shellStableSmallScreen` 250ms 确认后仍直接提交（850-857）。
- **`workbenchActive = workbenchMode && !shellStableSmallScreen && !isMobilePlatform()`（858）**。
- 渲染二选一（2810-2816）：`workbenchActive ? <Suspense><LazyWorkbenchDesktop/></Suspense> : legacy 视图集`；`AgentBridge workbenchActive` 传参（2524）；顶栏/侧栏隐藏（2574,2700-2713）；`GlobalPomodoroWidget workbenchActive`（2904）。

### 1.12 `src/features/settings/components/WorkbenchSettingsSection.tsx` 模式开关段

- key 表 `WORKBENCH_SETTING_KEYS`（53-82，`mode: 'desktop.workbenchMode'` 54）。
- **`handleModeChange`（292-309）**：乐观 setMode（294）→ persist（295）→ 失败回滚（296-299）→ `!enabled` 时仅 `closeBrowserForDisabledGate()`（300，只关原生 browser）→ `workbenchBus.setEnabled(enabled)`（301）→ 派发 `WORKBENCH_MODE_CHANGED`（303）。**全程无逐窗 canClose、无 dirty preflight、无失败回滚模式 UI 的分支（persist 成功即走到底）。**
- 开关 UI 绑定（447-456）。

---

## 2. 两条 FAIL 缝的现码证据（对照 workbench-fg.md 复核）

fg 文档所有关键行号在 061b4815 上复核结果：**两条缝全部仍然成立**，个别引用有 1-2 行漂移（下面给出现码精确行号）。

### 缝一：壳切换（模式开关 / 断点）绕过脏数据协议 — 仍成立

触发路径 A（设置页关闭）：

```292:307:src/features/settings/components/WorkbenchSettingsSection.tsx
  const handleModeChange = useCallback(
    async (enabled: boolean) => {
      setMode(enabled);
      const ok = await persist(WORKBENCH_SETTING_KEYS.mode, String(enabled), enabled);
      if (!ok) {
        setMode(!enabled);
        return;
      }
      if (!enabled) await closeBrowserForDisabledGate();
      workbenchBus.setEnabled(enabled);
      try {
        dispatchAppEvent(APP_EVENTS.WORKBENCH_MODE_CHANGED, { enabled });
      } catch {
        // noop
      }
    },
```

（fg 引 292-308，现码 292-309，成立。）

触发路径 B（断点持续 <768px）——注释自己承认风险，250ms 只是防抖：

```845:858:src/App.tsx
  // 迟滞（250ms 宽度稳定确认）：isSmallScreen 在 768 边界即时翻转会整壳硬切，
  // WorkbenchDesktop 连同所有窗口立刻卸载，绕过 ResourceAppWorkspace 的未保存
  // 确认与 windowCloseGuard。拖拽窗口宽度瞬间穿越 768 再回来时不应误卸载整棵树。
  // 仅工作台壳切换用稳定值；页面内布局仍用即时 isSmallScreen，不受影响。
  const [shellStableSmallScreen, setShellStableSmallScreen] = useState(isSmallScreen);
  useEffect(() => {
    if (isSmallScreen === shellStableSmallScreen) return;
    const timer = window.setTimeout(() => {
      // 250ms 后仍是新值才提交（期间弹回则本 effect 已被 cleanup 取消）
      setShellStableSmallScreen(isSmallScreen);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [isSmallScreen, shellStableSmallScreen]);
  const workbenchActive = workbenchMode && !shellStableSmallScreen && !isMobilePlatform();
```

（fg 引 842-857 + 796-858，成立。）

卸载终点——WorkbenchDesktop 清理只 flush 快照，不枚举窗口：

```466:475:src/features/workbench/components/WorkbenchDesktop.tsx
    return () => {
      disposed = true;
      unsubscribeStore();
      unsubscribePinned();
      // 先落盘（buildSnapshot 同步采集，provider 仍在）再注销
      void flushSnapshot();
      registerDockPinnedProvider(null);
      disposeProjections();
      stopScheduler();
    };
```

（fg 引 417-475：effect 起点现码 418，cleanup 466-475，成立。）而 canClose 拦截链只存在于显式关窗入口 `workbenchBus.closeWindow`（`workbenchBus.ts:422-429` → `windowCloseGuard.ts:69-82`），壳卸载完全不经过它。

### 缝二：内存冻结绕过同一协议 — 仍成立

冻结候选选择只看 lifecycle / 权重 / 预取豁免，无 dirty / canSuspend 检查：

```542:565:src/features/workbench/core/scheduler.ts
    // 预算冻结：超预算时从 background 里按 lastFocusedAt 最旧优先冻结。
    // O10：候选先进入「即将冻结」宽限（graceMs），宽限内解除压力/被聚焦即取消；
    // 唤醒预取豁免期内的窗口跳过（保持 background，DOM 可重建）。
    const graceMs = getFreezeGraceMs();
    let used = wins.reduce((sum, win) => sum + memoryWeightOf(win), 0);
    if (used > budget) {
      const candidates = wins
        .filter((win) => next[win.id] === 'background')
        .sort((a, b) => a.lastFocusedAt - b.lastFocusedAt);
      const selected = new Set<string>();
      for (const win of candidates) {
        if (used <= budget) break;
        if ((wakePrefetchUntil.get(win.id) ?? 0) > nowMs) continue; // 预取豁免
        selected.add(win.id);
        const since = freezeCandidateSince.get(win.id);
        if (since == null) freezeCandidateSince.set(win.id, nowMs);
        if ((since != null && nowMs - since >= graceMs) || graceMs <= 0) {
          next[win.id] = 'frozen';
        } else {
          pending.add(win.id);
        }
        // 宽限期内按「将被回收」计入，保证只选必要数量的候选
        used -= memoryWeightOf(win);
      }
```

（fg 引 44-53 / 117-123 / 542-575：预算常量 44-45、宽限 49、`memoryWeightOf` 117-119、`keepsAliveWhenOccluded` 121-123、冻结块 542-571，全部成立。）

frozen 直接卸载应用子树（fg 引 184-193，现码精确为 186-194，漂移 2 行，语义不变）：

```186:194:src/features/workbench/components/WindowBody.tsx
  if (lifecycle === 'frozen') {
    return (
      <FrozenPlaceholder
        title={win.title}
        icon={def?.icon ?? null}
        onWake={handleWake}
      />
    );
  }
```

而 dirty checker 的生命周期与视图子树绑定——卸载即注销：

```28:44:src/features/workbench/apps/content/contentDirtyRegistry.ts
export function registerContentDirtyChecker(
  typeId: string,
  instanceKey: string | null,
  isDirty: () => boolean,
): () => void {
  const key = keyOf(typeId, instanceKey);
  const existing = checkers.get(key) ?? new Set<() => boolean>();
  existing.add(isDirty);
  checkers.set(key, existing);
  return () => {
    const registered = checkers.get(key);
    registered?.delete(isDirty);
    if (registered?.size === 0) {
      checkers.delete(key);
    }
  };
}
```

链条闭合：`background`（子树在、checker 在，但用户看不见）→ 预算超限 2500ms → `frozen`（子树卸载、checker 注销、未保存缓冲丢失）→ 唤醒只能从落库数据重建。`canClose` 全程未被咨询（冻结不是关窗）。消费者侧行号复核：`TranslateWorkbench.tsx:387-391/424-428`、`EssayGradingWorkbench.tsx:234-238`（fg 引 386-429 / 233-239，成立）。

---

## 3. 第 2 轮 deactivation transaction / canSuspend 插入点地图

> 只列「在哪插、动什么、复用什么」；不含实现。行号均为 061b4815 现码。

### 3.1 Deactivation transaction（缝一）

事务语义（fg 优化顺序第 1 条）：模式关闭 / 断点切壳 / 应用退出前，先枚举窗口执行 canClose / save checkpoint；任一取消或保存失败 → 保持 Workbench 激活并回滚模式 UI。

| # | 插入点 | 文件:行 | 要动什么 |
|---|---|---|---|
| T1 | 事务本体（新函数，建议放 workbench core，如 `core/deactivationTransaction.ts` 新文件或挂在 windowCloseGuard 旁） | 复用：`useWindowStore.getState().windows` 枚举；`confirmWindowClose(windowId)`（`core/windowCloseGuard.ts:69-82`，已 single-flight）；可选批量语义复用 `workbenchBus.closeWindow`（`core/workbenchBus.ts:422-429`）；「保存并关闭」走 `hasContentSaveHandler`/`saveContentNow`（`contentDirtyRegistry.ts:85-87,93-103`）；结束时 `flushSnapshot()`（`snapshot.ts:368-375`） | 新增 `runWorkbenchDeactivationTransaction(): Promise<boolean>`：逐窗（可只对 `canClose` 存在或 `isContentDirty`/`isWindowDirty` 为真的窗）确认；任一 false → 返回 false，调用方取消停用 |
| T2 | 设置页开关 | `WorkbenchSettingsSection.tsx:292-309` `handleModeChange`；具体在 `setMode(enabled)`（294）**之前**（或先 await 事务再 persist） | `enabled === false` 时先 await T1；false → 不 persist、不派发事件、开关 UI 回弹（复用 296-298 的回滚模式） |
| T3 | 断点切壳提交点 | `App.tsx:850-857` 的 `setShellStableSmallScreen(isSmallScreen)`（854）；以及 `workbenchActive` 推导（858） | 250ms 稳定后、提交 `shellStableSmallScreen=true`（即将令 `workbenchActive=false`）之前 await T1；被取消则不提交（保持宽壳），或按 fg 建议 2 改为桌面平台不按宽度换壳（那样 T3 退化为只保 `isMobilePlatform` 路径） |
| T4 | 模式事件消费端兜底 | `App.tsx:831-835` `WORKBENCH_MODE_CHANGED` 监听 | 若事务收敛在 T2（推荐），此处只需信任事件；若允许第三方派发该事件，需在 `setWorkbenchMode(false)` 前同样闸一次 T1 |
| T5 | AgentBridge 顺序确认 | `AgentBridge.tsx:19-31` | 不动逻辑，但事务完成前 `workbenchActive` 不得翻 false ⇒ `setEnabled(false)` 自然后置；验证无早翻 |
| T6 | Desktop 卸载清理 | `WorkbenchDesktop.tsx:466-475` | 保持现状（flushSnapshot 是事务的最后一步之后的兜底）；事务不放这里——unmount cleanup 不能异步阻塞 |

### 3.2 canSuspend / prepareSuspend（缝二）

| # | 插入点 | 文件:行 | 要动什么 |
|---|---|---|---|
| S1 | 契约字段 | `core/types.ts:438-466` `AppDefinition`（`canClose` 在 466、`keepAliveWhenOccluded` 在 453 旁） | 新增可选 `canSuspend?: (instanceKey: string | null) => boolean`（同步，热路径每轮重算要调；语义：false = 保持 background 不得 frozen）；如需保存后放行，另加 `prepareSuspend?` 异步钩子（由宽限期驱动，不在重算同步路径） |
| S2 | 调度器判定 | `scheduler.ts:552-565` 冻结选择循环；具体在预取豁免 skip（554）旁加同型 skip；helper 放 `keepsAliveWhenOccluded`（121-123）旁，如 `canSuspendWindow(win)` 读 `appRegistry.get(win.typeId)?.canSuspend`（appRegistry 已在 32 行 import，core 不需要反向 import apps 层） | dirty 窗 `continue`；**注意**：skip 时不得执行 564 的 `used -= memoryWeightOf(win)`（否则预算记账把未回收的窗算成已回收）；也不得进 `selected`/`freezeCandidateSince` |
| S3 | 内容应用实现 canSuspend | `apps/content/createContentApp.tsx:55-93`（canClose 工厂在 55-63，def 组装 85-93）；`apps/content/register.ts:640-648`（exam 特判 `canCloseExamWorkspace` 159-165 同位） | 内容应用的 `canSuspend = !isContentDirty(typeId, resolvedKey)`；essay/translation 的 instanceKey=null 回落 `getResourceWorkspaceActive(typeId)`（复用 createContentApp.tsx:57-61 现成逻辑）——分层正确：dirty registry 留在 apps/content，core 只经 AppDefinition 间接消费 |
| S4 | 窗口级脏兜底 | `core/windowCloseGuard.ts:30-32` `isWindowDirty` | 调度器 skip 条件可再并上 `isWindowDirty(win.id)`（同在 core 层，无分层问题；覆盖未接 content registry 但打了红点的应用） |
| S5 | 宽限期可见化（可选） | `scheduler.ts:558-562`（pendingFreezeIds）+ `WindowRenderHint.freezeImminent`（207） | `prepareSuspend` 若做：宽限期内触发一次保存，成功后下一轮自然 frozen；失败保持 background |
| S6 | 测试位 | `scheduler.ts:104-115` override 钩子 + `resetSchedulerTransientsForTests`（467-479）；`contentDirtyRegistry.ts:106-109` `__resetContentDirtyRegistry` | fg 要求的行为测试「dirty background 窗在预算超限时不冻结」：`setFreezeGraceOverride(0)` + `setMemoryBudgetOverride(小值)` + `registerContentDirtyChecker(→true)` 后 `recomputeLifecycles()` 断言仍 background |

### 3.3 顺序建议

先 S1-S4（缝二纯 workbench 域内，改动收敛在 types/scheduler/createContentApp 三点），再 T1-T3（缝一跨 settings/App 壳，需要回滚 UI 语义）。两者共享 dirty 真相源（contentDirtyRegistry + windowCloseGuard），实现员先做 S 系可顺手把「哪些窗算 dirty」的枚举函数抽出来给 T1 复用。

---

## 4. handoff 现状：legacyNavigationMap 只做「下次打开去哪」

证据链（全部现码）：

1. bus 的降级只发生在**新请求**入口：`workbenchBus.launch` 在 `!enabled` 时 `legacyFallback?.(req, 'launch'); return null;`（`workbenchBus.ts:201-204`）；`activateDetailed` 同型（288-296，回执 `WORKBENCH_DISABLED`）。没有任何「壳切换时刻遍历已开窗口」的调用点。
2. `translateLegacyNavigation`（`legacyNavigationMap.ts:75-135`）的全部输出是 `window.dispatchEvent(NAVIGATE_TO_VIEW …)` 与延迟的页面级事件（`dispatchDeferred` 70-72）——纯前向导航，签名里只有 `typeId/instanceKey/action/payload`，不携带窗口几何、内部 tab、滚动位、返回栈。
3. 停用时刻的实际动作只有 `workbenchBus.setEnabled(false)`（`AgentBridge.tsx:21,28`）：已打开窗口的资源上下文既不注入 legacy `currentView`（App.tsx:860 独立维护），也不产生任何 handoff descriptor。fg「接缝三」的判定（隔离而非交接，`currentView` 与焦点窗口两套状态）在现码原样成立；fg 建议的 `{ appType, resourceId, innerRoute }` descriptor 目前无任何对应实现（仓内无此结构）。
4. 反向（legacy → workbench）同样只有「下次打开」：`installLegacyNavigationFallback` 在 App 启动注册一次（`App.tsx:809`），不存在把 legacy 视图状态带回 workbench 的通道。

结论：现状 handoff = 「资源共用、宿主隔离」，仅保证停用后**新的** launch/activate 有去处；不迁移在编窗口。

---

## 5. 快照契约边界：只存壳、不存草稿

契约声明（`snapshot.ts:13-16` 文件头）：「白名单剥离——只保留 WorkbenchSnapshotV1 声明的字段，lifecycle / launch payload / 未知注入字段一律丢弃（快照纯净性 P0 约束，§7）」。

结构性保证四层：

1. **采集面**：`pickShellFields`（`snapshot.ts:274-288`）逐字段手写拷贝，只有 `id/typeId/instanceKey/title/frame/restoreFrame/displayMode/minimized/zIndex/createdAt/lastFocusedAt`——没有 payload、没有 lifecycle、没有任何应用内部状态的出口。
2. **落盘面**：`persistNow` 把采集结果**再过一次** `sanitizeSnapshot`（317 「双保险」），未知字段二次剥离。
3. **读入面**：`sanitizeWindow`（119-141）同一白名单校验，坏窗口丢弃不拖垮整体。
4. **恢复面**：`windowStore.hydrate` 整体替换时 `launchPayloads: {}` 并注释「快照绝不含 payload / 瞬态标记」（`windowStore.ts:569-575`）；`transientPhases` 同样清空（576-580）；文件头不变量 4「transientPhases 为派生 UI 状态，绝不持久化」（`windowStore.ts:16`）。

边界后果（与缝一/缝二直接相关，fg 引 snapshot.ts:1-18,118-130 成立）：

- 快照能恢复的只有「窗口壳 + 几何 + z 序 + Dock 固定区 + 平铺比例 + 壁纸/材质」（`WorkbenchSnapshotV1` 构造见 224、245-256）。
- 多实例资源窗凭 `instanceKey` 能找回资源本体，但**未保存正文不在任何快照层**；essay/translation/exam 是 `instanceKey=null` 的单实例工作区（`workbenchBus.ts:58`、`createContentApp.tsx:57-61`），当前选中资源在 `ResourceAppWorkspace` 本地 state，`launchPayload` 又被 hydrate 清空——壳恢复后连「选中了哪个资源」都可能丢（fg 缝一后果第 2 条，现码成立）。
- 因此 deactivation transaction / canSuspend **不能指望快照兜底草稿**：快照契约就是刻意只存壳，第 2 轮不要试图往快照里塞草稿（违反 P0 纯净性），保存必须走 `saveContentNow` / 应用自身落库。

---

## 6. 18 不变量中与本域相关的静态自证

不变量口径：`docs/dev/0824-verify-step22.md:21-25`（18/18 PASS，逐项行号在进度仓 `docs/0824-static-audit/51-invariants-step22.md`，本仓未跟踪该文件）；G 侧 12 项逐条证据在 `docs/dev/0824-g-invariants.md`。与 workbench 宿主域相关的两条在 061b4815 静态复核如下（只点宿主侧，不越权全审）：

### 6.1 Finder 每宿主分桶（G 不变量 #7）

- `finderStore.ts:388-401` 声明 `FINDER_HOST_IDS = { files, page, page-mobile, canvas, canvas-mobile, group-picker }`；
- workbench 宿主侧：`files`（workbench Files 窗口）经 `HOSTS_SHARING_DEFAULT_BUCKET`（412）解析到 `default` 桶（`resolveFinderHostId` 415-418）——注释（405-411）明确原因是 Files 窗口的 activation / agent driver / 拖拽 hook 直接引用 `useFinderStore`（default 桶）；其余宿主各自独立桶，注册表 `Map<bucketId, store>`（1255-1268）。
- 宿主侧自证结论：workbench Files 与移动 Learning Hub（page-mobile）确实不同桶——这同时是不变量 PASS 的证据，也是第 4 节「隔离非交接」的结构基础。第 2 轮做 handoff descriptor 时**不需要**合桶（fg 建议 4 同此）。

### 6.2 闪卡只读（G 不变量 #4）— workbench 宿主侧

- 不变量本体在 generative-ui 域（`FlashcardPreviewBlock` 只渲染无持久化，见 `docs/dev/0824-g-invariants.md` 第 4 项），非本域职责。
- workbench 宿主侧自证：`apps/system/FlashcardsAppWindow.tsx:15-38` 是纯薄包装（WbSys 骨架 + `FlashcardsApp` 透传 `launchPayload/isActive`），未新增任何保存/入库入口；legacy 降级侧 `legacyNavigationMap.ts:59` 把 `flashcards` 列为 OS 专属 no-op + 「仅桌面端可用」提示（119-131），不会经降级路径开出第二个可写入口。宿主侧不破坏该不变量。

### 6.3 本域自身的结构性不变量（windowStore 文件头，供第 2 轮改动时守护）

`windowStore.ts:8-16` 声明四条：focusStack = 非 minimized 按 zIndex 升序（结构性由 `deriveFocusStack` 228-233 保证）；focusWindow 必提最高 zIndex（366-387）；tiled/maximized 渲染矩形由 computeTiledFrame 派生 frame 不动（487-516 注释）；transientPhases 绝不持久化（第 5 节已证）。第 2 轮 S2（调度器 skip）不触碰这四条；T1（枚举关窗）走 `closeWindow` 正路自动维持。

---

## 附：fg 文档行号复核汇总

| fg 引用 | 061b4815 现码 | 判定 |
|---|---|---|
| App.tsx:796-858（workbenchActive 门控） | 796-858 | 成立 |
| App.tsx:842-857（迟滞） | 842-857，workbenchActive 在 858 | 成立 |
| App.tsx:2810-2868（渲染二选一） | 2810-2816 为 workbench 分支 | 成立 |
| WorkbenchSettingsSection.tsx:292-308（handleModeChange） | 292-309 | 成立（尾行 +1） |
| WorkbenchDesktop.tsx:417-475（启动/卸载 effect） | 417 注释、418-476 effect、466-475 cleanup | 成立 |
| scheduler.ts:44-53,117-123,542-575 | 44-45,49,117-123,542-571(+573-576 计数) | 成立 |
| WindowBody.tsx:184-193（frozen 分支） | 186-194 | 成立（漂移 2 行） |
| WindowBody.tsx:174-249（props 下传） | 174-250 | 成立 |
| snapshot.ts:1-18,118-130 | 1-19 头注、119-141 sanitizeWindow | 成立 |
| contentDirtyRegistry.ts:24-43,62-81 | 28-44,66-82（含 docstring 即 24-44/62-82） | 成立 |
| TranslateWorkbench.tsx:386-429 | 387-391 checker、424-428 save | 成立 |
| EssayGradingWorkbench.tsx:233-239 | 234-238 | 成立 |
| AgentBridge.tsx:18-31 | 18-31 | 成立 |
| legacyNavigationMap.ts:30-143 | 30-144 | 成立 |
