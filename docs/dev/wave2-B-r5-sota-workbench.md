# Wave2-B 第 5 轮:SOTA-工作台(会话恢复 / 空间管理小增量)

- 角色:0824 Wave2-B r5「SOTA-工作台」;独占可写面 = workbench 会话恢复 / 空间管理小增量。
- 对照:`wave2-B-r1-workbench-gap.md` 可落地子集(§二 Arc Spaces 空间命名语义、§四-C 周边);台账 4.7 预排第 5 项。
- 口径:纯 TS/TSX/CSS/JSON/文档;未编译、未跑测试(第 8 轮前禁止);不 commit/push(父代理统一处置)。

---

## 一、选题裁决

任务卡给出两个候选:(A) snapshot 恢复后按 handoff 聚焦;(B) Spaces 最小命名桌面(若 persistedSettings 可扩展且不大)。

**本轮落地 B + 一个会话恢复侧微增量,A 不做。** 理由:

1. **A 与本轮并行的 handoff 代理硬耦合。** 工作树实况:`core/handoffDescriptor.ts`(handoff-1)已声明角色分工——经典壳侧 consume 归 handoff-2(App.tsx 独占),反向(经典壳→Workbench)复用 `workbenchBus.launch({ typeId, instanceKey })`,launch 本身把目标窗置顶聚焦;「恢复后按 handoff 聚焦」的消费端已在其独占面内闭环(见 `handoffDescriptor.ts` 头注「角色分工(r5)」段)。我方再做一份恢复端消费会撞独占文件(App.tsx / workbenchBus.ts / legacyNavigationMap.ts 本轮均归 handoff/agent 代理)且语义重复。
2. **B 完全自包含且切口最小。** `core/persistedSettings.ts` 正是任务卡点名的可扩展解析层(既有 wallpaper / tileMargins 两个纯函数解析器);设置键族 `desktop.workbench*` + `workbench:settings-changed` 热更新契约现成(DesktopContextMenu / WorkbenchDesktop / StatusBar 三方同款)。
3. **对标语义成立。** r1-workbench-gap §二-2:Arc 的 Space 是有名字的上下文容器;macOS 桌面空间同理。单桌面阶段先让唯一的学习桌面可命名、可持久化,是后续多 Space 的最小前置(键值天然演化为 per-space 字段),不引入任何新导航/生命周期协议。

## 二、产品落地清单

### 2.1 Spaces 最小命名桌面

| # | 改动 | 文件与证据 |
|---|---|---|
| 1 | **解析层**:`parsePersistedDesktopName(value): string \| null` + `DESKTOP_NAME_MAX_LENGTH = 24`。非字符串/清洗后为空 → null(展示方回退默认品牌名);控制字符(含换行)→ 空格、连续空白折叠、两端去空、按 Unicode 码点截断(`Array.from` 不劈代理对) | `src/features/workbench/core/persistedSettings.ts`(纯函数,与 wallpaper/tileMargins 解析器同族) |
| 2 | **存取层**:新模块 `desktopNameStore.ts`——设置键 `desktop.workbenchDesktopName`(独立键,**刻意不进 workbenchSnapshot**);zustand store + `useDesktopName()`(首次消费自动接线:`get_setting` 启动回放 + `workbench:settings-changed` 热更新,幂等);`persistDesktopName(raw)` 统一清洗后落盘(空值 = 落空串清除命名)+ 派发热更新事件(落盘失败仍派发,会话内先生效,与 `persistWorkbenchSetting` 同策略);非 Tauri 回退 localStorage(与 snapshot.ts/DesktopContextMenu 同款局部适配) | `src/features/workbench/components/desktopNameStore.ts`(新,范式对齐 `menuBarAutohideStore.ts`) |
| 3 | **展示 + 重命名入口**:品牌菜单(StatusBarBrandMenu)顶部新增菜单头——自定义名大字 + 默认品牌名小字(未命名只显默认名);「重命名桌面…」ActionItem 把菜单头切换为内联输入(Enter 提交并关菜单、Esc 取消回展示态、菜单关闭复位相位;输入框 onKeyDown 全键 stopPropagation,不进 StatusBarMenu 的 ↑↓/Home/End 漫游焦点与 Esc 关闭链);`maxLength` 给 2×码点上限的软闸,硬闸在解析层 | `src/features/workbench/components/StatusBarBrandMenu.tsx`;testid:`wb-menubar-brand-desktop-name` / `wb-menubar-brand-rename` / `wb-menubar-brand-rename-input` |
| 4 | **品牌钮 tooltip**:悬停提示从固定 `menubar.appName` 改为 `desktopName ?? 默认名`(aria-label 仍是 brandMenu,不动 a11y 契约) | `src/features/workbench/components/StatusBar.tsx`(3 行) |
| 5 | **样式**:`.wb-desk-menu-header(-name/-sub)` 菜单头、`.wb-desk-menu-rename(-input)` 内联输入,全部复用 `wb-desk-menu` 令牌族(`--wb-glass-border` / `--primary` / muted) | `src/features/workbench/components/DesktopContextMenu.css`(品牌菜单与右键菜单共用该文件,+50 行) |

