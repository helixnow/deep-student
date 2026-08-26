# 0824 Wave2-C R2 · 卡 2：OverlayCoordinator 浮层归属登记（owned overlay ownership）

基线 `98bbf3f1`，工作目录 `/tmp/0824-wave2-c-r2-coordinator`。未 commit（按要求）。

## 改动清单（全部在允许范围内）

| 文件 | 性质 |
| --- | --- |
| `src/components/shared/overlayOwnership.ts` | 新建。纯函数层：登记表数据结构 + 匹配/查询，零 React 依赖 |
| `src/components/shared/OverlayCoordinator.tsx` | 加法扩展。原 tooltip API 一行未动，叠加 3 个归属方法 |
| `src/components/shared/__tests__/overlayOwnership.test.ts` | 新建，只写未跑。纯函数单测（jsdom） |
| `src/components/shared/__tests__/OverlayCoordinator.ownership.source.test.ts` | 新建，只写未跑。源码契约测试 |

未触碰：`InputBarUI.tsx`（卡 1）、`AppMenu.tsx`（卡 3）、`ComposerPanelOverlay.tsx`、`coordinator.rs` / tool_loop。

## API

### 纯函数层（`overlayOwnership.ts`，无 React）

```ts
type OwnedOverlaySpec = { element?: Element | null; selector?: string };
type OwnedOverlayRegistration = OwnedOverlaySpec & { ownerId: string };
type OwnedOverlayStore = Map<string, Set<OwnedOverlaySpec>>;

createOwnedOverlayStore(): OwnedOverlayStore
registerOwnedOverlayEntry(store, registration): () => void   // 幂等注销
isEventInsideOwnedOverlay(store, ownerId, target): boolean
listOwnedOverlayOwnerIds(store): string[]
resolveEventTargetElement(target): Element | null            // Text → parentElement
```

匹配规则：`element` 走 `===` / `contains`（拿得到 portal 根 ref 时最精确）；`selector` 走 `target.closest(selector)`（浮层由子组件渲染、只能靠 data 属性识别时用）。两种形态可同时登记，一个 owner 可拥有多条浮层。`target` 归一化处理了 pointerdown 常见的 Text 节点 target；`null` / `window` 恒 false。

### React 层（`OverlayCoordinator.tsx`，叠加到现有 context value）

```ts
registerOwnedOverlay({ ownerId, element?, selector? }): () => void
isOwnedOverlayTarget(ownerId, target: EventTarget | null): boolean
listOwnedOverlayOwnerIds(): string[]
```

- **同一棵 Provider 树**：仍是唯一的 `OverlayCoordinatorContext` / `OverlayCoordinatorProvider`，`main.tsx` 两处挂载点不需要任何改动。
- **登记表放 `useRef`**：登记/注销/查询都发生在事件时刻，不触发 re-render，`value` 的 useMemo 依赖里只多了三个稳定 useCallback——不会因为面板开合浮层而让整棵树跟着 context 变化重渲染，也不会影响 `tooltipsSuppressed` 的计数语义。
- **无 Provider 时语义（fail-empty，已在源码注释和契约测试里钉死）**：`registerOwnedOverlay` 为 noop、`isOwnedOverlayTarget` 恒 `false`、`listOwnedOverlayOwnerIds` 恒 `[]`。即"查询不到任何归属"，绝不抛错；调用方必须保留自己原有的 `contains` / `closest` 兜底判断，等价于 fail-open 回落到旧行为。

## 为何不重写

1. **现有协调器已有三个消费方压在 tooltip 语义上**：`CommonTooltip`（读 `tooltipsSuppressed` / `tooltipDismissVersion`）、`AppMenu`、shad `Popover`、`ComposerPanelOverlay`（都调 `registerInteractiveOverlay`），还有既有行为测试（`CommonTooltip.behavior.test.tsx`、`Popover.overlayCoordinator.test.tsx`、`AppMenu.contextMode.test.tsx`）。重写等于同时动卡 1 / 卡 3 独占文件的依赖面，违反本轮分工。
2. **两个关注点天然正交**：tooltip 抑制是"有多少个交互浮层开着"（计数，需驱动渲染）；归属是"这个 DOM 事件属于谁"（查表，事件时刻的同步查询，不该驱动渲染）。加法叠加各走各的状态载体（useState vs useRef），互不污染。
3. **纯函数层单独成文件**是为了让匹配逻辑可以脱离 React 被测试和复用（比如未来 back 手势分发器不是组件），也让契约测试能钉住"coordinator 只做接线、不做匹配"。

