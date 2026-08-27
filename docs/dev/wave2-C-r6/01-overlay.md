# 0824 Wave2-C R6 复核报告 · 01 owned-overlay 生产接线

- 复核员：第 6 轮复核员-浮层（claude-fable-5-thinking-high）
- 基线：`b35038a8`（worktree `/tmp/0824-wave2-c-r6-ovl`，detached）
- 独占文件：`src/features/chat/components/input-bar/InputBarUI.tsx`
- 产出补丁：`/tmp/0824-wave2-c-r6/01-overlay.patch`（+35 / -3，仅独占文件）
- 按指令未执行测试/编译，未 git commit。

## 翻案结论

成立。基线上 owned-overlay 体系（`overlayOwnership.ts` 纯函数层 +
`OverlayCoordinator.tsx` 的 `registerOwnedOverlay` / `isOwnedOverlayTarget`）
确为**零生产接线**：全库仅测试文件（`OverlayCoordinator.ownership.source.test.ts`、
`overlayOwnership.test.ts`）引用归属 API，唯一预期消费方 InputBarUI 仍在用
硬编码 `closest('[data-app-menu-id]')`（该短期修法正是 `overlayOwnership.ts`
头注释里点名要收敛的散落写法）。本轮补上生产接线。

## 改动内容（3 处，均在 InputBarUI.tsx）

1. **模块常量**：`COMPOSER_OVERLAY_OWNER_ID = 'input-bar-composer'`、
   `COMPOSER_OWNED_OVERLAY_SELECTOR = '[data-app-menu-id]'`，登记与查询共用，
   避免字符串漂移。
2. **登记 effect**：`hasAnyPanelOpen === true` 期间
   `registerOwnedOverlay({ ownerId: 'input-bar-composer', selector: '[data-app-menu-id]' })`，
   面板全关 / 卸载时由返回的注销函数（幂等）清理。登记窗口 =
   任一 Composer 面板（附件/模型/技能/MCP/对话控制）打开期间，与外点关闭
   监听的挂载窗口一致。
3. **谓词第四条件**：`isWithinComposerTerritory` 在三条 ref 判定之后新增
   `isOwnedOverlayTarget('input-bar-composer', node)`，末位**保留**原
   `node.closest('[data-app-menu-id]')` 作 fail-open 回退；`useCallback` 依赖
   补 `isOwnedOverlayTarget`（Provider 内 `useCallback([])`、fallback 为模块
   常量，引用恒稳，不引入重建抖动）。

### selector vs 更精确的 element —— 选型说明

选 selector 而非 element ref：Composer 内是**多个** AppMenu 实例（加号菜单、
运行时模型菜单等），`data-app-menu-id` 值为各实例动态 `menuId`，且子菜单
portal（`data-app-menu-sub-content`）另挂 body、复用根 `menuId` 属性。拿不到
统一的单一 portal 根 ref；泛化属性 selector 与原 closest 判定范围**逐字一致**，
不扩大也不缩小领地，行为等价可回归。

### 无 Provider 语义（写清）

`OverlayCoordinator.tsx` fallback：`registerOwnedOverlay` 为 noop、
`isOwnedOverlayTarget` 恒 `false`。故无 Provider 时第四条件恒假、登记不生效，
末位 closest 兜底使行为与接线前**完全一致**（fail-open）。生产树
`main.tsx` 的 `appTree` 与 RecoveryShell 均已挂 `OverlayCoordinatorProvider`，
接线即时生效。closest 回退同时兜住「登记窗口外」的边缘时序（面板刚关闭
后的同一轮事件）。

## 红线自查

| 红线 | 状态 |
| --- | --- |
| pointerdown 仍须 bubble | 未触碰监听器：仍 `document.addEventListener('pointerdown', handleClickOutside)`，无 capture 参数 |
| 发送/流式 | 零改动（diff 不含相关行） |
| isWithinComposerTerritory 三 ref | `inputContainerRef` / `panelContainerRef` / `composerPanelOverlayRef` 三条 `contains` 原样保留、顺序不变 |
| 独占范围 | diff 仅 `InputBarUI.tsx` 一个文件 |

## 风险与遗留

- `isOwnedOverlayTarget` 命中路径与 closest 回退当前判定等价，接线的收益是
  归属知识收敛到 coordinator（后续 back 分发 / 其他 owner 可复用），非行为变更。
- 遗留（超出本轮独占范围，不动）：`AppMenu.tsx` 自身外点判断、其他面板消费方
  仍各自硬编码 closest，可在后续轮次逐个迁移到 `isOwnedOverlayTarget`。
- 未跑 tsc/vitest（按指令禁止）；改动仅新增 hook 解构、一个 effect、一个布尔
  或条件，类型均来自已导出的 `OverlayCoordinatorValue`，静态风险低。
