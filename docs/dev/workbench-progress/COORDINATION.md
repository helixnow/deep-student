# 协调日志（协调者维护，P11 必读）

## 产品纪律：刻意去除 / 勿加回（2026-07-09）

调研文档 `docs/research/macos-2026/06-overall-visual-language-and-gap-priority.md` §0 为权威清单。
实现代理对照真机差距时，下列项**禁止当「缺口」加回**：

- Dock 指示点呼吸（已静态点）
- 拖窗抬起/放下阴影档切换
- 开窗旧类叠播（`wb-anim-open` 等）
- 废纸篓 / Poof / Force Quit / Show in Finder
- 堆栈·最近区钉满 Dock、持续 Launch bounce 循环
- Genie 真 mesh / Spaces / Stage Manager / Aerial
- 把全部应用默认钉进 Dock

允许追：去整键 1.18 hover、薄玻璃、spring 曲线、Apps 面板、平铺热区/⌥、EmptyDesktop 克制。

## 菜单栏 / 学习状态条（2026-07-09）

规格：`docs/research/macos-2026/07-menubar-status-and-control-center.md`。

- **做**：透明顶栏字层 + 右侧学习状态项（番茄/闪卡 due/制卡任务/时钟）+ 轻量「学习中心」弹层。
- **不做**：假系统菜单、Wi‑Fi/电池、可编辑 32 格 CC、实心顶条、通知横幅轰炸、呼吸角标。
- 与短 Dock / Dock 角标**并存**，不钉满 Dock。

## 落地轮写权（2026-07-09 · 五代理并行 · Grok 4.5 Fast）

| 代理 | 范围 | 独占写权 | 禁碰 |
|------|------|----------|------|
| L1 Dock 手感 | 去整键 1.18 hover；bounce 幅度微调；autohide 去假 overshoot | `Dock.css`、`DockItem.tsx`、`workbench.css`（仅 dock hover/active 相关）、`workbench.tokens.css`（仅 `--wb-dock-item-hover-scale` / dock bounce 相关） | 指示点呼吸、持续 bounce 循环、Poof、废纸篓 |
| L2 Motion | spring `linear()`；简化 pop-in；RM 分层淡变 | `styles/motion.css`、`WindowLifecycle.css`（仅曲线/时长引用）、相关 motion 测试 | 恢复 `wb-anim-open` 叠播；改 Dock.css |
| L3 薄玻璃 | 降 blur/fill、edge/sheen、圆角分档 | `workbench.tokens.css`（玻璃/圆角/阴影时长；**勿改** `--wb-dock-item-hover-scale`）、各浮层 CSS 仅改引用 token 的数值消费若必需 | 真折射、Clear 图标管线、拖窗阴影抬起 |
| L4 Apps 面板 | Dock「应用」入口 + 搜索列表 | 新建 `AppsPanel.*`；`Dock.tsx` / `DockContextMenu` 接线；`registerAll` 仅注释；`WorkbenchDesktop` 仅挂载面板；`DesktopContextMenu` 增加打开 Apps | 钉满 DEFAULT_DOCK_PINNED；改 EmptyDesktop |
| L5 平铺+空桌面 | 吸附热区/⌥；EmptyDesktop 克制 | `snapZones*` / `pointerEngine*` / 平铺相关；`EmptyDesktop.tsx`+`.css`+测试 | Spaces/Stage Manager；AppsPanel 文件 |

冲突裁决：tokens 里 dock hover 归 L1，其余玻璃归 L3。Dock.tsx 归 L4（L1 只动 Dock.css/DockItem）。

## L2 完成（2026-07-09 · Motion · 父代理接手）

原 L2 子代理卡在启动未改文件，已 interrupt；由父代理落地。

### 文件

| 文件 | 改动 |
|------|------|
| `styles/motion.css` | spring / spring-soft / overshoot → `@supports linear()` 采样；bezier 回退；pop-in/overshoot-in 关键帧单调；`--wb-motion-standard` 280ms、`--wb-motion-genie` 480ms；RM 保留 120–160ms 淡变并去 scale；minimal 仍全 0ms |
| `WindowLifecycle.css` | opening/genie fallback 时长对齐新 token |
| `hooks/useWindowLifecycleAnim.ts` | FALLBACK_MS 对齐 standard 280 / genie 480 |
| `SnapPreview.tsx` | `TILE_SETTLE_DURATION_MS` 0 → 280（RM/minimal 仍瞬时） |

### 验收

