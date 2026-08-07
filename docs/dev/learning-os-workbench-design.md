# Deep Student 学习 OS（Workbench）设计文档

- 日期：2026-07-08
- 状态：设计定稿（待评审）
- 范围：桌面端（Tauri 主窗口内），移动端不适用
- 前置决策：
  1. Chat 是普通窗口，无特权地位；
  2. 以独立模块开发，通过实验开关切换新旧模式；
  3. UI/UX 对标最新 macOS（Tahoe 26 的 Liquid Glass 设计语言 + Sequoia 引入的原生窗口平铺体系）。

---

## 1. 背景与目标

### 1.1 问题

当前桌面端的主交互是"左侧导航 + 主视图切换 + Chat 页右侧副面板"。副面板是一个独占槽位，
要在资源浏览器、统一应用面板（笔记/教材/题目集/翻译/作文/图片/文件/思维导图八类内容视图）、
沙箱工作台三种形态间切换。学习工作流天然多产物并存——用户在与 AI 对话时往往需要同时参照
教材 PDF、笔记和思维导图——"N 个活动物件 vs 1 个展示槽位"的错配是当前体验的核心矛盾。

### 1.2 目标

把主内容区演进为一个**应用内桌面（Workbench）**：

- 每类学习资源/功能是一个"应用"，打开后是一个可自由摆放、平铺、最大化的**窗口**；
- 底部 **Dock** 承担启动与切换；
- 布局跨会话持久化，重启后桌面恢复原样；
- 所有应用一视同仁：Chat 会话也是普通窗口，可开多个、可关闭、可平铺；
- 视觉与交互对标 macOS 的成熟范式，让用户"零学习成本"上手。

### 1.3 非目标

- 不做真正的多进程窗口隔离（Tauri 单 webview 架构下不可行，见 §8）；
- 不改造移动端（继续使用现有滑动布局）；
- 首期不做多虚拟桌面（Spaces）、不做窗口跨原生多窗口拖拽；
- 不重写任何应用的业务逻辑——现有内容视图原样复用。

---

## 2. macOS 设计参考要点（调研结论）

以下是对最新 macOS 实际设计的调研摘要，作为本设计的交互与视觉基准。

### 2.1 视觉：Liquid Glass 设计语言（macOS Tahoe 26）

- 核心材质是**半透明玻璃**：反射与折射背景内容，控件、Dock、侧栏、工具栏由多层玻璃叠加构成，
  带高光（specular highlights），随明暗环境动态适应。
- **菜单栏完全透明**，让屏幕显得更大；内容优先，chrome 退后。
- Dock、图标、小组件均为多层玻璃材质；图标支持浅色/深色/彩色 tint/全透明 clear 四种外观。
- 提供**降透明**开关（辅助功能 > 显示 > 减少透明度），透明是可退化的增强而非硬依赖。
- 窗口大圆角、阴影柔和，工具栏与内容融为一体。

**对本设计的启示**：玻璃质感做在 Dock、窗口标题栏和桌面 chrome 上；内容区域保持不透明以保证
可读性；透明效果必须有开关且能整体降级（对应我们的跨平台性能差异，见 §8.3）。

### 2.2 窗口管理：原生平铺体系（macOS Sequoia 15+）

- **拖拽吸附**：窗口拖到屏幕左/右边缘 → 出现预览轮廓 → 松手填充半屏；拖到角落 → 四分之一屏。
- **绿灯按钮悬停菜单**：悬停窗口左上角绿色按钮，弹出平铺选项菜单（左/右/上/下半屏、四角、
  填满、居中），还可以选择另一个应用填充另一半。
- **键盘快捷键**：`Fn+Ctrl+方向键` 平铺到对应半屏，`Fn+Ctrl+F` 填满，`Fn+Ctrl+C` 居中，
  `Fn+Ctrl+R` 恢复平铺前尺寸。
- **平铺间距**：默认平铺窗口之间有 margin，可在设置中关闭。
- **可调分割**：两窗并排平铺后，拖中缝调整比例（如 70/30）。
- **恢复语义**：从平铺状态拖走窗口，自动恢复平铺前的原始尺寸。

