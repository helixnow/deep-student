# Apple 半透明侧边栏与标题栏对齐修复执行清单

> **For LLM:** 按 Phase 顺序执行；每完成一项就在对应 checkbox 打勾；不要重写本文档结构；不要输出全文，只引用此文件路径；如发现与仓库现状冲突，以“更贴近 Apple 的低复杂度桌面工具体验”为优先，并把原因补写到本文档“实施备注”区。

**目标**
让 macOS 模式下的标题栏、侧边栏、主工作区更贴近 Apple 的原生 split view / toolbar 组织方式，重点修复：
1. 右侧主工作区圆角边界的颜色不一致
2. 侧边栏半透明材质与标题栏材质不统一
3. 侧边栏切换 icon 必须稳定落在红绿灯右侧
4. 避免继续用伪玻璃、伪阴影、伪圆角补丁制造 Apple 感

**仓库约束**
- React 19、Vite 7、TypeScript、Tailwind v4、Radix、shadcn/ui、Phosphor Icons
- 不引入新组件库
- 不做营销页式美化，不增加夸张动画、渐变、悬浮装饰
- 保持低复杂度桌面工具气质

**四路并行调研结论摘要**
- **Track A / 材质**：Apple 强调 navigation / controls 是单独的功能层；不要把 Liquid Glass 用在 content layer；toolbar / sidebar 应是同一层级的导航材质，而不是 sidebar 和 main 各自独立采样。来源：[Materials](https://developer.apple.com/design/human-interface-guidelines/materials/)、[NSVisualEffectView](https://developer.apple.com/documentation/appkit/nsvisualeffectview)
- **Track B / 标题栏与 toggle**：sidebar toggle 属于 toolbar leading edge，位置在最前导区域，红绿灯右边；系统标准项是 [toggleSidebar](https://developer.apple.com/documentation/appkit/nstoolbaritem/identifier/togglesidebar)。来源：[Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars/)
- **Track C / split 与边界**：Apple 推荐 thin divider，并用 tracking separator 让 toolbar 与 split divider 连续对齐，不靠手工圆角补丁。来源：[Split views](https://developer.apple.com/design/human-interface-guidelines/split-views/)、[sidebarTrackingSeparator](https://developer.apple.com/documentation/appkit/nstoolbaritem/identifier/sidebartrackingseparator)
- **Track D / AppKit 新设计**：WWDC25 明确指出 sidebar 是“浮在内容上的玻璃 pane”；如果还在 sidebar 内再叠老式 visual effect，会阻断系统玻璃；要让内容在 sidebar 下方延展，并用 scroll edge / background extension 保持可读性。来源：[Build an AppKit app with the new design - WWDC25](https://developer.apple.com/videos/play/wwdc2025/310/)

**当前仓库主要问题定位**
- `/Users/ba7mlv/Documents/ui/study-ui/src/components/shell/AppChrome.tsx`
  - 主工作区仍通过 `before/after` 阴影与圆角补丁制造左侧接缝，容易导致半透明模式下边界颜色不一致
  - macOS toggle 已进入标题栏体系，但还没有明确收敛为“红绿灯右侧固定 leading control”
- `/Users/ba7mlv/Documents/ui/study-ui/src/lib/app-shell.ts`
  - sidebar / shell / main 仍是各自独立的材质返回逻辑，没有明确的“共享导航层 + 内容层”语义
- `/Users/ba7mlv/Documents/ui/study-ui/src/components/shell/Titlebar.tsx`
  - accessory 的几何是通用 left offset，没有单独抽象“traffic lights right anchor”语义
- `/Users/ba7mlv/Documents/ui/study-ui/src/components/shell/Sidebar.tsx`
  - sidebar 仍在自身组件内承担部分标题栏视觉职责；需进一步收敛成更安静的 source list pane

---

## Phase 0 - 证据锁定

- [x] 先通读以下文件，不要立即改代码：
  - `/Users/ba7mlv/Documents/ui/study-ui/src/components/shell/AppChrome.tsx`
  - `/Users/ba7mlv/Documents/ui/study-ui/src/components/shell/Titlebar.tsx`
  - `/Users/ba7mlv/Documents/ui/study-ui/src/components/shell/Sidebar.tsx`
  - `/Users/ba7mlv/Documents/ui/study-ui/src/lib/app-shell.ts`
  - `/Users/ba7mlv/Documents/ui/study-ui/src/lib/macos-titlebar-geometry.ts`
- [x] 在动手前，确认当前右侧圆角颜色不一致是否主要来自 `main` 的 `before/after` 伪圆角补丁，而不是 sidebar 本身
- [x] 在本文档“实施备注”区补一句结论：当前视觉问题的第一责任层到底是 `main pane seam`、`sidebar material`，还是两者叠加

## Phase 1 - 重建 Apple 语义层级（先结构，后样式）

- [x] 将 shell 层明确拆成两层语义：
  - `navigation/chrome layer`：titlebar + sidebar
  - `content/workspace layer`：main pane
- [x] 禁止继续用“独立 blur sidebar + 独立主内容底色 + 额外阴影补丁”去伪造原生 split view
- [x] 在 `/Users/ba7mlv/Documents/ui/study-ui/src/lib/app-shell.ts` 增加/重命名辅助函数，使其能表达：
  - titlebar surface class
  - sidebar surface class
  - main workspace surface class
  - split seam / divider class
- [x] 所有 surface class 仍只能基于现有 token 组合，不要硬编码新颜色，不要新增随意 blur 数值体系

## Phase 2 - 修正 macOS 红绿灯右侧 toggle 位置

- [x] 把 sidebar toggle 定义为 macOS titlebar leading group 的固定成员，而不是内容区浮动按钮
- [x] 位置规则改为：红绿灯组结束后立即出现 toggle，二者之间仅保留一个克制的固定间距
- [x] 在 `/Users/ba7mlv/Documents/ui/study-ui/src/lib/app-shell.ts` 抽出明确几何 token，例如：
  - traffic lights trailing edge
  - toggle leading offset from traffic lights
  - title leading content offset after toggle
- [x] 在 `/Users/ba7mlv/Documents/ui/study-ui/src/components/shell/AppChrome.tsx` / `/Users/ba7mlv/Documents/ui/study-ui/src/components/shell/Titlebar.tsx` 中，用这套 token 驱动 `leadingAccessoryOffset` 和标题 left inset
- [x] 保证 sidebar 打开与关闭两种状态下，toggle 都保持同一个锚点，不要左右跳动
- [x] 保证 macOS 模式下不再出现第二个同义 toggle 入口

## Phase 3 - 去掉造成接缝脏污的伪圆角补丁

- [x] 删除 `/Users/ba7mlv/Documents/ui/study-ui/src/components/shell/AppChrome.tsx` 中主工作区左侧 `before/after` 那套圆角阴影补丁，如果仍需要边界表达，改成单一 divider / rim
- [x] 不再依赖额外 shadow 去补半透明接缝
- [x] 改为让 sidebar 与 main 之间只保留一条连续、低对比、稳定的 seam
- [x] 优先使用 1px 语义边界线或同色系 rim，而不是左右两套颜色叠加
- [x] 如果去掉补丁后主工作区更贴近 Apple，则把原因补写到“实施备注”区

## Phase 4 - 统一 sidebar / titlebar 半透明策略

- [x] 让 sidebar 与 titlebar 共享同一导航层材质语义；不要一个偏灰、一个偏白、一个偏蓝
- [x] 半透明模式优先选择更接近 Apple regular material 的策略：
  - 保持 legibility
  - 保持低噪音
  - 不追求“更透明”
- [x] 如果当前实现仍使用 `backdrop-blur-xl` 之类的纯 Web 玻璃模拟，收敛为更克制的单层效果，不再叠加额外遮罩/阴影/高亮
- [x] 避免在 content layer 使用同等级的玻璃材质；main workspace 应更稳定、更实心，突出 navigation 浮在上面
- [x] 如果必须保留轻微透明度差异，确保 titlebar / sidebar 的视觉采样关系一致，不出现 corner seam 两边明度跳变

## Phase 5 - 建立连续 divider 与边界节奏

- [x] 让标题栏底部与 sidebar-main 分隔线在视觉上连续，接近 Apple tracking separator 的感觉
- [x] 不要求机械复刻 AppKit tracking separator，但要实现以下结果：
  - divider 在标题栏区域和内容区域是一条连续逻辑线
  - sidebar 宽度变化或显隐时，这条线不会断裂
  - 圆角处不会出现单独的深色/浅色补丁
- [x] 桌面端保持 thin divider 气质；不要把 seam 做成明显卡片边框

## Phase 6 - sidebar 内容层降噪

- [x] 继续保持 source list 安静，不新增 marker、胶囊边框、额外 hover 特效
- [x] 如有必要，进一步减少 sidebar header 自身存在感，让它更像系统 source list pane
- [x] 确保 active row 仍主要靠系统式选中底和文本层级表达，而不是新的装饰元素

## Phase 7 - 验证与回归

- [x] 先补/改源码测试，至少覆盖：
  - macOS toggle 固定在红绿灯右侧的几何意图
  - 不再存在 main pane 左侧 `before/after` 伪圆角补丁
  - sidebar/titlebar 半透明 class 属于同一语义层而非两套杂糅实现
- [x] 运行局部测试：
```bash
node --test --experimental-strip-types src/components/shell/AppChrome.source.test.ts src/components/shell/Sidebar.source.test.ts src/lib/app-shell.test.ts
```
- [x] 运行全量源码测试：
```bash
node --test --experimental-strip-types $(find src -type f \( -name '*.test.ts' -o -name '*.source.test.ts' \) | sort)
```
- [x] 运行：
```bash
npm run lint
npm run build
```
- [x] 把验证结果追加到本文档“验证记录”区，包含命令、是否通过、若失败则写明失败点

---

## 实施备注

- [x] 当前视觉问题第一责任层是 `main pane seam`，因为 `/Users/ba7mlv/Documents/ui/study-ui/src/components/shell/AppChrome.tsx` 里 `main` 左侧 `before/after` 伪圆角阴影补丁直接制造了半透明接缝的明度跳变；`sidebar material` 是次要放大因素，但不是首因。
- [x] 为了让 macOS toggle 在 sidebar 打开/关闭时保持同一锚点，这次没有把它继续塞进仅覆盖 `main pane` 的局部标题栏，而是挂到共享 chrome layer 上用几何 token 锚定红绿灯右侧；当前 DOM 里若强行把 accessory 留在 `main` 内部，会因为内容层裁切导致锚点跳动，不符合 Apple 的低复杂度桌面体验。
- [x] 去掉 `main pane` 左侧伪圆角补丁后，接缝只剩单一 1px seam，圆角边界不再叠加阴影采样，视觉上更接近 Apple split view 的连续 tracking separator，而不是一块被阴影“补出来”的卡片。

## 验证记录

- [x] 已补充
  - `node --test --experimental-strip-types src/components/shell/AppChrome.source.test.ts src/components/shell/Sidebar.source.test.ts src/lib/app-shell.test.ts`：通过（29/29）
  - `node --test --experimental-strip-types $(find src -type f \( -name '*.test.ts' -o -name '*.source.test.ts' \) | sort)`：通过（87/87）
  - `npm run lint`：通过（exit code 0）
  - `npm run build`：通过（Vite 7 生产构建完成，输出写入 `dist/`）

## 参考链接（仅引用，不要整段抄录）

- [Materials](https://developer.apple.com/design/human-interface-guidelines/materials/)
- [Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars/)
- [Split views](https://developer.apple.com/design/human-interface-guidelines/split-views/)
- [NSVisualEffectView](https://developer.apple.com/documentation/appkit/nsvisualeffectview)
- [toggleSidebar](https://developer.apple.com/documentation/appkit/nstoolbaritem/identifier/togglesidebar)
- [sidebarTrackingSeparator](https://developer.apple.com/documentation/appkit/nstoolbaritem/identifier/sidebartrackingseparator)
- [Build an AppKit app with the new design - WWDC25](https://developer.apple.com/videos/play/wwdc2025/310/)
- [Adopting Liquid Glass](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass/)