- 无双重回弹关键帧；无持续 bounce；未恢复 `wb-anim-open`
- EmptyDesktop / AppsPanel / Dock vitest：**43 passed**

## L5 完成（2026-07-09 · 平铺热区 + EmptyDesktop 克制）

代理：L5。写权内已落地；未碰 AppsPanel / Dock.tsx / motion.css / Spaces / Stage Manager。

### 目标 A — 平铺吸附

- `snapZones.ts`：热区 **边 24 / 角 64 / 滞回 14**；`SnapHitOptions.altKey` + `SNAP_ALT_*_SCALE`（⌥ 扩热区）。
- `pointerEngine.ts`：`GesturePoint.alt` 从 `PointerEvent.altKey` 传入 `hitTestSnapZone`；`useWindowPointer` / `workbenchPointerAdapter` 注释标明消费路径。
- **未做上/下半屏拖拽热区**：`SnapZone` 仅有 `left|right|tl|tr|bl|br|top-maximize|null`，无 `top-half` / `bottom-half` 扩展点；改动面会牵涉 tiling / TileMenu / displayMode，超出 L5 热区常量范围。快捷键上/下半屏仍走既有路径。
- **未做** Spaces / Stage Manager / 真全屏 Space。

### 目标 B — EmptyDesktop 克制

- 去掉光晕/星点/三并列大卡 → **单主 CTA「打开资源库」** + 次要文字链（对话/待办）。
- 主 CTA 仍 `launch('files')`；父代理已在 L4 完成后把次要链「全部应用」接到 `openAppsPanel()`。
- 保持「知道了」消隐；整层基线 `pointer-events: none` 不挡桌面右键。
- 测试：`snapZones.test.ts`、`EmptyDesktop.test.tsx` 已更新。

## L1 完成（2026-07-09 · Dock 手感）

代理：L1 Dock 手感。写权内落地；未改 `Dock.tsx` / `motion.css` / 玻璃 blur·fill；未加回指示点呼吸 / 持续 bounce / Poof / 废纸篓 / 堆栈。

### 文件列表

| 文件 | 改动 |
|------|------|
| `workbench.tokens.css` | `--wb-dock-item-hover-scale: 1.18` → `1`（minimal / RM 仍为 1） |
| `workbench.css` | 契约仍消费该 token；注释标明默认无整键 hover 放大 |
| `Dock.css` | bounce 首跳 -16→-20px、次跳 -6→-8px、时长 760→780ms；autohide reveal 360ms overshoot → 300ms `--wb-ease-spring-soft` |
| `DockItem.tsx` | `BOUNCE_FALLBACK_MS` 900→920（对齐 780ms） |

### 验收

- 非 mag：hover 整键 scale=1（无 toolbar 式 1.18）；fisheye 邻近放大保留
- Launch bounce：仍为 `running` false→true **单次**两跳，略增高；非循环到就绪
- Autohide 滑入：~300ms spring-soft，无假 overshoot
- `npx vitest run` Dock.test + DockPinnedStore → **2 files, 33 tests passed**
- 全仓 `tsc --noEmit`：仅见 `pointerEngine.ts`（L5 写权）缺 `GesturePoint.alt`，与本代理改动无关；L1 名下文件无自引错误

## L3 完成（2026-07-09 · 薄玻璃 / tokens）

代理：L3。写权：`workbench.tokens.css`（玻璃/圆角/阴影时长；**未改** `--wb-dock-item-hover-scale`）；菜单/cheat/HUD 仅把硬编码圆角/blur 接到 token。未做真折射、Clear 图标、拖窗阴影抬起。

### 改前 → 改后关键 token

| Token | 改前 | 改后 |
|-------|------|------|
| `--wb-glass-bg` | `card / 0.58` | `card / 0.20` |
| `--wb-glass-bg-strong` | `card / 0.72` | `card / 0.28` |
| `--wb-glass-blur` | `blur(32px) saturate(1.8)` | `blur(18px) saturate(1.8) brightness(1.08)` |
| `--wb-glass-blur-strong` | `blur(42px) saturate(1.85)` | `blur(24px) saturate(1.85) brightness(1.08)` |
| `--wb-glass-highlight` | `rgba(255,255,255,0.72)` | `0.55` |
| `--wb-glass-sheen` 主斜向峰 | `0.18` | `0.22`（底缘/侧缘略抬） |
| `--wb-glass-edge` 底/侧 inset | `0.10 / 0.07` | `0.12 / 0.08` |
| `--wb-window-radius` | `12px`（统一） | `18px`（toolbar 默认） |
| `--wb-window-radius-compact` | （无） | `12px`（min 档） |
| `--wb-window-radius-toolbar` | （无） | `18px` |
| `--wb-menu-radius` | （无；菜单硬编码 12） | `14px` |
| `--wb-overlay-radius` | （无；cheat 硬编码 18） | `18px` |
| `--wb-shadow-transition-duration` | `40ms` | `140ms` |
| 暗色 `--wb-glass-bg` / strong | `0.50` / `0.64` | `0.32` / `0.42` |
| 暗色 blur | （继承亮色 32/42） | `18/24` + `brightness(0.92)` |
| 暗色 highlight | `0.18` | `0.22` |
| `full/reduced/minimal` | 保留 | **未改结构**；reduced/minimal 仍关 blur、抬实色 fill |

