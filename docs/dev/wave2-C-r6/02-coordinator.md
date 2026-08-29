# 0824 Wave2-C 第 6 轮 — coordinator（AppMenu 浮层归属登记）

- 角色：复核员-coordinator（claude-fable-5-thinking-high）
- 基线：`b35038a8`（fix: close mobile chrome gaps and tighten i18n guards）
- 独占文件：`src/components/ui/app-menu/AppMenu.tsx`（本轮唯一改动文件）
- 补丁：`/tmp/0824-wave2-c-r6/02-coordinator.patch`（+57 / -2，纯加法）
- 未 git commit；未执行测试（按约束）。

## 任务

AppMenu 打开时若 props/context 提供了 `overlayOwnerId`，则调用
`registerOwnedOverlay({ ownerId, element: contentRef })` 向 OverlayCoordinator
登记浮层归属。`overlayOwnerId` 为可选 prop，默认不登记（60 个既有消费点零破坏）。

## 实现

### 1. 供给通道：prop + context 双通道（prop 优先）

- `AppMenuProps` 新增可选 `overlayOwnerId?: string`。
- 新增导出 `AppMenuOverlayOwnerProvider`（namespace 别名 `OverlayOwnerProvider`）
  与内部 `AppMenuOverlayOwnerContext`（默认 `null`）。面板（owner）包一层
  Provider 即可让其中所有 AppMenu 自动登记，无需逐调用点传 prop。
- 根组件解析：`overlayOwnerId ?? contextOverlayOwnerId`，结果注入
  `AppMenuContextValue.overlayOwnerId`（内部 context，新增字段只此文件构造）。

### 2. 登记时机：effect 放在 `AppMenuContent`，挂在 `shouldRender` 上

这是本轮最关键的复核点。任务字面是"AppMenu 打开时登记"，但**不能**把
effect 挂在根组件的 `actualOpen` 上：

- `AppMenuContent` 的 portal 内容由其内部 `shouldRender` 状态驱动，首开时
  `shouldRender` 经一次 effect 才置 true，portal 在**下一次 commit** 才挂载。
- 根组件挂 `actualOpen` 的 effect 在第一次 commit 后即执行，此时
  `contentRef.current === null`；而 `registerOwnedOverlayEntry` 对
  `{ element: null }`（且无 selector）按无效登记返回 noop —— 首开永远登记不上。

因此登记 effect 放在 `AppMenuContent`，依赖 `shouldRender`：portal 内容与
`shouldRender=true` 同一次 commit 挂载，effect 于 commit 后执行，
`contentRef.current` 必已就绪。副产品：`shouldRender` 覆盖关闭动画期
（~150ms），动画中的菜单仍可见，点击其内仍判归属 —— 语义正确。
cleanup 即注销（幂等，由 `registerOwnedOverlayEntry` 返回函数保证）。

### 3. selector 兜底：覆盖子菜单飞出层

登记同时带 `selector: '[data-app-menu-id="<menuId>"]'`（`OwnedOverlaySpec`
原生支持 element + selector 并存，单次登记）。原因：`AppMenuSubContent`
各自 `createPortal` 到 `document.body`，**不在**主菜单 `contentRef` 元素之内；
只登记 element 时，点在子菜单飞出层里会被 owner 面板误判为外点而关面板。
子菜单根节点带 `data-app-menu-id={rootMenuCtx.menuId}`，selector 恰好覆盖。
这是对任务字面 spec 的最小增强，不改变任何既有查询语义（只让"确属菜单
DOM"的 target 返回 true）。

## 约束核对

| 约束 | 结果 |
| --- | --- |
| 只改 AppMenu.tsx | ✅ `git diff --stat` 仅此一文件 |
| 不改定位 / visualViewport / click 时机 | ✅ 未触碰 `updatePosition`、`addVisualViewportChangeListener`、任何事件 handler 与 timer |
| 只加法 | ✅ 无删除行为；仅新增 prop / context / effect / 导出；`AppMenuContextValue` 新字段仅本文件构造 |
| 60 消费点零破坏 | ✅ prop 缺省 + context 默认 null ⇒ `resolvedOverlayOwnerId === null` ⇒ effect 直接 return，不触发任何登记；无 OverlayCoordinator Provider 时 `registerOwnedOverlay` 本身也是 noop（fail-empty） |
| 禁止执行测试 | ✅ 未运行任何测试 |
| 不 git commit | ✅ 工作区保留改动，补丁已导出 |

## 验证（非测试）

- `tsc --noEmit`：仅 3 个既有错误（`@/version` 生成文件缺失，`AboutTab.tsx` /
  `useAppUpdater.ts` / `main.tsx`，基线即存在），AppMenu.tsx 零错误。
- `eslint AppMenu.tsx`：10 条警告，与基线（stash 后复跑）数量一致，全部既有
  （裸 addEventListener、原生 button、根组件外点 effect 的 `menuId` 缺依赖），
  本次新增 effect 依赖数组完整，无新增警告。

## 遗留 / 给下轮的备注

- 尚无消费点实际传 `overlayOwnerId`；接线（如 InputBarUI composer 面板包
  `AppMenuOverlayOwnerProvider` + 外点处用 `isOwnedOverlayTarget`）属后续轮次。
- 根组件自身的外点关闭仍走既有 `data-app-menu-id` closest 判断，与归属登记
  彼此独立、互不影响（登记只服务 owner 面板侧的查询）。