## 与 P1 短期 `closest` 修法的关系

短期修法是消费方硬编码全局选择器，例如 `InputBarUI.tsx` 键盘 inset 处的
`active.closest('[data-app-menu-id]')`、`AppMenu.tsx` 外点判断的
`closest('[data-app-menu-id="${menuId}"]')`。问题在于：

- **知识散落**：每个外点/焦点处理都要各自知道"世界上有哪些 portal 属性"；新增一种 portal 浮层就要翻所有消费方补 `closest`。
- **归属不分**：`closest('[data-app-menu-id]')` 匹配的是*任何* AppMenu，不是"*我这个面板*拥有的那个 AppMenu"。两个面板并存时（composer 面板 + 侧栏菜单），A 面板的外点判断会被 B 的菜单误命中而不关闭。

本方案是它的长期化：owner 登记 → 查询按 `ownerId` 收敛。短期 `closest` 不必立即删除——`selector` 形态的登记就是把同一个选择器从消费方挪进登记表（如 `registerOwnedOverlay({ ownerId, selector: '[data-app-menu-id="menu-1"]' })`），迁移可以逐个消费方进行，且无 Provider 时 fail-empty 保证兜底 `closest` 继续生效，不存在中间态回归。

## 第 3+ 轮接线方案（InputBarUI / AppMenu）

**InputBarUI（卡 1 文件，本轮未动）** —— 在 `handleClickOutside`（约 1390 行）现有三个 `contains` 判断后追加一条：

```tsx
const { isOwnedOverlayTarget } = useOverlayCoordinator();
// handleClickOutside 内：
if (isOwnedOverlayTarget('input-bar-composer', e.target)) return; // 自己拥有的 portal 浮层，不算外点
```

同理可替换 1066 行键盘 inset 处的全局 `closest('[data-app-menu-id]')`（改为按 owner 查询，避免误命中别的面板的菜单）。Esc/back 分发也可用 `listOwnedOverlayOwnerIds()` 判断"最上层归属"再决定关哪层。

**AppMenu（卡 3 文件，本轮未动）** —— 两条路线任选：

- 路线 A（推荐，改动最小）：AppMenu 增加可选 prop `overlayOwnerId?: string`，内容 portal 挂载的 effect 里（现有 `registerInteractiveOverlay` 同位置，约 96 行）追加：

```tsx
React.useEffect(() => {
  if (!actualOpen || !overlayOwnerId || !contentRef.current) return;
  return registerOwnedOverlay({ ownerId: overlayOwnerId, element: contentRef.current });
}, [actualOpen, overlayOwnerId, registerOwnedOverlay]);
```

  InputBarUI 里的加号菜单/推理菜单把自己的 ownerId 传下去即可，element 引用比 selector 精确（连子菜单 portal 一起被 `contains` 覆盖，因为子菜单也带 `data-app-menu-id`，必要时子菜单 contentRef 同法登记）。
- 路线 B（面板不改子组件）：面板侧直接 `registerOwnedOverlay({ ownerId, selector: '[data-app-menu-id]' })`——零 AppMenu 改动，但精度同短期 `closest`，只建议作为过渡。

**ComposerPanelOverlay（B 卡语义，未动）**：它已有 `registerInteractiveOverlay`；如后续移动端需要，可同法叠加 `registerOwnedOverlay({ ownerId: 'input-bar-composer', element: overlayRoot })`，与桌面语义无关。

## 测试（只写未跑）

- `overlayOwnership.test.ts`：element/selector 两种匹配、Text 节点 target 归一化、ownerId 隔离、null/window target、注销幂等 + owner 桶清理、无效登记忽略、ownerId 列表去重、`resolveEventTargetElement` 边界。
- `OverlayCoordinator.ownership.source.test.ts`：钉住 (1) 原 tooltip API 与计数语义原样保留；(2) 单一 context/Provider，不另起树；(3) 登记走 ref、`registerOwnedOverlay` 代码块内不出现任何 setState；(4) fallback 的 fail-empty 语义（`() => false` / `() => []`）；(5) 匹配逻辑委托给零 React 依赖的纯函数层。