### 2.3 导航与切换范式

- **Dock**：常驻启动器 + 运行指示（图标下圆点）；点击已运行应用 → 聚焦；
  多窗口时右键/长按列出所有窗口。
- **Mission Control**：一键俯瞰所有窗口缩略图，点击任一窗口聚焦。
- **Stage Manager**：焦点应用居中，最近应用成组缩略在侧边——单焦点工作流的辅助形态。
- **Cmd+Tab**：按最近使用顺序循环切换应用。

**对本设计的启示**：Dock + 窗口俯瞰（Exposé）+ 键盘循环切换是导航三件套，首期全部实现；
Stage Manager 属于进阶形态，列为远期可选。

---

## 3. 信息架构与模块边界

### 3.1 顶层结构

```
主窗口
├── 自绘标题栏（现有）
├── 左侧导航栏（现有，开关开启后可折叠为窄条或隐藏）
└── 主内容区
    ├── [开关关闭] 现有 currentView 视图切换（原样保留）
    └── [开关开启] WorkbenchDesktop（学习 OS 桌面）
        ├── 桌面画布（壁纸层 + 窗口层）
        ├── Dock（底部居中，玻璃材质）
        └── 全局层（窗口俯瞰、吸附预览、快捷键处理）
```

### 3.2 模块目录（独立模块，单向依赖）

```
src/features/workbench/
  core/
    types.ts            # 全部契约类型（见 §4）
    windowStore.ts      # zustand：窗口集合、焦点栈、显示模式
    scheduler.ts        # 生命周期调度器（见 §5）
    snapshot.ts         # 布局快照的持久化与恢复（见 §7）
    appRegistry.ts      # 应用注册表
    workbenchBus.ts     # 类型化 launch / activate / project API
    shortcuts.ts        # 快捷键注册（作用域限桌面激活时）
  components/
    WorkbenchDesktop.tsx    # 桌面画布 + 层组合
    WindowShell.tsx         # 窗口 chrome（标题栏/三键/缩放柄/吸附）
    WindowBody.tsx          # 生命周期感知的内容挂载壳
    Dock.tsx / DockItem.tsx
    ExposeOverlay.tsx       # 窗口俯瞰
    SnapPreview.tsx         # 吸附预览轮廓
  apps/
    registerBuiltinApps.tsx # 首批应用注册（薄适配层）
  styles/
    workbench.css           # 玻璃材质 token 与降级（见 §6.4）
  index.ts                  # 模块唯一公共出口
```

依赖规则：

- `workbench/*` 可以 import 各 feature 的**公共组件**（如统一应用面板的内容视图）；
- 任何现有 feature **不得** import `workbench/*` 内部实现，只能通过 `workbenchBus` 公共 API
  请求开窗/激活（且必须在开关关闭时优雅降级为现有导航行为，见 §9.3）；
- `workbench` 不持有任何业务状态，业务状态仍归各 feature store 与 Rust 后端。

### 3.3 模式开关

- 设置项：`desktop.workbenchMode`（boolean，默认 false），落在现有系统设置存储，
  暴露在「设置 → 实验功能」。
- 切换即时生效（主内容区整体换渲染分支），不要求重启；两套模式的状态互不污染：
  - 开关开启时，现有 `currentView` 状态机继续存在但仅渲染 workbench 一个视图；
  - 关闭时 workbench 整棵树卸载，布局快照保留在磁盘，下次开启原样恢复。
- 开发期另设 `desktop.workbenchDevPanel`（默认 false）显示调度器诊断信息（活跃/冻结窗口、
  内存权重占用、帧预算警告）。

---

## 4. 核心契约与数据模型

### 4.1 应用定义（AppDefinition）

```ts
interface AppDefinition {
  typeId: string;                       // 'chat' | 'note' | 'textbook' | 'exam' | ...
  nameKey: string;                      // i18n key
  icon: ReactNode;
  instanceMode: 'single' | 'multi';     // multi 时按 instanceKey 去重
  memoryWeight: 1 | 2 | 3;              // 调度器预算权重（见 §5.3）
  defaultFrame: { w: number; h: number };
  minSize: { w: number; h: number };
  render: LazyExoticComponent<FC<AppWindowProps>>;
  onActivation?: (win: WindowHandle, action: string, payload: unknown) => void;
}
```

