# 0824 Wave2-B 第 5 轮 — P3 handoff descriptor(接缝三)

> 对照:`docs/0824-quality-review/workbench-fg.md` 接缝三(「隔离非交接」,建议 4)、
> `docs/dev/wave2-B-r1-workbench-gap.md` §四-C(descriptor 裁决)、
> `docs/dev/wave2-B-r1-anchor-workbench.md` §4(handoff 现状证据链)。
> 本文档上半为 handoff-1(本卡)实况,下半为 handoff-2(App.tsx 独占)骨架,由其填写。
> 验证口径:静态读码 + grep,未编译未跑测试(第 8 轮前禁止)。

## 上半:handoff-1(descriptor 本体 + Workbench→经典壳携带)

### 1. 问题与裁决回顾

接缝三判定:Finder 分桶(正确的并发隔离)+ `currentView` 与 Workbench 焦点窗两套
状态,使壳切换后用户「可能从正在编辑的作文瞬间回到 Chat」。裁决(fg 建议 4 +
workbench-gap §四-C):**不合并 Finder bucket**,只增加显式、可校验的交接结构——

```ts
{ version: 1, appType, resourceId, innerRoute?, savedAt }
```

独立 settings key `desktop.workbenchHandoff`(绝不混入 `desktop.workbenchSnapshot`,
快照白名单 P0 纯净性不变),双向共用、消费一次即清。

### 2. 交付物

#### 2.1 新建 `src/features/workbench/core/handoffDescriptor.ts`

| 导出 | 职责 |
|---|---|
| `WorkbenchHandoffContext` / `WorkbenchHandoffDescriptor` | 交接三元组 `{ appType, resourceId, innerRoute? }` 与持久化信封(+version/savedAt) |
| `buildHandoffDescriptor` / `serializeHandoffDescriptor` / `parseHandoffDescriptor` | 纯函数;逐字段 sanitize(appType `/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/`、resourceId trim ≤256、innerRoute 剥控制字符 ≤256);version/appType/savedAt 坏 → 整体 null,innerRoute 坏 → 单字段省略;绝不抛错 |
| `collectFocusHandoffDescriptor` | 从 `useWindowStore.getState()` 焦点栈顶采集 typeId/instanceKey;exam/essay/translation(instanceKey=null 单实例工作区)回落 `getResourceWorkspaceActive`(core→apps/content 引用先例:workbenchBus.ts:37-40);无焦点窗 → null |
| `registerHandoffInnerRouteProvider` | innerRoute 提供者注册表(typeId 键控,同步、抛错按无路由);**本轮只建通道不接线**,阅读器 `page:<n>` / hub `tab:<id>` 的注册留后续轮次在各自可写清单内做 |
| `saveHandoffDescriptor` / `peekHandoffDescriptor` / `consumeHandoffDescriptor` / `clearHandoffDescriptor` | 存取;consume **总是先删再判**(消费一次即清,坏载荷不滞留),新鲜度窗口默认 15min(`DEFAULT_HANDOFF_MAX_AGE_MS`,防陈旧残留劫持导航);storage 可注入(纯函数测试用),异常全静默 |

#### 2.2 修改 `src/features/workbench/core/legacyNavigationMap.ts`

- 抽出共享派发核心 `dispatchLegacyViewNavigation(typeId, resourceId)`:chat →
  chat-v2 + `requestChatSessionNavigation`;资源类 → learning-hub + openResource;
  视图类 → 对应 view。`translateLegacyNavigation` 重写为基于该核心,**行为逐分支
  保持一致**(chat 的 activate 附加动作、noop 提示、未知 typeId warn 原样)。
- 新增 `handoffWorkbenchToLegacyShell(): WorkbenchHandoffDescriptor | null`:
  采集焦点窗 descriptor → 命中经典壳映射才交接 → **先落盘 descriptor 再派发导航**
  (不只改 CurrentView);OS 专属应用(browser/flashcards/pomodoro)→ null,
  不落盘也不弹「仅桌面端可用」(壳切换非点击,提示是噪音);无焦点窗 → null,
  经典壳保持原 currentView。storage 落盘失败不阻塞资源级导航(降级仍对齐视图)。

