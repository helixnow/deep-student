# Workbench 无障碍（a11y）落实清单 — O19 出品

- 版本：2026-07-08（本轮 20 代理打磨）；2026-08-24 增补 §13（触屏/焦点环/焦点陷阱补遗）
- 责任模型：**各组件代理尽量自行落实自己组件的条目；未落实项由 O20 兜底**（编排 §4）。
- 基建位置（O19 归属，已交付）：
  - `hooks/useWorkbenchA11y.ts` — `getWindowA11yProps` / `announceWorkbench` /
    `useWorkbenchAnnouncer` / `useRovingFocus` / `useFocusReturn` /
    `useHighContrast` / `usePrefersReducedMotion`
  - `hooks/useWorkbenchGestures.ts` — `lockWorkbenchCursor`（全局光标一致性）
  - `hooks/useDesktopDrop.ts` — 拖放落点态（over/denied 已带 not-allowed 光标）
  - `styles/a11y-cursor.css` — `wb-focus-*` 焦点环 / `wb-cursor-*` 光标 /
    forced-colors 与 reduced-motion 适配（**需 O20 接线 import 一次**）

---

## 1. 总则（全组件适用）

| # | 规则 | 手段 |
|---|---|---|
| G1 | 所有指针操作必须有键盘等价路径 | 快捷键（O12）已覆盖平铺/切换/俯瞰；组件内浮层用 `useRovingFocus` |
| G2 | 键盘焦点必须可见且视觉统一 | 交互元素挂 `wb-focus-ring`（贴边元素用 `wb-focus-ring-inset`），禁止 `outline: none` 裸奔 |
| G3 | 纯视觉元素对 AT 隐藏 | 缩放手柄、吸附预览、指示点、壁纸、分隔符装饰一律 `aria-hidden` |
| G4 | 状态变化要能被屏幕阅读器感知 | 用 `announceWorkbench(msg)`（见 §8 公告事件表），禁止自造 aria-live 区 |
| G5 | 图标按钮必须有可读名 | `aria-label`（i18n），tooltip 不能替代 |
| G6 | 瞬态浮层关闭后焦点归还 | `useFocusReturn(open)`（切换器/俯瞰/菜单/弹层） |
| G7 | 高对比模式可辨识 | a11y-cursor.css 已做 forced-colors 映射；组件自查语义色是否被吞（`useHighContrast` 可做逻辑降级） |
| G8 | 尊重 reduced-motion | 动效跟随 O1 token 时长（minimal 档归零）；自定义 transition 补 `@media (prefers-reduced-motion: reduce)` |
| G9 | 光标形态统一 | 静态挂 `wb-cursor-*` 类；**拖拽会话期用 `lockWorkbenchCursor` 锁全局**，松手释放 |

## 2. 窗口壳（WindowShell — O2 文件，O20 落实）

- [ ] 根元素展开 `getWindowA11yProps({ title, appName, focused, minimized, roleDescription })`：
  - `role="dialog"`（非模态，不设 `aria-modal`）+ `aria-label="<标题> — <应用名>"`；
  - `aria-roledescription` 传 `t('workbench:a11y.windowRole')`（建议文案「窗口」）；
  - 最小化 → `aria-hidden`（属性生成器已处理）；
  - `tabIndex=-1`：聚焦窗口（focusWindow）时同步把 DOM 焦点带入壳元素，
    屏幕阅读器随之播报窗口名。
- [ ] `WindowResizeHandles` 已是 `aria-hidden`（保持）；缩放的键盘等价 = O12 平铺/居中快捷键，无需给手柄加焦点。
- [ ] 标题栏拖拽区：静止 `wb-cursor-grab`，会话中 `lockWorkbenchCursor('grabbing')`（O2 引擎接入，见 §7）。

## 3. 标题栏三键（WindowTitleBar — O3）

- [ ] 三键各自 `aria-label`：`workbench:a11y.close` / `a11y.minimize` / `a11y.zoom`
  （文案建议：关闭窗口 / 最小化窗口 / 缩放窗口）。
- [ ] 三键保留 workbench.css 既有 focus-visible box-shadow 环（**不要**再叠 `wb-focus-ring`，避免双环）。
- [ ] 缩放键悬停平铺菜单（TileMenuPopover）打开时焦点移入菜单，Esc 关闭并归还（`useFocusReturn`）。
- [ ] 双击标题栏最大化 → 公告 `a11y.zoomed`。

## 4. Dock（O5 / O6）

- [ ] Dock 条已有 `role="toolbar"` + roving tabindex（保持）；autohide 收起时 Dock 内元素不可 Tab 达（现有 pointer-events + 焦点守卫已处理，回归确认）。
- [ ] DockItem `aria-label` = 应用名；运行中补充状态：`aria-label="{name}（运行中，N 个窗口）"` 或 `aria-description`。
- [ ] 角标：`wb-dock-badge` 对 AT 隐藏，数量并入 item 的 `aria-label`（如「制卡任务，3 项进行中」）。
- [ ] 指示点 `aria-hidden`。
- [ ] 右键菜单（DockContextMenu）：`role="menu"` + `role="menuitem"`，↑/↓ 巡航（`useRovingFocus` orientation='vertical'）、Esc 关闭、`useFocusReturn`。
- [ ] 多实例弹层（DockWindowList）：`role="menu"` 或 listbox；打开时焦点入列，Esc 归还。
- [ ] 滚轮调放大档（若 O5 接 `useWheelStep`）：纯增强，不得成为唯一路径。