### 组件消费对齐（硬编码 → token）

| 文件 | 改动 |
|------|------|
| `DesktopContextMenu.css` | radius → `--wb-menu-radius`；blur → strong；`box-shadow` 加 `--wb-glass-edge` |
| `DockContextMenu.css` | 同上 |
| `ShortcutCheatsheet.css` | radius → `--wb-overlay-radius` |
| `WorkbenchDevPanel.css` | radius → `--wb-menu-radius` |
| `Dock.css` | 未改（tip 已用 `var(--wb-glass-blur)`，随 Regular 变薄） |

### 自验注意

- 契约类 `.wb-glass` / `.wb-dock` / `.wb-window` 自动吃新 token；窗默认圆角 18px。
- 未恢复拖窗抬起阴影；未碰 motion 曲线与 dock hover scale。

## 越界修改记录

1. `src/features/learning-hub/icons/ResourceIcons.tsx` 被某并行代理修改（+88/-54：
   React.memo 包装 + aria-hidden，无破坏性质量优化）。该文件不在任何归属清单内。
   当前 tsc 通过。P3 曾在其编辑中途撞见瞬时语法错误（已消失）。
   → P11：验收时确认该文件最终编译与渲染正常；若引发问题直接 `git checkout` 回滚该文件。

## 编码损坏事故（已由协调者修复，2026-07-08 20:40）

- `src/components/ModernSidebar.tsx`：HEAD（commit 23761329 "222"，20:25）中含 17 处
  GBK/UTF-8 编码损坏（中文字符串截断产生未闭合引号 → 59 个 tsc 语法错误）。
  协调者已按 locale 文件原文逐行还原（守卫校验后脚本化替换），当前以未提交改动存在，
  tsc 全仓 exit 0。commit "222" 落在子代理工作窗口内且信息不规范，来源待用户确认。
- `src/features/learning-hub/apps/views/NoteContentView.tsx`：工作区有一份含同类
  乱码注释与语法错误的未提交改动（Progress.css 引入 + SWR 刷新条相关重构，非任何
  代理归属），已 `git checkout` 回滚至 HEAD（HEAD 版本编译正常）。
- `src/features/learning-hub/icons/ResourceIcons.tsx` 的越界改动（见上）编译正常，保留。
- → P11：不要恢复上述被回滚的 NoteContentView 改动；如运行中再见到乱码字符
  （U+FFFD / 未闭合字符串），按 locale 原文修复并记录。

## 跨代理裁决事项汇总（P11 启动前持续补充）

- z-index 层级：P4 定值 snap=8500 / expose=8000 / dock=9000；P5 Dock 用了 `z-[1000]`；
  P1 hydrate 已做 zIndex 归一化（10 起紧凑序列）。→ P11 总装时让窗口层自成 stacking
  context 并统一各 overlay 层级。
- Dock autohide 动画需用 `translate(-50%, y)` 复合形式（P4 的 wb-dock 自带
  translateX(-50%) 居中）。
- 最小化"飞向 Dock"动画：P3 已挂 `wb-anim-minimize` 类，需 P11 注入
  `--wb-minimize-origin-x/y` Dock 方位变量。
- WindowShell 的 usePointer 注入口：P2 交付 useWindowPointer 后由 P11 做一行替换
  （P3 已内置可用默认实现兜底）。
- P5 Dock 组件刻意未从 workbench/index.ts 导出（防 legacy bundle 污染），
  P11 从 `./components/Dock` 相对导入。
- P1 snapshot 的触发订阅与启动恢复链路（loadSnapshot→hydrate→startScheduler）归 P11 装配；
  Dock 固定区 registerDockPinnedProvider 注入。
