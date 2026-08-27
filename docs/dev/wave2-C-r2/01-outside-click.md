# 0824 Wave2-C R2 · 01 外点判定修复（AppMenu portal 误关面板）

## 问题

`InputBarUI.tsx` 里有两套「是否在 Composer 领地内」的判定，且不一致：

- **焦点门控**（原 :1058-1067）：三 ref contains + `closest('[data-app-menu-id]')` —— 认识 AppMenu portal。
- **document pointerdown 外点关闭**（原 :1390-1405）：只认三 ref contains —— 不认识 AppMenu portal。

AppMenu 是全库自研菜单（非 Radix popper），内容 portal 挂在 `body` 上并统一带
`data-app-menu-id` 属性（见 `AppMenu.tsx` :494-495、:975-977，其自身外点判定 :120
也用同一属性）。所以在组合面板内点开加号菜单/推理菜单后，菜单内的任何
pointerdown 对三 ref 而言都是「外部」，`closeAllPanels()` 被误触发，面板在菜单
交互过程中被关掉。

## 改动（只改 `src/features/chat/components/input-bar/InputBarUI.tsx`）

1. **新增统一谓词 `isWithinComposerTerritory`**（refs 声明后，现 :1049-1061）：
   `inputContainerRef / panelContainerRef / composerPanelOverlayRef` 三 ref 的
   `contains` + `node instanceof Element && node.closest('[data-app-menu-id]')`。
   `useCallback` 空依赖（ref 稳定）。
2. **焦点门控 `evaluate`**（现 :1072-1075）改为调用该谓词，语义与原实现完全一致
   （原有的四路判定逐字搬入谓词），effect 依赖数组补上谓词。
3. **`handleClickOutside`**（现 :1396-1404）改为
   `if (isWithinComposerTerritory(e.target as Node)) return;` —— 即验收要求的
   「target.closest('[data-app-menu-id]') 时 return，不 closeAllPanels」。
   effect 依赖数组补上谓词。
4. **back handler 顺手一行**（现 :1427-1429，Settings.tsx :589 同款模式）：
   `if (hasOpenRadixOverlayBesides(null)) return false;` —— 面板上方叠着真正的
   Radix 浮层（dialog/select 等）时让行，交给协调器的 Escape 兜底先关最上层浮层，
   维持「先关浮层再退页面」层级。新增对应 import。注意 AppMenu 不是 Radix
   浮层，不受此行影响（AppMenu 自己注册返回键处理）。

未动：发送/流式/附件 store、ComposerPanelOverlay 桌面语义、44px。没有给
ComposerPanelOverlay 打 `data-overlay-container`（其 overflow-hidden 会裁掉菜单，
认 `data-app-menu-id` 即可覆盖 portal 场景）。

## 事件序（维持不变）

- 仍用 **pointerdown**（同时覆盖鼠标与触摸，且早于合成 click），仍走 **bubble**
  默认注册。没有理由改 capture：AppMenu 内部若 `stopPropagation`，本 handler
  收不到事件反而更安全（不会误关）；收到时靠谓词豁免。改 capture 反而会让本
  handler 抢在 AppMenu 自身的外点/选中逻辑之前跑，引入新的顺序耦合。
- Esc 关闭逻辑未动（仍跳过 `defaultPrevented`，即被菜单先消费的 Escape 不会
  连带关面板）。

## 通报 B（桌面同样受益）

这个外点关闭 effect 不区分移动/桌面（只看 `hasAnyPanelOpen`），修复对桌面同样
生效：桌面上从组合面板（含 `composerPanelOverlayRef` 的 portal overlay）内打开
AppMenu 后，在菜单内点击不会再误关组合面板。back handler 那行有 `isMobile`
门控，仅移动端生效，桌面语义无变化。