## 5. 俯瞰 / 切换器（O7 / O8）

- [ ] ExposeOverlay：容器 `role="dialog"` + `aria-label`（t: `a11y.expose`，建议「窗口俯瞰」）；
  每个窗口卡是 button，`aria-label` = 窗口标题；方向键网格导航；Esc 关闭；进出用 `useFocusReturn`。
- [ ] 打开时 `announceWorkbench(t('a11y.exposeOpened', { count }))`（「俯瞰已打开，N 个窗口」）。
- [ ] WindowSwitcher：容器 `role="listbox"` + `aria-activedescendant` 指向选中项（或每次步进
  `announceWorkbench(选中窗口标题)`——切换器生命周期短，公告方案更简单可靠）。

## 6. 桌面 / 平铺 / 拖放（O4 / O13 / O17）

- [ ] 平铺中缝（TilingDivider）：已有 `role="separator"`；补 `aria-label`（t: `a11y.tilingDivider`）、
  `aria-valuenow`（当前左侧百分比）、键盘 ←/→ 调比例（步长 2%）+ `aria-valuemin/max`；
  光标已是 col-resize，拖动会话建议 `lockWorkbenchCursor('col-resize')`。
- [ ] SnapPreview：`aria-hidden`（纯视觉）；落位完成公告见 §8。
- [ ] 桌面右键菜单（O13 DesktopContextMenu）：`role="menu"` 全套（同 §4 菜单规则）。
- [ ] 拖放（`useDesktopDrop` 消费方）：
  - drop 成功 → `announceWorkbench(t('a11y.dropOpened', { title }))`；
  - denied 态视觉已带 not-allowed 光标与虚线框；如需文案提示由消费方用 `onDragStateChange` 渲染；
  - 拖源（O17 files 列表）`draggable` 元素补 `aria-roledescription`（「可拖拽项」）
    并保证同操作有非拖拽路径（双击/回车打开）。

## 7. 光标形态规范（全局统一表）

| 交互 | 静止 | 会话中（lockWorkbenchCursor） |
|---|---|---|
| 标题栏拖拽区 | `wb-cursor-grab` | `grabbing` |
| 窗口缩放 n/s | 元素级 ns-resize（现状保持） | `ns-resize` |
| 窗口缩放 e/w | ew-resize | `ew-resize` |
| 窗口缩放对角 | nesw/nwse-resize | `nesw-resize` / `nwse-resize` |
| 平铺中缝 | col-resize | `col-resize` |
| Dock 项 / 按钮 | 默认（macOS 惯例不用 pointer，可保持 default） | — |
| 拖放 denied | `.wb-cursor-drop-denied` 自带 not-allowed | — |
| 禁用元素 | `wb-cursor-not-allowed` | — |

会话锁的意义：拖拽中指针常滑出手柄命中区，元素级 cursor 会闪回箭头；
`lockWorkbenchCursor` 写 `<html data-wb-cursor>`，a11y-cursor.css 全局生效，松手 `release()`。

## 8. 屏幕阅读器公告事件表（调 `announceWorkbench`）

| 事件 | 时机 | 建议 i18n key（namespace: workbench） | politeness |
|---|---|---|---|
| 窗口打开 | openWindow 后 | `a11y.windowOpened`（「已打开 {title}」） | polite |
| 窗口关闭 | closeWindow 后 | `a11y.windowClosed` | polite |
| 最小化 | minimizeWindow(true) | `a11y.windowMinimized` | polite |
| 平铺落位 | setDisplayMode(tiled-*) | `a11y.windowTiled`（「{title} 已平铺至左半屏」等） | polite |
| 最大化/还原 | setDisplayMode | `a11y.zoomed` / `a11y.restored` | polite |
| 切换器步进 | stepSwitcher | 直接播报窗口标题 | polite |
| 俯瞰开/关 | toggleExpose | `a11y.exposeOpened` / `a11y.exposeClosed` | polite |
| 拖放开窗 | useDesktopDrop onDrop | `a11y.dropOpened` | polite |
| 应用崩溃 | ErrorBoundary catch | `a11y.appCrashed` | **assertive** |

> 公告接线建议由 O20 集中放在 WorkbenchDesktop 层（订阅 store diff）或各交互 commit 点，
> 避免 store（O11 冻结逻辑）内散落 UI 副作用。

## 9. 焦点环落实点（挂 `wb-focus-ring` / `wb-focus-ring-inset`）

- [ ] Dock 项以外的所有自定义 button/菜单项/卡片（Dock 项与三键保留 workbench.css 既有 box-shadow 环，二选一不叠加）。
- [ ] TileMenuPopover 九宫格项、DockContextMenu/DesktopContextMenu 菜单项、
  Dock 弹层列表项、Expose 窗口卡、切换器项、空桌面引导按钮、DevPanel 控件。
