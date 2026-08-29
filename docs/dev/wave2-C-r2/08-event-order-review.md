# 0824 Wave2-C R2 · 08 审阅员-事件序（capture/bubble/passive 与卸载时序）

- 角色：第 2 轮「审阅员-事件序」，模型 claude-fable-5-thinking-high
- 基线：`98bbf3f1`；审阅对象：本轮卡 1–6 已汇入工作区的全部 diff 与新测试
- 方法：全静态逐行审阅（`git diff 98bbf3f1 -- <files>` + 交叉读产品源码验证测试假设），未执行任何测试/构建，未 commit

## 总结论：**通过（带风险登记）**

- 事件序主链（pointerdown → mousedown → click、back 栈语义、监听配对卸载）全部核实无高危问题。
- 无「必须翻案」项。
- 发现 **2 处新测试的源码契约与最终合并代码不一致（跑起来必红的假红）**，属跨卡集成缝隙而非产品 bug；已按授权在测试文件（非 InputBarUI.tsx / 非 AppMenu.tsx）内做最小修复（各 ≤15 行），见文末「本轮改动」。
- 另登记 4 条低/中风险，均不建议本轮改产品代码。

---

## 要点 1：pointerdown 时序（bubble？误关？click 能否到达？）——✅ 通过

**pointerdown 仍在 bubble，未改 capture。** `InputBarUI.tsx:1413` `document.addEventListener('pointerdown', handleClickOutside)`（第三参缺省 = bubble），与基线一致；卡 1 只改了豁免判定，没动挂载阶段。

**document 级三方时序核对**（同一次 tap 的原生派发顺序 pointerdown → mousedown → click）：

1. `InputBarUI.tsx:1396-1404` 外点关闭 —— **pointerdown**（bubble）
2. `AppMenu.tsx:118-126` 菜单自身外点关闭 —— **mousedown**（bubble），且用 menuId 限定 `closest('[data-app-menu-id]="${menuId}"')`（`AppMenu.tsx:121`）
3. 菜单项动作 —— **click**（`AppMenu.tsx:605`、`AppMenu.tsx:806`）

**场景 A：点击菜单项（卡 1 修复的目标场景）。** pointerdown target 命中 `closest('[data-app-menu-id]')` → `isWithinComposerTerritory` 返回 true（`InputBarUI.tsx:1059`）→ 面板不关；mousedown 时 AppMenu 自查 target 在自己内容内 → 菜单不关；click 到达菜单项 handler。**菜单项 click 能到达，无误关。** 基线上 pointerdown 即 `closeAllPanels()`，click 前面板已拆，这正是本轮修复点。

**场景 B：点击真正外部。** InputBarUI 的 pointerdown 先关面板（React 在 pointerdown 派发完成后、mousedown 派发前同步 flush）；附件面板内的 AppMenu 随面板卸载，其 mousedown 监听在 effect cleanup 中同步移除（`AppMenu.tsx:128-131`）——不存在陈旧监听访问已拆 DOM 的问题。副作用仅为菜单跳过关闭动画（随面板整体消失），可接受。

**场景 C：菜单开着时点击面板/输入壳内部。** pointerdown 在领地内不关面板；mousedown 时 AppMenu 判定为菜单外 → 只关菜单。顺序正确（先关上层菜单、面板保留）。

stopPropagation 排查：AppMenu 内的 `stopPropagation` 全部在 click/keydown（`AppMenu.tsx:457-488、537、816-821` 等），无 pointerdown 拦截；即便未来有人拦截 pointerdown，document bubble 监听收不到事件的后果是「不关」而非「误关」，失败方向安全。

## 要点 2：`closest('[data-app-menu-id]')` 过宽——⚠️ 风险登记（本轮不改）

