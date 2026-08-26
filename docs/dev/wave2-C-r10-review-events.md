# 0824 Wave2-C R10 · 交叉终审「事件序」面

- 角色：第 10 轮交叉终审-事件序，模型 claude-fable-5-thinking-xhigh
- 取证：/workspace，枝 `cursor/0824-wave2-mobile-uiux-a875`，HEAD `fe8ff43c`
- 方法：静态逐行读码（对照 R2 设计 `docs/dev/wave2-C-r2/01/02/08/09`）+ 本轮实跑 8 个定向 vitest 文件（结果见文末）；未 computerUse、未 commit、未改任何产品代码
- 取证时点工作树含并发席位的未提交改动（`docs/dev/wave2-C-ledger.md` 追加节等），不计入本审

## 总结论：五项全部 PASS，零翻案，零产品改动

| # | 审项 | 结论 | 关键锚点 | 是否翻案 |
|---|---|---|---|---|
| 1 | InputBarUI pointerdown 走 bubble 非 capture | **PASS** | InputBarUI.tsx:1450 | 否（维持 R2-08 通过） |
| 2 | isWithinComposerTerritory：三 ref + isOwnedOverlayTarget + closest fail-open | **PASS**（带既登记风险） | InputBarUI.tsx:1089-1098 | 否（维持 R6 接线结论与 R9 高-1 风险登记） |
| 3 | AppMenu 动作只在 click 执行 | **PASS** | AppMenu.tsx:672-676 | 否（维持 R2-08 通过） |
| 4 | owned-overlay 登记链路 | **PASS**（过渡形态，与 R6 自述一致） | InputBarUI.tsx:1074-1080；AppMenu.tsx:369-378 | 否（维持 R6 对 R2-08 观察项 R4 的翻案成立） |
| 5 | Android back 菜单→面板 | **PASS**（本轮实跑绿） | androidBackCoordinator.ts:164；InputBarUI.tsx:1462-1470；AppMenu.tsx:137-148 | 否（维持 R2 静态结论；R8 两条假红系探针问题，R9 已修，本轮复跑确认） |

---

## 1. pointerdown bubble（红线项）——PASS

- `InputBarUI.tsx:1450` `document.addEventListener('pointerdown', handleClickOutside)`，第三参缺省 = bubble；卸载配对 `:1453` 同签名移除。**未改 capture，红线保持。**
- 挂载窗口 = `hasAnyPanelOpen`（:1041 定义，:1431 门控），与 R2-01 设计一致。
- handler 体（:1433-1441）只做谓词豁免 + `closeAllPanels()`，无其他副作用；Esc 通道（:1444-1447）仍跳过 `defaultPrevented`（被菜单先消费的 Escape 不连带关面板），与 R2-01 §事件序逐条吻合。
- AppMenu 内无任何 pointerdown 拦截（全文件 grep：stopPropagation 仅在 click :604 与 Tab keydown :552），即便未来出现，bubble 监听收不到事件的失败方向是「不关」而非「误关」——R2-08 要点 1 的安全性论证在当前 HEAD 仍成立。
- 面板容器 `:2598` 的 `onMouseDown={(e) => e.stopPropagation()}` 是 mousedown 通道（防的是 AppMenu 的 document mousedown 外点判定），不影响 pointerdown 链，R2-09 §4 的「勿误删」提醒项完好。
- source 契约锁定：`InputBarUI.appMenuOutsideClick.pointer.test.tsx:268-272` 精确锁 `document.addEventListener('pointerdown', handleClickOutside)` 字面量，本轮实跑绿。

## 2. isWithinComposerTerritory 谓词——PASS（带既登记风险，不翻案）

`InputBarUI.tsx:1089-1098`，五段判定与 R2 设计（R2-01 §改动 1 + R6-01 §改动 3）逐字对上：