- P9：registerAll 需调 registerSystemApps()/registerSandboxApp()/registerContentApps 等；
  桌面挂载时 registerSystemProjections() + resyncProjections()；卸载 resetEventHub()；
  与 P7 对齐 chat instanceKey 格式。
- P7 遗留：sessionManager LRU >10 会话窗风险（预算限制实际 ≤6，暂可接受）；
  页面级事件宿主（AnkiPanelHost 等）需在桌面层挂一次。
- P6 硬性要求：P11 必须给 WindowShell 根元素加 `data-wb-window-id={win.id}`
  （ExposeOverlay 依赖它定位窗口 DOM）；桌面根部挂 useWorkbenchShortcuts +
  渲染 ExposeOverlay / WindowSwitcher 两个 overlay；expose backdrop z=5 < 窗口 z≥10
  的层序约定与 P4 的 8000/8500/9000 定值一并裁决。
- P6 假设窗口壳静止时以 left/top 定位（transform 仅拖拽瞬态）；P2/P3 若改常驻
  transform 需通知调整。

## 2026-07-09 收尾轮记录

### 启动背景

O 轮（极致打磨）中途中断：O6 / O7 / O9 / O20 未执行；O2 / O4 / O17 为半成品且由其他代理继续；
O3 / O5 / O8 / O10–O15 / O18 代码已落地但进度文档停在「进行中」、checklist 全空。
本轮由仓库卫生与文档收尾代理并行补完：**只做垃圾清理、.gitignore、进度文档回填**，
严禁 commit / checkout / reset / stash / restore，严禁改动 src/ 与 src-tauri/src/ 源代码。

### 垃圾清理清单

删除的未跟踪垃圾：

- src-tauri/NONE（约 8.5MB 误落 MSVC PDB）
- dev-server.err.log / dev-server.out.log
- tauri-dev.log / tauri-dev-desktop.log
- tc_agent3_r2.log

移出 git 索引（git rm --cached，工作区副本随后删除）的已跟踪检查输出：

- tsc-out.txt
- vitest-contract-out.txt
- o13-test-out.txt
- .tsc-baseline-mobile-audit.txt

.gitignore 末尾追加分节「Workbench polish local artifacts」：

- tsc-out.txt / vitest-contract-out.txt / o13-test-out.txt
- .tsc-baseline-*.txt
- dev-server*.log / tauri-dev*.log / tc_agent*.log
- src-tauri/NONE

### 文档回填范围

已回填（状态 + checklist 代码核实 + 四节）：O3、O5、O8、O10、O11、O12、O13、O14、O15、O18。

未触碰：O1 / O16 / O19（已完成且文档齐全）；O2 / O4 / O6 / O7 / O9 / O17（其他代理在写或未执行）。

回填结论摘要：

- 全勾（静态核实交付物存在）：O5、O8、O10、O11、O13、O14、O15、O18
- 部分完成：O3（WindowTitleBar.css 未接线到 TSX）、O12（ShortcutCheatsheet 未挂进 Desktop；o12-shortcut-cheatsheet.test.tsx 不存在，断言在 p6-shortcuts.test.ts）

## O20-接线A 记录（2026-07-09）

代理：O20-接线A。写权：`WorkbenchDesktop.tsx` / `SnapPreview.tsx` / `SnapPreview.css`（配套）/ 相关测试；未改冻结 `workbench.css`、他人组件与 `apps/**`。

### a11y-cursor 接线

- 在 `WorkbenchDesktop.tsx` 顶部于 `workbench.css` 之后增加：`import '../styles/a11y-cursor.css';`（O19 指定接线点）。
- 焦点环双环风险核对：`a11y-cursor.css` 全文无全局 `:focus-visible` 选择器；`wb-focus-ring` / `-inset` / `wb-focus-within-ring` 均为 opt-in 类。workbench.css 三键/Dock 既有 box-shadow 环不受影响。
- 引入后视觉生效：`:root[data-wb-cursor]` 全局光标锁、拖放 `wb-cursor-drop-*` 高亮、自愿挂载的焦点环类。

### z-index 替换清单（名下已改）

| 位置 | 原值 | 替换为 |
|---|---|---|
| `WorkbenchDesktop.tsx` TilingDivider 内联 | `5000` | `var(--wb-z-tiling-divider)` |
| `WorkbenchDesktop.tsx` 窗口层 | `10` | `var(--wb-z-window-layer)` |
| `SnapPreview.tsx` 内联（补齐，原主要在 CSS） | — | `var(--wb-z-snap-preview)` |
| `SnapPreview.css` `.wb-snap-preview.wb-snap-skin` | `8500` | `var(--wb-z-snap-preview)` |