`InputBarUI.tsx:1059` 的豁免不带 menuId，匹配**全库任意 AppMenu**（所有 `AppMenuContent`/`AppMenuSubContent` 均带该属性，`AppMenu.tsx:503、989`）。后果：composer 面板开着时，在任意无关的 AppMenu（消息右键菜单、侧栏菜单等）内 pointerdown，面板不会关。对照 AppMenu 自身外点判定是 menuId 限定的（`AppMenu.tsx:121`），InputBarUI 这里明显更宽。

- 严重度：低。需要「面板 + 无关菜单同时开」才触发，且该无关菜单自己的 mousedown 外点关闭仍正常工作，用户面上只是面板多留了一拍。
- 处置：**只登记不改**（卡 1 独占 InputBarUI）。后续收敛路径已备好：卡 2 的 `registerOwnedOverlay`（`overlayOwnership.ts:49`，支持按 element ref 或 menuId 限定 selector 登记）正是为替换这句硬编码 closest 设计的，本轮尚无生产消费方（见要点 4）。
- 附注：焦点门控共用同一谓词，但基线的焦点门控本来就是不限定 menuId 的 closest（M3 修复），此处无回归。

## 要点 3：visualViewport 监听配对 / passive / capture——✅ 通过

主菜单（`AppMenu.tsx:390-402`）与子菜单（`AppMenu.tsx:917-928`）两处定位 effect 逐项核对：

| 挂载 | 卸载 | 配对判定 |
|---|---|---|
| `resize`, `{ passive: true }`（:392/:919） | `removeEventListener('resize', updatePosition)`（:399/:925） | ✅ capture 两侧均 false（passive 不参与移除匹配） |
| `scroll`, `{ capture: true, passive: true }`（:393/:920） | `removeEventListener('scroll', updatePosition, true)`（:400/:926） | ✅ capture 两侧一致 |
| `addVisualViewportChangeListener(updatePosition)`（:396/:921） | `removeVisualViewportListener()`（:401/:927） | ✅ util 内部 add/remove 同 handler 同 target（`visualViewport.ts:40-45`） |
| `requestAnimationFrame`（:391/:918） | `cancelAnimationFrame`（:398/:924） | ✅ |

passive 语义正确：`updatePosition` 纯读布局 + setState，永不 preventDefault，scroll passive 是正确优化；resize 上的 passive 无意义但无害。scroll 用 capture 是为捕获内层滚动容器（非 window 冒泡目标），与基线一致。util 侧 `visualViewport.ts:37-46` 无 vv 时返回 no-op、调用方保留 window 兜底，降级路径清晰。

低风险登记（不改）：钳位只用 `visualViewport.width/height`，未计 `offsetTop/offsetLeft`——键盘弹出触发浏览器平移可视视口（focused input scroll-into-view）或捏合缩放时，client 坐标系钳位到 `[8, vv.height-8]` 会有偏差。**参照实现 ComposerPanelOverlay 同样只用 width/height**（`ComposerPanelOverlay.tsx:78-79`），本轮与参照一致，非回归；如未来真机反馈菜单被键盘顶偏，再统一补 offset。

## 要点 4：OverlayCoordinator 加法是否破坏 tooltip 语义——✅ 通过

- `registerInteractiveOverlay` 的计数/抑制逻辑一字未动（diff 中该段全为 context 行）；`tooltipsSuppressed: activeInteractiveOverlayCount > 0` 保持。
- 新增三个 API 全部 ref-backed（`OverlayCoordinator.tsx:57` `useRef(createOwnedOverlayStore())`），登记/注销/查询零 setState、零 re-render；三个新回调均为 `[]` 依赖 useCallback，context value 的 memo 身份仍只随原有两个 state 变化——**消费 tooltip 字段的组件渲染频率不变**。
- 无 Provider 回退：tooltip 侧字段原样保留，归属侧 fail-empty（恒 false / 空表 / noop），语义在源码注释与 `OverlayCoordinator.ownership.source.test.ts:47-53` 双重钉死。
- 观察项（非风险）：`registerOwnedOverlay` 本轮**零生产消费方**（全库仅 overlayOwnership.ts / OverlayCoordinator.tsx / 测试引用），InputBarUI 仍硬编码 closest。属计划内的「先落基建、下轮接线」，与要点 2 的收敛路径对应；提醒下轮务必接线，避免长期双轨。