### 3. 契约与不变量自证(静态)

- **不合桶**:未触碰 `finderStore.ts` 及任何分桶调用点(本卡 diff 仅上述两文件)。
- **快照纯净性**:descriptor 走独立 key,`snapshot.ts` / `pickShellFields` 零触碰。
- **禁改区**:App.tsx、AgentBridge、移动 chrome、44px 零触碰;无新 i18n 键
  (handoff 路径刻意无用户可见文案)。
- **依赖方向**:core→apps/content 的 `resourceWorkspaceRegistry` 引用沿用
  workbenchBus 先例;不 import React、不 import App。
- 现状证据(anchor-workbench §4「仓内无此结构」)自本卡起失效:descriptor 已有实现。

### 4. 纯函数测试要点(移交测试书写员,本轮未写文件未执行)

1. parse/serialize 往返:合法信封往返相等;version≠1 / appType 含 `/` / savedAt=0 → null;innerRoute 含 `\u0000` → 字段省略、整体保留。
2. consume 一次即清:注入 fake storage,consume 后 `getItem` 为 null;陈旧(savedAt 超窗)→ 返回 null 且已删;`maxAgeMs: Infinity` 关闭陈旧判定。
3. collect:焦点栈顶窗 typeId/instanceKey;essay 焦点 + `setResourceWorkspaceActive('essay','res_x')` → resourceId='res_x';空桌面 → null。
4. handoff:焦点 note 窗 → 落盘 + `NAVIGATE_TO_VIEW learning-hub openResource=/id`;焦点 browser 窗 → null 且 storage 无写入;`translateLegacyNavigation` 既有分支回归断言不变。

### 5. 未验证声明

- 未编译未跑测试(全程静态);`handoffWorkbenchToLegacyShell` 本轮**无调用方**
  (接线点在 App.tsx 停用路径,handoff-2 辖区),运行时行为未经执行验证。
- innerRoute 提供者注册表为空,descriptor 现阶段实际只含 appType+resourceId;
  tab/page 供给待应用侧接线。

## 下半:handoff-2(App.tsx 消费 + 反向)——本卡实况

> handoff-2 任务卡口径(用户原文):经典壳→Workbench 复用 workbenchBus 打开同一
> 资源、消费 handoff descriptor;触发条件为 workbenchMode false→true;移动平台
> 不启 Workbench。**本卡独占可写仅 `src/App.tsx`**,骨架第 6 节设想的
> 「停用事务 ok 后调用 handoffWorkbenchToLegacyShell」接线点在
> workbenchMode.ts / 设置页辖区(非本卡可写),如实记账为未接线。

### 6. 消费侧实况(App.tsx,workbenchActive false→true)

- **接线位置**:`App.tsx` App 组件内新增单一 effect(紧随
  `currentChatHeaderSubscribedSessionIdRef` 声明之后,因兜底需读取
  `currentView` / `currentChatHeaderSessionId`,受 TDZ 约束不能前置到
  workbenchMode 声明区)。`prevWorkbenchActiveRef` 检测 **false→true 跳变**:
  仅会话内切换触发;冷启动直进桌面不消费(交给快照恢复链路),effect 因
  currentView / 会话 id 变化的重跑被 prevRef 短路,不重复交接。
- **消费时机与 WORKBENCH_MODE_CHANGED 的关系**:事件路径
  `persistWorkbenchModeEnabled` 在派发 mode-changed 前已 `setEnabled(true)`;
  冷启动纠偏路径(localStorage 预读 false → 设置库 true)由 AgentBridge 的
  layoutEffect 在同一次提交先行 `setEnabled(true)`——本被动 effect 晚于两者,
  launch 不会误入 legacy 降级导航。断点/窄窗路径自第 2 轮起不再换壳,与本
  effect 无交互。