### 4.2 窗口实例（WorkbenchWindow）

```ts
type DisplayMode =
  | 'floating'
  | 'maximized'            // 填满桌面（非全屏，保留 Dock）
  | 'tiled-left' | 'tiled-right'
  | 'tiled-tl' | 'tiled-tr' | 'tiled-bl' | 'tiled-br';

type Lifecycle = 'focused' | 'visible' | 'background' | 'frozen';

interface WorkbenchWindow {
  id: string;                    // 壳身份，nanoid
  typeId: string;
  instanceKey: string | null;    // 业务身份，如 'note:xxx' / 'chat:sess_xxx'
  title: string;
  frame: Frame;                  // floating 时的位置尺寸
  restoreFrame: Frame | null;    // 平铺/最大化前的原尺寸（macOS 恢复语义）
  displayMode: DisplayMode;
  minimized: boolean;
  zIndex: number;
  lifecycle: Lifecycle;          // 由调度器派生，不持久化
  createdAt: number;
  lastFocusedAt: number;         // LRU 依据
}
```

### 4.3 应用窗口 Props（AppWindowProps）

从现有统一应用面板的 `ContentViewProps` 演化，保证首批应用近零成本迁移：

```ts
interface AppWindowProps {
  windowId: string;
  instanceKey: string | null;
  isActive: boolean;             // lifecycle === 'focused'
  isVisible: boolean;            // focused | visible（供降频判断）
  onTitleChange: (title: string) => void;
  requestClose: () => void;      // 应用可拦截（未保存提示）后调 confirmClose
}
```

### 4.4 workbenchBus：三种打开语义

```ts
// 1. launch：用户/系统请求打开某应用；新建还是复用由 instanceMode + instanceKey 决定
workbenchBus.launch({ typeId, instanceKey?, payload?, reason: 'dock' | 'api' | 'shortcut' });

// 2. activate：对已存在窗口发一次性指令（滚动到消息、定位 PDF 页码等）；
//    窗口不存在时可选 fallbackLaunch。取代现有全局 CustomEvent 导航。
workbenchBus.activate({ typeId, instanceKey, action, payload, fallbackLaunch? });

// 3. project：长活业务实例声明式投射（运行中的 Agent 任务、番茄钟、后台制卡任务）。
//    实例出现→自动出现窗口（或 Dock 角标）；实例结束→由宿主决定收敛方式。
workbenchBus.project({ typeId, instanceKey, title, initialFrame? });
```

规则：`launch`/`activate` 的 payload 是瞬态数据，**绝不进快照**；快照只存 §4.2 中
除 `lifecycle` 以外的壳字段。

---

## 5. 窗口生命周期与调度器

单 webview 架构下所有窗口共享一个 UI 主线程与帧预算，调度器是本设计的性能核心。

### 5.1 四档生命周期

| 档位 | 判定 | 渲染策略 |
|---|---|---|
| `focused` | 焦点栈顶 | 全速渲染，接收键盘事件 |
| `visible` | 非焦点但有可见面积 | 挂载但降频：流式文本渲染节流至 ~500ms/次；编辑器只读化协同光标；canvas 动画暂停 |
| `background` | 最小化或被完全遮挡 | DOM 保留，`visibility:hidden` + `content-visibility:hidden`（复用现有视图保活层的成熟做法），渲染成本归零 |
| `frozen` | 超出内存预算被调度器冻结 | 卸载 DOM，仅保留 WorkbenchWindow 壳记录；唤醒时重建，状态由应用自身 store/后端恢复 |

`isActive` / `isVisible` 通过 props 下传；现有内容视图已支持 `isActive`，只需接线。

### 5.2 遮挡计算

维护 zIndex 有序列表，自顶向下累计覆盖区域，完全被上层窗口矩形并集覆盖的窗口判定为
`background`。计算仅在窗口增删、移动结束、层叠变化时触发（O(n²) 矩形运算，n≤15 可忽略），
拖动过程中不触发。