## 要点 5：back 注释是否改了排序算法——✅ 通过（必须没有，确实没有）

`androidBackCoordinator.ts` 的 diff **仅为 `BACK_PRIORITY.overlay` 上方 +11 行注释**（:31-42「同档共存登记」）。排序表达式 `(b.priority - a.priority) || (b.seq - a.seq)`（:127）、`seq: seqCounter++`（:65）、Radix 兜底探测插入位（:139、:153）、`OPEN_OVERLAY_SELECTOR`（:78-84）逐一与基线比对，均未动。注释内容与实现相符（同档 LIFO、禁 overlay±N 魔法值）。

关联核对——InputBarUI 新增的让行守卫 `hasOpenRadixOverlayBesides(null)`（`InputBarUI.tsx:1429`，卡 4 范围内的合法改动，Settings 同款模式 `Settings.tsx:589`）：

- **不会误伤菜单叠面板主链**：AppMenu 内容层无 `data-state`、不在 `[data-radix-popper-content-wrapper]` 下，不命中 `OPEN_OVERLAY_SELECTOR`；且 LIFO 下菜单 handler 先执行，面板 handler 的守卫根本轮不到。
- **修正了真实错序**：面板上叠 Radix Select/Dialog（未注册 handler）时，基线是面板先被关、浮层残留；现在面板让行 → 循环后兜底 Escape 先关最上层浮层。方向正确。
- ⚠️ 中低风险登记（不改）：`null` 排除意味着**全 DOM 任意** `data-state="open"` 的 Radix dialog 都触发让行，包括保活离屏视图里残留打开的 dialog（MobileSlidingLayout 三屏常驻 DOM 仅 inert 化，`MobileSlidingLayout.tsx:803-810`）。届时一次 back 会先隐形关掉看不见的 dialog、面板要多按一次；极端情况（dialog 吞 Escape 即 onEscapeKeyDown preventDefault）下 `dismissTopOverlayViaEscape` 仍按选择器命中即返回 true（:102-116），back 被消费但无可见效果。两者均为兜底探测的既有弱点被守卫放大暴露，未找到现存的具体触发实例；登记待真机验证，不在本轮以 ≤15 行强修（正确修法涉及探测函数的可见性过滤，属协调器语义变更）。

## 要点 6：测试是否只断言「按钮存在」——✅ 否，断言质量合格（但有 2 处假红契约，已修）

逐文件核：

- `InputBarUI.appMenuOutsideClick.pointer.test.tsx`：主断言是**行为链**——pointerdown 落在真实 portal 菜单项后 `onSetPanelState('attachment', false)` 不得被调（:141-143），且 click 必须到达终点动作（CHAT_TOGGLE_PANEL 事件 :180、隐藏 camera input 的 click :211、`onClearAttachments` :235）；另有反向 sanity（真外点必须关面板 :150-158）防监听未挂载的假绿。测试依赖的 hook 全部核实存在：`attachment-panel-more`（`AttachmentPanelBody.tsx:159`）、`data-composer-panel-inline`（`ComposerInlinePanel.tsx:58`）、菜单项顺序资源库→拍照→全部清除（`AttachmentPanelBody.tsx:165-190`）、`app-menu-item-destructive`（`AppMenu.tsx:600`）、camera input `capture` 属性（`InputBarUI.tsx:2574`）、`isMobileEnv = useMediaQuery('(pointer: coarse)')`（`InputBarUI.tsx:808`）与 mock 对齐。
- `InputBarUI.androidBack.sequence.test.tsx`：真实组件三连 back 全序列断言（关菜单→面板仍开→关面板→交还 native），并断言菜单 handler 注销后不再吞事件。offsetParent stub 有注释论证且 afterAll 恢复；AppMenu 根容器 div 恒渲染（`AppMenu.tsx:136`），harness 里 containerRef 非空成立。
- `androidBackCoordinator.menuThenPanel.test.ts` / `.order.source.test.ts`：栈语义用真 handler 驱动协调器断言（LIFO、让行续传、注销防陈旧、档位压注册序），source 契约锁「跨三文件隐式约定」，写法与理由成立。
- `overlayOwnership.test.ts`：行为测试覆盖 element/selector 两形态、Text target 归一化、ownerId 隔离、幂等注销、空登记。
- `AppMenu.visualViewport.source.test.ts`：纯 source 契约无行为断言——已给出 jsdom 无真实 visualViewport 的理由，可接受；其中「清理配对」断言（remove 计数 = add 计数）与要点 3 的人工核对一致。