- [ ] 需要跳转辅助的地方可用 `.wb-focus-sr-only.wb-focus-reveal` 做「跳到窗口 / 跳到 Dock」skip link（可选增强）。

## 10. 高对比与减动效

- [ ] forced-colors 下焦点环/拖放高亮已映射系统色（a11y-cursor.css §5），组件不要再用纯背景色差表达焦点。
- [ ] `useHighContrast()` 为 true 时：玻璃 sheen/高光不可作为唯一状态区分（如焦点窗 vs 非焦点窗需保留边框/标题色差）。
- [ ] 所有新增 transition/animation：跟 O1 token 时长（minimal 档归零）或补 reduced-motion 媒询；
  组件内 JS 驱动动画用 `usePrefersReducedMotion()` 短路。

## 11. 建议新增 i18n keys 汇总（O20 统一补齐 locale）

```
workbench:a11y.windowRole        窗口
workbench:a11y.close             关闭窗口
workbench:a11y.minimize          最小化窗口
workbench:a11y.zoom              缩放窗口
workbench:a11y.expose            窗口俯瞰
workbench:a11y.tilingDivider     平铺分割条
workbench:a11y.windowOpened      已打开 {{title}}
workbench:a11y.windowClosed      已关闭 {{title}}
workbench:a11y.windowMinimized   {{title}} 已最小化
workbench:a11y.windowTiled       {{title}} 已平铺至{{zone}}
workbench:a11y.zoomed            {{title}} 已最大化
workbench:a11y.restored          {{title}} 已恢复
workbench:a11y.exposeOpened      俯瞰已打开，共 {{count}} 个窗口
workbench:a11y.exposeClosed      俯瞰已关闭
workbench:a11y.dropOpened        已打开 {{title}}
workbench:a11y.appCrashed        {{name}} 出现错误，可重新加载
```

## 12. 验收走查（O20 执行）

1. **纯键盘走查**：Tab 进桌面 → Dock 巡航启动应用 → Ctrl+Tab 切换 → Ctrl+Alt+←
   平铺 → 中缝键盘调比例 → Ctrl+Alt+E 俯瞰方向键选择 → Esc 逐层退出，全程焦点可见、无失焦黑洞。
2. **NVDA smoke**（Windows）：开窗/平铺/最小化/崩溃各触发一次，确认公告播报且不重复轰炸。
3. **forced-colors**：Windows 高对比主题下检查焦点环、拖放高亮、焦点窗辨识度。
4. **reduced-motion**：系统开启后确认无残留动效（minimal 档 + 媒询双保险）。
5. `document.getElementById('wb-a11y-announcer')` 全程唯一且位于 body 尾部。

## 13. 2026-08-24 补遗（sota-subapp-polish 轮）

对照本清单与实现走查后落实的三处缺口：

1. **Dock tooltip 触屏等价（§4 增补）**
   - 未运行应用：长按（400ms，与窗口列表长按同判定）把 `wb-dock-tip` 钉住
     （`data-tip-pinned`，无 350ms 悬停延迟），松手驻留 1.6s 再消失；
     长按不触发 launch（复用 click 抑制标记）。
   - 运行中应用：长按被 DockWindowList 占用，应用名改由列表头部
     `.wb-docklist-header`（视觉可见、对 AT 隐藏——菜单 `aria-label` 已含应用名）提供。
   - 键盘/AT 路径不变：图标按钮 `aria-label` 始终携带应用名+运行态+角标。
2. **Exposé 键盘焦点环可见性（§5/§10 增补）**
   - 焦点环从写死的 `0 0 0 2px primary/0.65` 改为引用统一 token
     （`--wb-focus-ring-width/-color`，`prefers-contrast: more` 自动加粗），
     并加 1px 背景色衬边，任意窗口内容上都可辨。
   - forced-colors 下 box-shadow 被系统剥除 → 新增 `outline: 3px solid Highlight`
     映射（选中格、pick/close 按钮 focus-visible、玻璃标签补 Canvas/CanvasText）。
3. **主要对话框焦点陷阱（§G1/G6 缺口修补）**
   - `src/hooks/useFocusTrap.ts` 扩展：无可聚焦元素时焦点留容器；初始聚焦不抢
     容器内已有焦点（保住 autoFocus）；关闭/卸载归还焦点（原元素仍在文档、
     且当前焦点未被用户主动移走时）。可选项 `initialFocus` / `restoreFocus`。
   - 接线：`DsDialog` / `DsAlertDialog`（全应用通用模态，此前完全无焦点管理，
     关窗确认「保存并关闭」三态框等均经此修复）、`WallpaperManagerDialog`
     （此前 Tab 可穿透到桌面）、`WorkbenchSidebarLayout` 窄窗抽屉
     （已有初始聚焦/归还，仅补 Tab 循环）。
   - 已自带轻量陷阱的浮层（ShortcutCheatsheet / ExposeOverlay / StatusBar 弹层 /
     AppsPanel / StatusBarClock）维持现状，不重复接线。
