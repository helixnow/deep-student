# 03 AppMenu 定位 visualViewport 感知（Wave2-C 第 2 轮）

基线 `98bbf3f1`，工作目录 `/tmp/0824-wave2-c-r2-appmenu`。未 commit。

## 改了什么

| 文件 | 性质 |
| --- | --- |
| `src/components/ui/app-menu/AppMenu.tsx` | 修改（独占文件，+25/-13） |
| `src/components/ui/visualViewport.ts` | 新增纯工具（任务允许的可选新增） |
| `src/components/ui/app-menu/AppMenu.visualViewport.source.test.ts` | 新增 source 契约测试（按约束只写不跑） |

### AppMenu.tsx（两处定位逻辑，同一治法）

1. **`AppMenuContent` 主菜单定位**（原 :325-394 的 `updatePosition` + 监听挂载）
   - 边界钳位里所有 `window.innerWidth` / `window.innerHeight` 换成 `getVisualViewportSize()`（`visualViewport.width/height ?? window.inner*`）。覆盖 context 模式的 `fitsBelow` 判定、dropdown 模式的上下翻转判定、以及最终的 left/top 统一钳位。
   - 挂载处补 `visualViewport` 的 `resize`/`scroll` 监听（`passive: true`），cleanup 配对解除。
   - **保留** window `resize`/`scroll` 监听；顺手升级为 passive（`resize` 加 `{ passive: true }`，`scroll` 从 `true` 改 `{ capture: true, passive: true }`，capture 语义不变，`removeEventListener('scroll', fn, true)` 仍能正确解除）。
2. **`AppMenuSubContent` 子菜单定位**（原 :872-917）：同款替换 + 同款监听。子菜单和主菜单共享同一套 fixed 定位/钳位逻辑，只治主菜单会留下"主菜单避开键盘、飞出的子菜单仍被遮"的割裂。

### visualViewport.ts（新工具，不动 ComposerPanelOverlay）

- `getVisualViewportSize()`：`visualViewport.width/height`，缺失回退 `innerWidth/innerHeight`（与 ComposerPanelOverlay :78-79 同款回退链）。
- `addVisualViewportChangeListener(handler)`：挂 `resize`/`scroll`（passive），返回清理函数；环境不支持时返回 no-op。
- ComposerPanelOverlay 未改（对照只读），它以后可自行迁移到该工具，非本轮范围。

## 没改什么（保守性承诺）

- 打开/关闭状态机、`setOpen` 路径、关闭动画 timer：未动。
- 菜单项 click 执行时机（onClick 后立即 `setOpen(false)`）：未动。
- portal 目标（`[data-overlay-container]` 兜底 `document.body`）：未动。
- Android back 注册（:102-113，`BACK_PRIORITY.overlay` + inert/offsetParent 离屏让行）：未动、未调优先级，审读中未发现 bug。
- `useLayoutEffect` 依赖数组：未动（`updatePosition` 仍是 effect 内闭包，新监听只是多一个触发源）。
- 键盘导航、搜索框、Sub 互斥协调、OverlayCoordinator/OverlayLayer 接入：未动。

## 桌面波及说明（通报 B）

**预期：桌面无 visualViewport 变化时与现在等价。** 逐项论证：

1. **尺寸取值**：桌面 `visualViewport.height === innerHeight`（无软键盘）；未捏合缩放时 `scale = 1`，宽度也一致。唯一理论差异是**经典（占位式）滚动条**：`visualViewport.width` 不含滚动条宽度而 `innerWidth` 含。本应用跑在 Tauri WebView（macOS/WebKit 与 Windows/WebView2 均为 overlay 滚动条，且应用根节点自管滚动、document 级不出滚动条），两值相等。即便某环境出现占位滚动条,效果只是菜单右缘钳位提前 ~15px——不会盖住滚动条，属更正确的边界。ComposerPanelOverlay 已用同一取值跑了一轮，无桌面回归报告。
2. **新增监听**：桌面 `visualViewport` 的 resize/scroll 只在窗口缩放/捏合缩放时触发，此时 window resize 本来也会触发同一个 `updatePosition`；`updatePosition` 幂等（`setPosition` 有 prev 比较短路，无变化不 re-render）。多一个触发源不产生新状态。
3. **passive 升级**：原 handler 从不 `preventDefault`，passive 只是声明式优化，无行为差异。
4. **60 个消费点**：本次只动 `AppMenuContent`/`AppMenuSubContent` 内部的定位 effect,组件 props、导出、DOM 结构、类名、z-index 逻辑零变化，消费点无需任何适配。

**移动端收益**：软键盘弹出时 `visualViewport` resize 触发重定位，菜单钳位到缩小后的可视高度内，不再被键盘遮挡；键盘收起同理恢复。带搜索框的菜单（`showSearch`，聚焦即弹键盘）直接受益。

## 验证状态

- 按约束未跑 npm/vite/vitest/tsc；改动经静态审读（无 lint 层面新问题：新增 import 均被使用，事件挂载/解除配对，依赖数组未变）。
- `AppMenu.visualViewport.source.test.ts` 固化契约：读 visualViewport 尺寸、两处订阅/清理配对、window 兜底监听保留、portal/back/click 时机未动。CI 恢复后随 vitest 全量跑即可。