### 5.3 内存预算与冻结

- 预算池：默认 12 点（可按设备内存调整）。
- 每个非 frozen 窗口占用其 `memoryWeight`：PDF/教材=3，编辑器/思维导图/Chat=2，
  图片/纯展示=1。
- 超预算时，从 `background` 档中按 `lastFocusedAt` LRU 冻结最旧者，直至回到预算内；
  `focused`/`visible` 永不冻结。
- 冻结策略取代现有标签容器"固定保活 5 个"的一刀切逻辑，是它的推广版。

### 5.4 拖拽与缩放的渲染纪律

- 拖动/缩放由 `WindowShell` 用 Pointer Events 实现，过程中**直接改 DOM 的
  `transform`/`width`/`height`**（`requestAnimationFrame` 合帧），不进 React state；
  松手才 commit 到 windowStore。
- 拖动期间窗口内容层套 `pointer-events: none`，并对 `visible` 档窗口临时挂起降频渲染。
- 吸附判定在拖动的 rAF 回调内做纯几何计算，命中边缘/角落时渲染 `SnapPreview` 轮廓层
  （独立 DOM 层，不触碰窗口树）。
- 禁止引入每帧 setState 的第三方拖拽库。

### 5.5 事件纪律

- Tauri 后端事件由 workbench 外层的**单一中枢**订阅（沿用现有适配器模式），
  经 `workbenchBus` 内部分发到目标窗口；禁止每个窗口自行 `listen` 全局事件。
- 大资产（PDF、图片、音频）一律走自定义协议（现有 `pdfstream:`/asset protocol），
  不过 IPC 命令通道。此规则写入应用注册的 code review 检查项。

---

## 6. 交互与视觉规范

### 6.1 窗口 chrome

- **标题栏**（高 38px）：左侧三键（关闭/最小化/缩放，macOS 红黄绿布局，本产品配色可自定），
  中间标题（应用可通过 `onTitleChange` 更新），双击标题栏 = 最大化/还原。
- **缩放键悬停菜单**（对标绿灯按钮）：悬停 350ms 弹出平铺选项面板——左半/右半/四角/
  填满/居中，图标网格式布局；点击立即平铺。
- **边缘缩放柄**：四边 + 四角，命中区 6px（视觉不可见）。
- **关闭语义**：`requestClose` 先询问应用（未保存拦截），应用确认后壳才销毁。
  Chat 窗口关闭 = 关闭该会话视图，会话数据不受影响（业务实例与壳分离）。

### 6.2 摆放体系（对标 Sequoia 平铺）

- **拖拽吸附**：拖到左/右边缘 → 半屏预览轮廓；拖到四角 → 四分之一屏预览；松手落位。
  预览轮廓用主题色描边 + 8% 填充，120ms fade-in。
- **平铺间距**：平铺窗口间距 8px（设置项可关，对标 "Tiled windows have margins"）。
- **可调分割**：左右平铺的两窗中缝可拖动调整比例，比例入快照。
- **恢复语义**：`restoreFrame` 记录平铺/最大化前的 frame；从平铺态拖走窗口即恢复原尺寸；
  快捷键恢复同理。
- **新窗默认落位**：级联偏移（每次 +24,+24，超出边界回卷）；
  桌面可用宽 <1280px 时新窗口默认 `maximized`（小屏体验退化为标签页心智，零回退）。

### 6.3 Dock 与导航三件套

- **Dock**：底部居中悬浮，玻璃材质，图标 44px：
  - 内容 = 固定应用（用户可右键固定/移除）+ 运行中应用；运行中图标下方有指示点；
  - 点击：无实例 → launch；单实例 → 聚焦（已聚焦则最小化）；多实例 → 弹出窗口列表
    （标题 + 缩略预览）；
  - 角标：应用可通过 registry 声明 badge 源（如制卡任务进行中数量）；
  - 自动隐藏选项（默认关）。