1. `inputContainerRef.current?.contains(node)`（:1092，ref 声明 :324）
2. `panelContainerRef.current?.contains(node)`（:1093，ref 声明 :1064）
3. `composerPanelOverlayRef.current?.contains(node)`（:1094，ref 声明 :1065）
4. `isOwnedOverlayTarget(COMPOSER_OVERLAY_OWNER_ID, node)`（:1095，常量 :110 = `'input-bar-composer'`）
5. `node instanceof Element && node.closest(COMPOSER_OWNED_OVERLAY_SELECTOR)`（:1096，常量 :116 = `'[data-app-menu-id]'`）——**fail-open 回退保留**

- 三 ref 顺序与内容和 R2 基线一致，未被后续轮次（R3 触控、R8 散点收敛）误动。
- 共用性成立：外点关闭 `:1436` 与焦点门控 `:1111` 消费同一谓词，无第二套判定分叉（R2-01 的核心目标）。
- `useCallback` 依赖 `[isOwnedOverlayTarget]`（:1098）：三 ref 恒稳、`isOwnedOverlayTarget` 在 Provider 内是 `useCallback([])`（OverlayCoordinator.tsx:81-84）、fallback 是模块常量（:47），无重建抖动。
- fail-open 语义正确：无 Provider 时 `isOwnedOverlayTarget` 恒 false（OverlayCoordinator.tsx:40-49 fail-empty），第 4 条件恒假、第 5 条件按旧行为兜底——删 closest 会在无 Provider 树退回 P1 误杀，保留是对的。生产树两处挂载点均有 Provider（main.tsx:370/:384），第 4 条件实际生效。
- **既登记风险不翻案**：登记 selector 与 closest 回退同为不限定 menuId 的 `[data-app-menu-id]`，两轨判定范围一致（谓词注释 :1086-1087 自述诚实）——「面板开 + 任意无关 AppMenu 内 pointerdown → 面板不关」的过宽豁免仍在。该风险 R2-08 R1 首登、R9 风险清单高-1 复登并给出收窄前置条件（约 60 个 AppMenu 消费点带 `overlayOwnerId` + 28 处外点监听迁移完），方向是误保护（面板滞留一拍）非误杀（动作丢失），本轮维持「登记不改」。
- 边缘核对：pointerdown 的 target 若为 Text 节点，第 5 条件的 `instanceof Element` 门会漏（closest 不跑），但第 1-3 条件的 `contains` 收 Text、第 4 条件内部做了 Text→parentElement 归一化（overlayOwnership.ts:80-84）；且真实浏览器 UI 事件 target 恒为 Element，无生产路径命中。非缺陷。

## 3. AppMenu 动作只在 click 执行——PASS

- `AppMenuItem`：唯一动作出口是 `onClick`（AppMenu.tsx:672-676，`onClick?.(event)` 后 `ctx?.setOpen(false)`），无 onPointerDown/onPointerUp/onMouseDown 动作通道（全文件 grep 核实）。
- 同族出口全部 click 相位：`AppMenuTrigger` 开合 :191-204/:246、`AppMenuSubTrigger` :875、checkbox/radio 项 :1164/:1192/:1237、`AppSelect` option :1316。
- mousedown 相位只有菜单自身外点关闭（:150-166），且用 menuId 限定 `closest('[data-app-menu-id]="${menuId}"')`（:155）——比 InputBarUI 的泛化 selector 更严，是 R2-09 认定的「唯一正确样板」，未劣化。
- 三方时序推演（同 R2-08 要点 1 场景 A/B/C，当前行号复核）：点菜单项 pointerdown（bubble）→ 谓词第 4/5 条件豁免、面板不关 → mousedown 时 AppMenu 自查 target 在内容内（:157）不关菜单 → click 到达 :672 动作执行。真外点则 pointerdown 先关面板，面板内 AppMenu 随卸载在 effect cleanup 同步移除 mousedown 监听（:162-165），无陈旧监听。行为链由 `InputBarUI.appMenuOutsideClick.pointer.test.tsx` 三个动作用例（资源库 CHAT_TOGGLE_PANEL / 拍照 camera input click / 全部清除 onClearAttachments）+ 反向 sanity（真外点必关）锁定，本轮实跑 7/7 绿。