文件头层序注释已改为引用 `--wb-z-*` 刻度名。

### workbench.css（冻结）一致性确认（未改）

| 选择器 | 定值 | 对应刻度 | 结论 |
|---|---|---|---|
| `.wb-dock` | `9000` | `--wb-z-dock: 9000` | 一致 |
| `.wb-snap-preview` | `8500` | `--wb-z-snap-preview: 8500` | 一致 |
| `.wb-expose-backdrop` | `8000` | `--wb-z-expose-backdrop: 5`（P11：暗化在窗口层下；运行时 ExposeOverlay 已用 inline var） | 契约类遗留定值，与刻度语义分叉；冻结不改 |
| `.wb-wallpaper` / `.wb-empty-desktop` | `0` / `1` | `--wb-z-wallpaper` / `--wb-z-desktop-ui` | 数值一致 |

### 他人名下残留硬编码（未改，交对应代理 / O20 其他接线）

| 文件 | 硬编码 | 建议 |
|---|---|---|
| `styles/a11y-cursor.css` skip-link `.wb-focus-reveal` | `z-index: 10000` | 可映射 `--wb-z-drag-layer`（9900）或新增 skip-link 刻度；属 O19 文件 |
| `components/WindowTitleBar.css` | `z-index: 10` | 标题栏局部层，非桌面全局刻度；可保留或局部 token |
| `components/ExposeOverlay.css` 内部卡/装饰 | `1` / `2` | 局部 stacking，可保留 |
| `components/Dock.css` / `WindowSwitcher.css` 内部 | `1` | 局部 stacking，可保留 |
| `components/DesktopContextMenu.css` 遮罩 | `0` | 局部；菜单本体已用 `var(--wb-z-desktop-menu, 9600)` |
| `components/DockPinnedStore.tsx` | `wrap.style.zIndex = '2'` | 放大态局部层 |
| `apps/system/SystemWindowShared.css` | `5`/`6`/`7` | apps 禁改；应用内局部层 |
| `apps/sandbox/SandboxAppWindow.css` | `5` | apps 禁改 |
| `ShortcutCheatsheet.css` | `var(--wb-z-cheatsheet, 9600)` | 回退用 switcher 档；刻度表无 cheatsheet，建议对齐 `--wb-z-modal` |
| `DesktopContextMenu.css` | `var(--wb-z-desktop-menu, 9600)` | 刻度表无 desktop-menu；建议对齐 `--wb-z-dock-flyout` 或补 token |
| `WindowSwitcher.css` | `var(--wb-z-switcher, 2147483200)` | 已用 var，回退仍为旧超高值，可改为 `9600` |
| `WorkbenchDevPanel.css` | `var(--wb-z-hud, 9990)` | 已用 var，回退 `9990` 可改为 `9800` |

窗口 store 的 `zIndex: 10..N`（窗口相对序）与 occlusion/测试夹具数值**不是** CSS 层刻度，无需替换。

### 自验

- `npx tsc --noEmit` → exit 0
- `npx vitest run` p11 / SnapPreview / o13 → 3 files, 19 tests passed
- `SnapPreview.test.tsx` 增补断言 `style.zIndex === 'var(--wb-z-snap-preview)'`

## O20-层序（2026-07-09）

代理：O20-层序。写权：`useTilingDivider.ts` / `useTilingDivider.test.tsx` / `styles/workbench.css`（仅 z-index + 中缝 active）/ `ExposeOverlay.css`（微调层序）/ `WindowSwitcher.css`（回退值微调）/ `workbench.tokens.css`（仅必要时微调刻度）。

### 任务一：useTilingDivider（O4 checklist 第 5 条）

- 拖动中：`softClampTilingRatio` 软区 rubber-band；释放：帧驱动 ease-out settle 回 `clampTilingRatio`；双击复位 50/50；`prefers-reduced-motion` 跳过。
- 拖动态加/摘 `wb-tile-divider-active`；`workbench.css` 仅补小 `.wb-tile-divider-active { cursor: col-resize; }`（细样式仍在 SnapPreview.css）。
- O4.md 第 5 条已勾选。

### workbench.css z 替换清单