- **消费语义**:`consumeHandoffDescriptor()`(模块内先删再判 + 15min 新鲜度),
  优先级:descriptor > currentView 兜底。descriptor 命中时按
  `{ typeId: appType, instanceKey: resourceId ?? undefined }` 交
  `workbenchBus.launch`;`resourceId === null` 退化为「同一应用」交接。
  `innerRoute` 按前缀尽力恢复:`page:<n>` + PDF 类 typeId
  (`PDF_PAGE_ACTIVATION_TYPE_IDS`,textbook/file/file-preview)改道本轮
  Agent 结合-1 新增的 `workbenchBus.openPdfPage`(fallbackLaunch 打开同一
  资源 + gotoPage ack/超时/stale 防双跳,页跳失败仅降级为资源级交接);
  未识别前缀以瞬态 payload `{ innerRoute }` 透传(不进快照),应用侧自行
  消费,消费不了则自然忽略。
- **注册时序护栏**:应用注册在 WorkbenchDesktop chunk 内(registerAll 模块
  求值即注册);经典壳启动(localStorage 预读 false)时该 chunk 未预热,直接
  launch 会让 note/mindmap 因 notes 工作区未注册落错 bus 分支、single 去重与
  defaultFrame 拿不到定义——effect 先 `await import('…/apps/registerAll')`
  再发,等待期间若模式又被关掉(`workbenchBus.isEnabled()` 复查)则放弃交接。
- **与快照恢复的优先级**:先行 launch 的窗口不会被快照覆盖——WorkbenchDesktop
  挂载 hydrate 带 `preserveExisting: true`(且自动恢复默认关闭)。
- **未接线(如实记账,移交后续轮/对应辖区)**:① Workbench→经典壳方向的
  `handoffWorkbenchToLegacyShell()` 调用点(应在停用事务 ok 后、卸壳前,
  归 workbenchMode.ts / WorkbenchSettingsSection 辖区)本轮仍无调用方;
  ② 经典壳挂载时的 innerRoute 应用(骨架第 6 节前半设想)刻意**不做**:
  consume 一次即清,若经典壳侧也消费,同一 descriptor 无法再支撑「切回
  Workbench 恢复同一资源」的 round-trip;资源级导航已由
  handoffWorkbenchToLegacyShell 派发 NAVIGATE_TO_VIEW 完成,经典壳侧
  innerRoute 应用若后续要做,需先裁决双消费方的优先序。

### 7. 反向:经典壳 → Workbench(本卡裁决与实现)

- **不写反向 descriptor**:workbenchMode 翻转瞬间经典壳仍挂载,
  `currentView` / `currentChatHeaderSessionId` 可同步读取,无需持久化中转;
  descriptor 通道留给跨卸载场景(Workbench→经典壳→切回)。
- **currentView 兜底映射**(descriptor 缺失/过期时):模块级
  `WORKBENCH_APP_BY_CLASSIC_VIEW`(App.tsx),为 legacyNavigationMap(禁改)
  VIEW_BY_TYPE_ID 的反向子集:learning-hub→files、settings/todo 同名、
  skills-management→skills、template-management→templates、
  task-dashboard→taskDashboard、sandbox-workbench→sandbox。
  chat-v2 单独处理:**仅在有活跃会话时**交接(避免凭空新建会话窗),经
  `openChatSession(sessionId, 'api')` 走既有入口(聚焦 Chat 单例 +
  navigate-to-session 导航握手 + registerChatApp);descriptor 命中
  appType='chat' 且带 resourceId 时同样改道该入口。pdf-reader /
  template-json-preview 等上下文视图的资源状态不在 App 层,不进兜底表,
  其精确交接依赖 descriptor 主通道。
- **移动护栏**:effect 观察 `workbenchActive`(已含 isMobilePlatform 永真
  拦截,移动端恒 false 永不触发),函数体内再显式 `isMobilePlatform()` 护栏
  一次;不在移动平台启 Workbench,也不会让 launch 在 bus 未启用时误入
  legacy 降级导航。
- **验证口径**:静态读码 + grep(未编译未跑测试,第 8 轮前禁止);
  launch 时序、chunk 动态引入、openChatSession 握手均为静态推演。

### 8. 轮次收尾(台账员补)

- (填写:验收 grep、行号对表、遗留移交)