- **窗口俯瞰（对标 Mission Control）**：快捷键或 Dock 端点触发，所有窗口等比缩小平铺
  （CSS transform 缩放现有 DOM，不生成截图），点击聚焦，Esc 退出。
- **循环切换（对标 Cmd+Tab）**：`Ctrl+Tab` 按 `lastFocusedAt` 循环，带图标条 overlay。

### 6.4 快捷键（对标 macOS，避开浏览器保留键）

| 快捷键 | 行为 |
|---|---|
| `Ctrl+Alt+←/→` | 平铺左/右半屏 |
| `Ctrl+Alt+↑` | 最大化（填满） |
| `Ctrl+Alt+↓` | 恢复原尺寸 / 最小化（已是 floating 时） |
| `Ctrl+Alt+C` | 居中 |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | 窗口循环切换 |
| `Ctrl+Alt+E` | 窗口俯瞰 |
| `Ctrl+W`（桌面焦点时） | 关闭焦点窗口（经 requestClose） |

快捷键仅在 workbench 激活且焦点不在文本输入时生效。

### 6.5 视觉材质（对标 Liquid Glass，含降级）

- CSS token 层：`--wb-glass-bg`（半透明背景）、`--wb-glass-blur`（backdrop-filter 模糊半径）、
  `--wb-glass-highlight`（顶缘高光）、`--wb-window-radius`（窗口圆角 12px）、
  `--wb-shadow-focused/idle`（焦点/非焦点阴影两档）。
- 玻璃材质只用于 **Dock、窗口标题栏、俯瞰背景、吸附预览**；窗口内容区一律不透明。
- 桌面壁纸层：默认取主题渐变，支持用户自定义图片（入设置）。
- **三档降级**（对标"减少透明度"）：
  1. `full`：blur + 高光 + 全部动效（Windows/macOS 默认）；
  2. `reduced`：去 backdrop-filter，改半透明纯色（Linux/WebKitGTK 默认，或用户手动选择）;
  3. `minimal`：全部不透明 + 禁用开合动画（跟随系统 `prefers-reduced-motion`）。
- 动效：开窗 = scale(0.96→1)+fade 160ms；最小化 = 向 Dock 位移缩小 220ms；
  全部限定 `transform`/`opacity` 双属性，禁止动画布局属性。

---

## 7. 布局持久化

- 快照 = `{ version, windows: 壳字段数组, dockPinned: typeId[], tilingRatios }`；
  防抖 2s 写入现有配置存储；模式开关关闭不删除快照。
- 恢复流程：启动 → 读快照 → 对每条记录：
  - 普通应用：直接重建壳，内容按生命周期惰性挂载（非 focused 直接进 `background`，
    首帧只完整渲染焦点窗口，其余逐帧唤醒）；
  - `instanceKey` 指向的业务实例已不存在（资源被删）→ 丢弃该壳并记日志；
  - projected 类型：只有宿主重新投射时才恢复（壳布局记忆保留）。
- 快照纯净性为 P0 约束：code review + `snapshot.ts` 内置 sanitizer 双保险，
  剥离任何非白名单字段。

---

## 8. 技术约束与对策（Tauri 单 webview）

### 8.1 单主线程

所有窗口共享 UI 主线程。对策即 §5 调度器 + §5.4 渲染纪律；另要求重计算下沉：
PDF 渲染保持 worker 化，思维导图布局计算迁入 Web Worker（可后置），markdown
流式解析节流。

### 8.2 IPC 带宽

`invoke` 只承载控制消息；流式走 Channel；大资产走自定义协议。窗口数量增加会放大
事件扇出，故 §5.5 强制中枢分发。

### 8.3 跨平台渲染差异

- Windows（WebView2/Chromium）：全效果基线平台。
- macOS（WKWebView）：注意进程内存红线——`memoryWeight` 预算在 macOS 下调至 9 点。
- Linux（WebKitGTK）：合成性能弱，默认 `reduced` 材质档 + 精简动效。

### 8.4 原生多窗口的定位

Tauri 多原生窗口仅用于"特权小窗"（现有番茄钟迷你窗模式），不是通用窗口机制；
workbench 窗口全部为 DOM 实现。