## 4. owned-overlay 登记——PASS（过渡形态，与设计自述一致）

三层链路逐层核对：

- **纯函数层** `overlayOwnership.ts`：登记幂等注销（:49-73，Set + released 标志）、element `===`/`contains` 与 selector `closest` 双形态匹配（:86-94）、target 归一化（:80-84）、空表 fail-empty（:106-109）。与 R2-02 API 规格逐项一致。
- **协调器层** `OverlayCoordinator.tsx`：登记表在 `useRef`（:57），三个归属回调全 `useCallback([])`（:76-89），登记/查询零 setState——tooltip 计数语义（:63-74、:93）与 R2-08 要点 4 审定时一字未动；无 Provider fallback fail-empty 显式钉死（:40-49）。
- **消费层两条通道**：
  - InputBarUI（R6 接线，路线 B 过渡形态）：面板开启期 `registerOwnedOverlay({ ownerId: 'input-bar-composer', selector: '[data-app-menu-id]' })`（:1074-1080），登记窗口与外点监听窗口同为 `hasAnyPanelOpen`，注销走 effect cleanup（幂等）。窗口外（面板刚关的同一轮事件）由 closest 回退兜住——注释 :1085-1087 自述与实现相符。
  - AppMenu（路线 A 精确通道）：`overlayOwnerId` prop / `AppMenuOverlayOwnerContext`（:39-65、:89、:104），提供时在 `shouldRender` 期登记 `element: contentRef.current` + 实例限定 `selector: '[data-app-menu-id]="${menuId}"'`（:369-378）；effect 挂 `shouldRender` 而非 `isOpen` 的时序论证（portal 首开 commit 后 ref 才就绪，:360-366 注释）核实成立；子菜单 SubContent 复用根 menuId 属性（:1066），实例 selector 连飞出层一起覆盖。**默认 null 不登记**（:102 注释），60 消费点零破坏。
- **现状定性**：精确通道（路线 A）当前零生产消费方——`overlayOwnerId` / `AppMenuOverlayOwnerProvider` 全库仅 AppMenu 本体与文档引用（grep 核实），实际流量全在 InputBarUI 的泛化 selector 登记上。这与 R6-01 自述（「命中路径与 closest 回退判定等价，收益是知识收敛非行为变更」）和 R2-02 的「路线 B 只作过渡」定位一致，属计划内过渡形态而非实现缺陷。**R2-08 观察项 R4（零生产消费方）已由 R6 翻案关闭，本轮确认翻案成立**：InputBarUI 是真实生产消费方，Provider 已挂生产树。
- 契约锁定：`OverlayCoordinator.ownership.source.test.ts`（tooltip API 原样 / 单一 Provider / ref 登记零 setState / fail-empty / 匹配委托纯函数层）5/5 绿；`overlayOwnership.test.ts` 8/8 绿。

## 5. Android back 菜单→面板——PASS（本轮实跑确认）