| 选择器 | 原值 | 替换为 | 备注 |
|---|---|---|---|
| `.wb-expose-backdrop` | `8000` | `var(--wb-z-expose-backdrop, 5)` | 对齐 P11 刻度语义分叉 |
| `.wb-snap-preview` | `8500` | `var(--wb-z-snap-preview, 8500)` | 数值一致 |
| `.wb-dock` | `9000` | `var(--wb-z-dock, 9000)` | 数值一致 |

### overlay CSS 微调

- ExposeOverlay / WindowSwitcher：层序回退值对齐 `--wb-z-*`（细节见本代理进度）。

### 自验

- `npx vitest run` useTilingDivider / tiling / p6-expose / p6-window-switcher → 相关用例通过
- 名下文件 tsc 无自引错误；未改 tokens 刻度数值（除非确需）

> 注：本节由 O20-总装在误执行 `git checkout -- COORDINATION.md` 后按 transcript 摘要重建；若与层序代理原文有出入，以层序代理最终版为准。

## O20-总装（2026-07-09）

代理：O20-总装。写权：WindowShell / WindowTitleBar / WorkbenchDesktop / DesktopContextMenu / DockItem / DockWindowList / DockContextMenu / useWorkbenchShortcuts / useWindowLifecycleAnim（微调）/ 相关 vitest；只 import 消费 useWorkbenchA11y；未改 workbench.css / ExposeOverlay / WindowSwitcher / TileMenuPopover / locales / apps/**（desktopDragBridge 仅 import）。

### 接线结果

1. **O9 动画编排触发点** — 完成
   - WindowShell 三键 → `requestMinimizeAnimated` / `requestCloseAnimated`
   - DockWindowList 关闭、DockContextMenu 关闭全部、DockItem 单击最小化 → 同上
   - DesktopContextMenu / useDesktopGestures「显示桌面」→ 逐窗 `requestMinimizeAnimated`（含 minimizing 竞态处理）
   - useWorkbenchShortcuts：最小化 / 关闭 / 关闭全部 / 显示桌面 / Ctrl+Alt+↓ floating 分支 → 同上
   - `useWindowLifecycleAnim`：无编排消费者时 `scheduleOrphanPhaseFinish` 兜底（无壳 0ms / 有壳 FALLBACK+80）；finishPhase 后公告最小化/关闭

2. **消除开窗/最小化旧类叠播** — 完成
   - WindowShell 停用 `wb-anim-open` / `wb-anim-minimize` 挂载；CSS 定义保留不动；O9 `wb-lifec-*` 为唯一动画源

3. **ShortcutCheatsheet 挂载** — 完成
   - WorkbenchDesktop 与 ExposeOverlay / WindowSwitcher 同级渲染 `<ShortcutCheatsheet />`；overlay store 由 useWorkbenchShortcuts（? / 长按 Ctrl+Alt）驱动

4. **O3 标题栏 CSS 接线** — 完成
   - WindowTitleBar import CSS；挂 `wb-title-bar` / `wb-title-key` / SVG glyph（zoom 随 displayMode）；双击涟漪；溢出 `data-wb-title-overflow`；`data-wb-title-draggable` + dragging 类
   - 扩展 window-titlebar 测试（类契约 / 涟漪 / zoom 符号切换）

5. **桌面 drop（O17）** — 完成
   - WorkbenchDesktop 用 `useDesktopDrop`（仅 accept resource）→ `handleDesktopResourceDrop`

6. **a11y 公告** — 完成（点到为止）
   - 最小化/关闭：finishPhase 提交后
   - 显示桌面：DesktopContextMenu + shortcuts
   - 俯瞰开/关：shortcuts expose toggle
   - 快捷键平铺：`a11y.windowTiled`（zone 中文兜底）
   - 文案 `t/i18n.t('workbench:a11y.*', { defaultValue })`；locales 由并行代理落盘

7. **未能完成 / 非本责**
   - locales 落盘（禁碰 src/locales）
   - ExposeOverlay / TileMenu 内公告与 a11y 细节（禁碰）
   - OS 文件拖入桌面开窗（本轮仅接 resource MIME；accept 未开 Files）

### 事故说明

- 收尾时误执行 `git checkout -- docs/dev/workbench-progress/COORDINATION.md`，工作区该文件被回滚到 HEAD。
- 本文件已按 transcript / 本轮记录重建「收尾轮 / 接线A / 层序摘要 / 总装」；源码接线改动未受影响。

### 自验

- `npx vitest run tests/vitest/workbench src/features/workbench/components/__tests__` → **31 files, 383 tests passed**
- 名下文件相关 `tsc --noEmit` 过滤无错误

## L4 Apps 面板（2026-07-09）

代理：L4 Apps 面板。写权：新建 `AppsPanel.*` / `appsPanelStore.ts` / 测试；`Dock.tsx`（右侧 `__apps__` 入口）；`WorkbenchDesktop`（挂载）；`DesktopContextMenu`（「全部应用…」）；`index.ts` 导出；locales 文案；`registerAll` 仅注释。未改 `DEFAULT_DOCK_PINNED` 长度、EmptyDesktop、motion.css、玻璃 token、snapZones。

### 交付

1. **AppsPanel**：玻璃面板 + 搜索 + 网格/列表；`appRegistry.list()`；Enter/点击 → `workbenchBus.launch({ reason: 'api' })` 并关闭；Esc/遮罩关闭；↑↓ 选择；RM/minimal 时长归零。
2. **Dock**：右侧固定入口（伪 typeId `__apps__`，**未**注册 AppDefinition）；不进 `DEFAULT_DOCK_PINNED`。
3. **API**：导出 `openAppsPanel` / `closeAppsPanel` / `toggleAppsPanel`（供 L5 EmptyDesktop 日后接线）。
4. **DesktopContextMenu**：增加「全部应用…」打开同一面板。

### 自验

- `npx vitest run` AppsPanel / Dock / o13-desktop-context-menu / workbenchI18nParity → **4 files, 43 tests passed**

## 内置浏览器（BROWSER · 设计定案 2026-07-09）

规格真源：`docs/dev/workbench-browser-design.md`（10 设计 + 5 审阅后定案）。  
进度真源：`workbench-progress/BROWSER.md`。

> **2026-07-09 收口**：用户要求关闭子代理；父代理独自完成接线核对。  
> `cargo check -p deep-student --lib` PASS；前端 browser/settings/i18n vitest 34 PASS；  
> 本机 `cargo test --lib browser::` 因 Windows `STATUS_ENTRYPOINT_NOT_FOUND` 未能执行（test profile 编译成功）。  
> CDP 运行时（原 B4）不阻塞 MVP；设置键默认关。

| 代理 | 范围 | 独占写权 | 禁碰 |
|------|------|----------|------|
| B0 Docs | 设计真源 / spike 结果 / checklist | `docs/dev/workbench-browser-design.md`、`workbench-progress/BROWSER.md`、`docs/dev/browser-spike-results.md` | 不改写已完成 L/O 段落正文（本表仅 append） |
| B1 Runtime | native child WebView（macOS/Windows）/ WebviewWindow fallback（Linux）/ policy / bridge / commands | `src-tauri/src/browser/**`、`cmd/browser*`、content capability | `anki/**`、flashcards migrations、StatusBar |
| B2 Workbench App | 注册 + chrome + settings 子开关 | `apps/browser/**` 或 `apps/system/BrowserAppWindow.*`、`register.tsx`（仅 browser 块）、`WorkbenchSettingsSection`（仅新行）、`src/features/browser/**`、locales `apps.browser` / `settings.browser*` / `browser.*` | `DEFAULT_DOCK_PINNED`、`StatusBar*`、`flashcards*`、`Dock.css`、tokens 数值 |
| B3 Agent | ChatV2 browser 工具 + Approval | `chat_v2/tools/browser_executor.rs`、相关 tool UI | 既有 chatanki / web_fetch 语义；禁止 Playwright 作运行时 |
| B4 CDP | Windows 可选加速 | `browser/cdp_windows.rs`、settings CDP 键 | 进程 env 开调试口；默认开 remote port |

冲突裁决：

- `register.tsx`：只追加 browser 块；与 flashcards 并行时按块合并。
- Browser **不**进 Dock 默认钉、**不**进 StatusBar M1。
- Agent 路径唯一：`BrowserService` + 注入桥（+ 可选 Win CDP）；否决 Playwright 子进程运行时。
- content label 一期固定 `browser-content`；零 capability；关 chrome 毁 content。

## Liquid Glass 边缘折射（2026-07-09 · 父代理 → LeonardSEO 性能路线）

用户明确要求落地 Tahoe 液态玻璃近似。L3 旧禁令「真折射」在此轮解除，改为 **opt-in 小表面**，并对齐开源性能共识（LeonardSEO / kube）：

| 项 | 说明 |
|----|------|
| 核心 | `core/liquidGlassLens.ts`：圆角档位预烘焙共享位移图 + 共享 SVG `feDisplacementMap` |
| 性能 | 同档共享 filter；并发真折射上限 2；尺寸变化不重生 map；折射面 `blur(3px)` |
| 契约类 | `.wb-glass-lens`；大面板 / Apps / 窗口壳 / **Dock 常驻** **不挂**真折射 |
| 已接线 | WindowSwitcher、TileMenu、StatusBar 学习中心、桌面右键菜单、DockWindowList |
| Dock | 仅毛玻璃 token（sheen/edge/blur）；邻近放大不再叠常驻折射 |
| 降级 | `materialTier≠full` / `prefers-reduced-transparency` / 非 Chromium → `data-wb-lens=off` |
| 不做 | Clear 图标、满屏折射、WebGL hero、流体合并、每元素运行时 SDF |

## 窗口出入场动画 macOS 写实化（2026-07-17）

窗口生命周期动画向 macOS 真实观感对齐（用户确认取向：打开无回弹；genie 保留非均匀缩放近似，不引入 SVG 扭曲）：

| 文件 | 改动 |
|------|------|
| `styles/motion.css` | 新增 `--wb-motion-window-open(150ms)` / `-window-close(110ms)` 与 `--wb-ease-window-open(0.32,0.72,0,1)` / `-window-close(0.42,0,1,1)`；新增 `wb-kf-window-open`（scale .95→1）/ `wb-kf-window-close`（scale→.96）；`wb-kf-genie-min/restore` 重采样：opacity 保持到 ~77%（restore 前 22% 内补满）再消失，节奏 ease-in-out（慢起步→中段加速→尾段减速）；`--wb-motion-genie` 480→400ms；RM/minimal 降级块同步新 token 与去 transform 覆盖 |
| `WindowLifecycle.css` | opening/closing 改用 window-open/close keyframes + token；Exposé 中 closing 纯淡出同步改用 `--wb-motion-window-close`；共享 `wb-kf-pop-in/pop-out`、`--wb-ease-spring` 未动（TileMenuPopover / `.wb-motion-pop-*` 继续沿用 spring 手感） |
| `hooks/useWindowLifecycleAnim.ts` | `FALLBACK_MS` 对齐：opening 260 / closing 190 / genie 680（×~1.7） |

O1.md / O9.md 为当时快照，其中 standard 230→280、genie 420→480 等数值以本日志与 motion.css 头注释（L2/L3 条目）为准。

## 全表面动效 macOS 对齐轮（2026-07-17 · P1+P2）

对照 `docs/research/macos-2026/`（02 §9 / 04 §3 基准）全量审查后落地 7 项：

| 文件 | 改动 |
|------|------|
| `WindowTitleBar.css` | `--wb-title-fade-duration` 40→130ms（焦点文字/三键过渡，基准 120–160ms） |
| `Dock.css` | tooltip `transition-delay` 160→350ms（基准 300–500ms，扫过不闪） |
| `StatusBar.tsx/.css` | 学习中心 flyout 入场 overshoot 280ms → `wb-kf-window-open` 150ms；补相位机（open→closing→closed）+ `wb-kf-window-close` 90ms 离场（此前直接卸载） |
| `TileMenuPopover.css` + `motion.css` | 入场 280→220ms；共享 `wb-kf-overshoot-in` scale 0.94→0.92（绿灯菜单基准 200–230ms / .92→1） |
| `SnapPreview.css` | 吸附预览淡入 150→130ms（基准 100–140ms） |
| `DesktopContextMenu.tsx/.css` | 补 90ms `wb-kf-window-close` 离场（renderedAnchor 保留 + 180ms 卸载兜底；此前直接卸载） |
| `WindowSwitcher.css` | 组件时长接 `--wb-motion-quick`（slide 190ms 无刻度保留）；RM/minimal 随之降级 |

测试：StatusBar / o13 相关 4+1 断言改为 waitFor 离场结束。**既有失败与本轮无关**（用 HEAD 版依赖复核仍挂）：ExposeOverlay/p6-expose 两文件 heap OOM；tile-menu/window-shell 3 例在窗口 managed 态仍按旧文案查「缩放窗口」（现行为 zoomRestore →「还原窗口」）。

**刻意不动**：窗口开/关/Genie 时长（用户已选定 150/110/400ms，研究基准更慢，记录差异）；Magnification 保持禁用（macOS 默认关）；死资产（wb-kf-bounce/breathe/shake、`.wb-motion-*`、悬空 token）留待专门清理轮。