**发现并修复的 2 处假红**（跨卡集成缝隙，测试写作时针对的实现形态与最终合并态不符，一旦执行必失败）：

1. `InputBarUI.appMenuOutsideClick.pointer.test.tsx:270-278`（修复前行号）：契约要求 `closest('[data-app-menu-id]')` 出现在 `handleClickOutside` 函数体正则捕获段内；但卡 1 最终把判定抽成了 `isWithinComposerTerritory` 谓词（`InputBarUI.tsx:1053-1061`），handler 体内（:1396-1404）已无 closest 字样 → `toMatch` 必红。修复：契约改为两段锁——handler 必须调用 `isWithinComposerTerritory(e.target as Node)`，谓词体内必须保留 closest 豁免。保护强度不降（且额外锁住了「共用谓词」这一结构）。
2. `androidBackCoordinator.menuThenPanel.test.ts:185-187`（修复前行号）：`toContain` 精确匹配旧 import 串 `import { registerBackHandler, BACK_PRIORITY } from ...`；卡 4 在同一 import 里追加了 `hasOpenRadixOverlayBesides`（`InputBarUI.tsx:52`）→ 必红。修复：改为成员可扩展的正则（与同目录 `order.source.test.ts:70-72` 既有写法同构）。

两处新正则均已用 ripgrep 对当前源码静态验证匹配（各恰 1 处命中）。

---

## 风险登记汇总

| # | 位置 | 风险 | 严重度 | 处置 |
|---|---|---|---|---|
| R1 | `InputBarUI.tsx:1059` | 外点豁免 `closest('[data-app-menu-id]')` 不限定 menuId，任意无关 AppMenu 内点击都不关面板 | 低 | 登记；下轮用卡 2 `registerOwnedOverlay` 按 owner 限定收敛 |
| R2 | `InputBarUI.tsx:1429` | `hasOpenRadixOverlayBesides(null)` 对保活离屏视图内残留 open dialog / 吞 Escape 的 dialog 让行，back 需多按一次或被空消费 | 中低 | 登记；待真机验证，修法涉及协调器探测可见性过滤，超 15 行授权 |
| R3 | `AppMenu.tsx:343 等` | 视口钳位未计 `visualViewport.offsetTop/Left`，键盘平移/捏合缩放场景有偏差 | 低 | 登记；与参照实现 ComposerPanelOverlay 一致，非回归 |
| R4 | `OverlayCoordinator.tsx` | `registerOwnedOverlay` 零生产消费方（基建先行） | 观察项 | 下轮接线，避免与硬编码 closest 长期双轨 |

## 本轮改动（仅测试文件，各 ≤15 行）

1. `src/features/chat/components/input-bar/__tests__/InputBarUI.appMenuOutsideClick.pointer.test.tsx`：source 契约改为「handler 走 isWithinComposerTerritory + 谓词内保留 closest 豁免」两段锁（修假红 #1）。
2. `src/app/navigation/__tests__/androidBackCoordinator.menuThenPanel.test.ts`：InputBarUI import 契约由精确串改为成员可扩展正则（修假红 #2）。

未触碰 `InputBarUI.tsx`、`AppMenu.tsx`、`OverlayCoordinator.tsx`、`androidBackCoordinator.ts` 及任何产品源码。未 commit（按要求）。