- **排序底座**：`androidBackCoordinator.ts:164` `(b.priority - a.priority) || (b.seq - a.seq)`（同档 LIFO），`seq: seqCounter++`（:65），与 R2-08 要点 5 审定版本一致；`BACK_PRIORITY.overlay` 注释块（:34-42）明确「同档共存靠注册时序，禁 overlay±N 魔法值」，AppMenu 与 Composer 面板双注册方均遵守。
- **注册时序**：面板开 → InputBarUI 注册（:1462-1470，effect 依赖 `[isMobile, hasAnyPanelOpen]`，`closeAllPanels` 走 ref :1460-1461 避免重注册抖动）→ 菜单开 → AppMenu 注册（:137-148，seq 更大居栈顶）。第一次 back 关菜单、第二次关面板、第三次交还 native。
- **让行守卫互不干扰**：InputBarUI 的 `hasOpenRadixOverlayBesides(null)`（:1466）只匹配 `OPEN_OVERLAY_SELECTOR`（androidBackCoordinator.ts:115-121）；AppMenu 内容层 `role="menu"` 无 `data-state`、不在 `[data-radix-popper-content-wrapper]` 下（AppMenu.tsx:564-592 渲染属性核实），不命中——菜单叠面板主链不受让行影响，且 LIFO 下菜单 handler 先执行，面板守卫根本轮不到。R2-08 的这条论证在当前 HEAD 复核成立。
- **AppMenu 离屏让行**：`el.closest('[inert]') || el.offsetParent === null → return false`（:144），判定挂触发器容器（内容层 portal 反映不了宿主隐藏态，:140-142 注释论证成立）——保活离屏视图里的菜单不吞活跃页的 back。
- **运行证据**：`InputBarUI.androidBack.sequence.test.tsx` 三连 back 全序列（含 handler 注销后不再吞事件）2/2 绿——R8 首跑时该文件 2 条红为探针用 DOM 存在性对上 220ms 退场动画的假红（R9 风险清单中-2），R9 改探针看 `data-panel-motion` 后本轮复跑绿，**产品链路自始未坏，不构成翻案**；`androidBackCoordinator.menuThenPanel/order.source/fullScenes` 29 条全绿。
- **既登记风险不翻案**：`hasOpenRadixOverlayBesides(null)` 对保活离屏视图残留 open dialog 的让行放大面（R2-08 风险 R2，中低）仍在原样，修法涉及探测函数可见性过滤（协调器语义变更），维持登记待真机。

---

## 新增观察（低危登记，不改产品）

**AppMenu back handler 的重注册抖动面**：`AppMenu.tsx:137-148` effect 依赖 `[actualOpen, setOpen]`，而 `setOpen` 身份随 `onOpenChange` prop 变（:106-115）。消费方若传内联箭头函数，菜单打开期间每次父渲染都会注销+重注册，seq 递增使其始终回到栈顶。对本审的「菜单→面板」主链无害（面板 handler 不重注册，LIFO 仍先关菜单）；理论劣化场景是「菜单之上再叠同档浮层 + 菜单宿主此时重渲染」——重注册会把菜单顶回栈顶、back 先关下层菜单。需三条件同时命中且现网未找到实例（composer 内菜单开着时上方再叠自绘同档浮层的路径不存在），登记为低危观察，不满足「一行级明确错误」的改动门槛。

## 运行证据（本轮实跑，2026-08-26）

`CI=true npx vitest run <8 文件>`：**8 files / 78 tests 全绿**（appMenuOutsideClick.pointer 7、androidBack.sequence 2、overlayOwnership 8、OverlayCoordinator.ownership.source 5、menuThenPanel 6、order.source 9、fullScenes 14、overlayPointerSequence.matrix.source 27）。R8 台账登记的本面 3 条假红（#4/#5 探针、#6 契约锚点漂移）经 R9 修复后已全部消失。

## 翻案判定汇总

- 无新翻案。R2-08「通过（带风险登记）」的四条风险中：R1（closest 过宽）仍开放（R9 高-1 续登）、R2（让行放大面）仍开放、R3（visualViewport 钳位）不在本审面、R4（零消费方）已被 R6 翻案关闭且本轮确认关闭成立。
- R8 实跑红不构成对 R2/R6/R7 结论的翻案：全部为测试探针/锚点过期，产品事件序无回归，R9 修复后本轮复跑绿。

## 边界自检

- 产品代码零改动（本轮仅新增本文档）；未 commit（按指令）。
- 禁改区未触碰：coordinator.rs / tool_loop / anki 域全程只读；`androidBackCoordinator.ts` 仅读码引用。
- pointerdown 保持 bubble（红线复核见 §1）。
- 真机验证仍留白（键盘 inset / 厂商 WebView / back 实机序列），沿 R9 登记，不在本审口径内。
- 不标 Goal complete。