### 2.2 会话恢复微增量:「恢复上次桌面」CTA 显示窗口数

- 空桌面冷启动的次级 CTA(第 2 轮遗产:关闭自动恢复且启动探测到快照时出现)原文案只有「恢复上次桌面」,用户无法预判恢复规模。
- `EmptyDesktop` 新可选 prop `restoreWindowCount`(缺省 0 → 旧文案,零破坏);>0 时文案带数量。总装侧 `WorkbenchDesktop` 传 `restorableSnapshot?.windows.length ?? 0`(1 行)。
- 不改恢复链路本身:hydrate/pruneSnapshotWindows/逐帧唤醒零触碰。

### 2.3 i18n(workbench ns,zh/en 键集合已比对相等)

| 键 | zh-CN | en-US |
|---|---|---|
| `menubar.desktopRename` | 重命名桌面… | Rename Desktop… |
| `menubar.desktopNameInputLabel` | 桌面名称 | Desktop name |
| `emptyDesktop.actionRestoreSessionCount_one/_other` | 恢复上次桌面({{count}} 个窗口) | Restore last desktop (1 window / {{count}} windows) |

复数后缀采用仓内既有惯例(todo.json 等 zh/en 同带 `_one`/`_other`,zh 两键同文);`menubar.appName`(默认名)与 `emptyDesktop.actionRestoreSession`(无计数兜底)为复用,不造重复键。

## 三、契约与禁改区自证(静态)

- **快照白名单零触碰**:桌面名走独立设置键,`snapshot.ts` / `snapshotWindowPolicy.ts` / `windowStore.ts` 本轮零 diff(`git diff` 核对);不往快照塞任何草稿/正文/元数据——快照纯净性 P0 四层防线原样。
- **scheduler 冻结契约、deactivationTransaction、ExposeOverlay 零 diff**(`git diff -- scheduler.ts deactivationTransaction.ts snapshot.ts ExposeOverlay.tsx` 输出 0 行)。
- **不新增事件协议**:热更新复用 `workbench:settings-changed` 既有 CustomEvent 契约;不改 workbenchBus / windowStore / 任何生命周期码。
- **finder 分桶、44px、anki/qbank、coordinator.rs**:未读未改。
- **与并行 r5 代理零文件重叠**:handoff(App.tsx / workbenchBus.ts / legacyNavigationMap.ts / AgentBridge.tsx / handoffDescriptor.ts)与 notes(apps/notes/**、generative-ui)改动簇与本轮 5+2 个文件互不相交(git status 逐一核对);`WorkbenchDesktop.tsx` 的 +1 行为本轮 restoreWindowCount 透传。
- **既有测试静态核对**:`StatusBar.test.tsx` 品牌菜单用例全走 testid(`wb-menubar-brand-apps/-settings/-exit` 均保留);`getByText('学习桌面')`(:124)在菜单关闭态断言,菜单头文本不参与;`EmptyDesktop.test.tsx` 未断言恢复 CTA 文案。预期零跑红(未执行,见 §五)。

## 四、测试文本(已写未跑)

- `core/__tests__/persistedSettings.desktopName.test.ts`(新):普通通过/两端去空、非字符串与空白 → null、控制字符清洗折叠、码点截断(含 emoji 代理对不劈)、恰好等长不截断。
- `components/__tests__/desktopNameStore.test.ts`(新):persist 清洗落盘 + store 即时更新、空输入清除回 null、settings-changed 热更新(好值/空串/坏值 fail-safe)、不相关键不影响。jsdom 非 Tauri 走 localStorage,与 `snapshot.test.ts` 同口径。

## 五、已验证 / 未验证

**已验证(静态 = grep + 逐行读码 + python json.load):** 禁改区零 diff;zh/en workbench.json 解析通过且叶子键集合相等;`autoFocus` 与 `no-control-regex` 内联豁免均为仓内既有用法;设置键读写/事件派发与三处既有实现逐行同构。

**未验证(如实声明):** 未编译未跑测试(两个新测试文件红绿未知、tsc 未跑);内联输入在 StatusBarMenu 弹层内的真实键盘/焦点行为(stopPropagation 阻断 document 级 Esc 监听为 React 委派机制静态推演);菜单头/输入框在 coarse pointer 与深浅主题下的视觉;`_one/_other` 复数解析未运行时确认(仓内同款先例佐证)。第 8 轮统一实测。

## 六、遗留与后续

1. 多 Space(多桌面集合、每空间独立窗口集)不在本轮:命名键演化为 per-space 字段时需配 space 索引结构,属大切口,留后续 wave 裁决。
2. 重命名入口目前只在品牌菜单;桌面右键菜单/设置页入口可按需追加(均可复用 `persistDesktopName`,零新协议)。
3. 「恢复后按 handoff 聚焦」的消费端确认由 r5 handoff-2(App.tsx 独占)闭环,本文档只记录分工,不重复实现。
4. 桌面名暂未参与 Agent observe 上下文;若 Agent 需要「用户在哪个空间」语义,`useDesktopNameStore.getState().name` 是现成只读源(零新 capability,留 Agent 结合轮裁决)。