---

## 9. 首批应用与迁移

### 9.1 首批应用注册（Phase 1）

| typeId | 来源 | instanceMode | weight |
|---|---|---|---|
| `chat` | ChatV2 会话视图 | multi（按 sessionId） | 2 |
| `note` | 笔记内容视图 | multi（按资源 id） | 2 |
| `textbook` | 教材内容视图 | multi | 3 |
| `exam` | 题目集内容视图 | multi | 2 |
| `translation` | 翻译内容视图 | multi | 2 |
| `essay` | 作文批改内容视图 | multi | 2 |
| `image` / `file` | 图片/文件内容视图 | multi | 1 |
| `mindmap` | 思维导图内容视图 | multi | 2 |
| `files` | 资源浏览器（现学习中心侧栏） | single | 1 |

Chat 说明:Chat 应用 = 单个会话一个窗口；会话列表归入 `files` 型的资源浏览器或
Dock 弹出列表。多会话并排对比从此成为自然能力。

### 9.2 阶段计划

- **Phase 1（模块骨架 + 试点）**：core 全量 + WindowShell/Dock 基础版；开关上线；
  首批应用接入；无俯瞰、无投射。验收：开关开启后可开 3+ 窗口并排工作，拖拽 60fps，
  快照恢复正确。
- **Phase 2（导航三件套 + 打磨)**：俯瞰、Ctrl+Tab、吸附预览动效、材质三档、
  可调分割比例、Dock 角标。
- **Phase 3（收编）**：待办/技能管理/模板管理等全屏视图转为应用；全局 CustomEvent
  导航改写为 `workbenchBus.activate`；左侧导航栏在 workbench 模式下折叠为窄条。
- **Phase 4（长活投射 + 高级形态）**：Agent 任务/番茄钟/制卡任务 projection；
  多桌面（Spaces）与 Stage Manager 式聚焦模式进入评估。

### 9.3 兼容与回退

- 开关关闭 = 现有体验 100% 不变（workbench 代码不加载，lazy chunk 不下载）；
- 业务模块调用 `workbenchBus` 时，若 workbench 未启用，bus 自动降级为现有导航事件
  （适配层内完成，调用方无感知）；
- 任一阶段可独立发布，出现严重问题时用户自行关闭开关即回退。

---

## 10. 测试与验收

- **单元**：windowStore 状态机（焦点栈/平铺/恢复语义）、调度器（遮挡计算/LRU 冻结/预算）、
  snapshot sanitizer（业务字段剥离）。
- **交互（vitest + testing-library）**：拖拽吸附落位、缩放键菜单、requestClose 拦截、
  Dock 点击三分支。
- **性能基准（手动 + 诊断面板）**：5 窗口（含 1 PDF + 1 编辑器 + 1 Chat 流式输出）场景下
  拖动焦点窗口保持 ≥55fps；冻结/唤醒往返无状态丢失。
- **快照兼容**：`version` 字段 + 迁移函数，旧快照永不导致白屏（解析失败 = 空桌面 + 日志）。

## 11. 风险与开放问题

| 风险 | 缓解 |
|---|---|
| Chat 流式渲染在 `visible` 档降频后体感"变卡" | 降频只作用于 markdown 重排，token 缓冲不丢；焦点回归立即全速补渲 |
| 编辑器（Crepe）冻结唤醒后光标/撤销栈丢失 | Phase 1 将编辑器 weight 提至 3 减少被冻概率；未保存内容依赖现有卸载兜底保存链路 |
| 遮挡判定误判致后台窗口漏渲染 | 诊断面板可视化生命周期；误判时降级策略是宁可 `visible` 不可错杀 |
| 用户不适应窗口范式 | 开关默认关；小屏默认最大化让行为趋近现状；后续按留存数据决定是否转正 |

开放问题（Phase 2 前需定）：

1. 桌面壁纸是否随主题联动或独立设置；
2. `files` 资源浏览器与现有学习中心全屏页的长期关系（并存 or 取代）；
3. 窗口俯瞰是否合并现有命令面板入口。
