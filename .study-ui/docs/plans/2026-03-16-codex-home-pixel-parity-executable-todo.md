# Codex Home 像素级仿制执行方案

> **For Claude / Codex / other LLM:** REQUIRED WORKFLOW: use `superpowers:subagent-driven-development` and execute this file one checkbox at a time. Do not batch-complete. Only tick a box after code evidence, local verification, and a fresh screenshot comparison.
>
> **Task Type:** 优化现有 Claude Code 已写出的代码，不重写产品，不切换技术栈，不新增组件库。
>
> **Target:** 将当前仓库的首页线程界面收敛到与参考图 1:1 视觉语法高度一致，重点覆盖窗口骨架、左侧边栏、主空态、建议卡、底部输入器、底栏状态信息。

---

## Markdown 引用链接

> [当前基础方案：Codex App 布局对齐执行清单](./2026-03-16-codex-app-layout-alignment-executable-todo.md)
>
> [Apple 半透明侧栏调研](./2026-03-13-apple-translucency-sidebar-research-executable-todo.md)
>
> [统一 Demo 收敛方案](./2026-03-16-unified-ui-ux-demo-reduction-todo.md)
>
> [系统半透明实现方案](./2026-03-16-system-translucency-best-quality-executable-todo.md)

---

## 这次只改什么

- 只对齐参考图对应的首页线程界面。
- 只优化现有结构，不重做主题系统、Tauri 壳层、设置页业务逻辑。
- 允许重排 `AppChrome` / `Sidebar` / `ThreadCanvas` 的结构，但必须复用现有 token、Button、Textarea、ShellButton、app-shell 能力。

## 这次不要做什么

- 不做“更像官网”的自由发挥。
- 不引入渐变、发光、scale、炫技动画。
- 不把页面做成 dashboard、组件展厅、营销落地页。
- 不扩散到设置页大改，除非为了复用首页 header/composer 原语而做极小幅抽取。

---

## 四轮并行调研摘要

### Round 1 - 窗口骨架与标题区

- 当前 `src/components/shell/AppChrome.tsx` 只有共享 drag hotspot，没有参考图那种“主区可见 header 行”。
- 当前源码测试 `src/components/shell/AppChrome.source.test.ts` 还在明确禁止可见 title row，这与目标图冲突，后续必须先改测试边界再改实现。
- `src/components/shell/Titlebar.tsx` 已存在但未被使用，说明仓库里已经有“标题区容器”原型，可优先复用而不是临时拼新层。
- 参考图的主区 header 不是厚标题栏，而是很轻的一行：左侧标题，右侧动作组，仍可兼容 drag region 语义。

### Round 2 - 左侧边栏

- 当前 `src/components/shell/Sidebar.tsx` 已有“新线程 / 自动化 / 技能 + 会话 + 设置”的大方向，但视觉密度仍偏组件 demo 风格。
- 目标图的侧栏更接近 Finder / Codex source list：更轻、更多留白、行高更统一、选中态更弱、信息更靠右侧对齐。
- 当前 `src/lib/sidebar-data.tsx` 的 `threadItems` 结构过于简单，不足以表达目标图中的绿色/红色 diff、时间、置顶段落、文件夹段落、底部计数。
- 当前 `ShellButton nav` 仍偏胶囊按钮，不够像 source list 行，需要收窄按钮感、强化列表感。

### Round 3 - 主工作区空态与建议卡

- 当前 `src/components/content/ThreadCanvas.tsx` 是“开始一个新任务 + 一个按钮 + 底部输入器”，离参考图还差主区 header、中心 icon、项目下拉、三张建议卡、右侧 Explore more。
- 当前空态文案和层级不对：目标图是“开始构建 / study-ui”，而不是“开始一个新任务 / 当前工作区 / 说明文”。
- 当前页面最大宽度 `44rem` 更接近文档流，不足以承载参考图那种横向三卡布局，需要为首页空态单独定义工作区宽度。
- 建议卡应是轻边框、白底、柔和圆角的操作入口，而不是内容卡片体系的延伸。

### Round 4 - Composer 与底栏状态

- 当前 composer 只有 textarea + 一排按钮，没有参考图中的“上层输入区 + 下层状态栏 + 右侧 mic/send”完整结构。
- 当前 `Textarea` 默认样式是输入框组件语言，不是首页大输入器语言，需要在复用原语的前提下给首页 composer 单独收敛层次。
- 当前页面没有底部状态栏信息：本地环境、权限状态、分支名都缺失。
- 目标图的 composer 不是简单表单，而是首页最重的交互锚点，必须先把结构对，再谈细节 spacing。

---

## 目标态定义

- **整体骨架：** 左 280px 左右 source list，右侧白色主工作台，顶部轻量 header，底部大 composer。
- **标题区：** 主区左上显示“新线程”，右上显示动作按钮组与正负统计信息。
- **空态中心：** 居中的品牌图标、主标题、项目名选择器。
- **建议卡：** 三张横向建议卡，位于中心空态下方，卡高一致，文案左对齐，图标位于卡左上。
- **输入器：** 大圆角白色输入器，下边一行工具与状态控制，右侧 mic/send 清晰分区。
- **底栏：** composer 下方存在单独状态信息带，而不是把所有次要信息挤进输入器内部。

---

## 执行范围

- `src/components/shell/AppChrome.tsx`
- `src/components/shell/Sidebar.tsx`
- `src/components/shell/ShellButton.tsx`
- `src/components/content/ThreadCanvas.tsx`
- `src/components/ui/button.tsx`
- `src/components/ui/textarea.tsx`
- `src/lib/sidebar-data.tsx`
- `src/lib/app-shell.ts`
- `src/styles/app.css`
- `src/components/shell/AppChrome.source.test.ts`
- `src/components/shell/Sidebar.source.test.ts`
- `src/components/content/ThreadCanvas.source.test.ts`

---

## Executable Checklist

### Phase 0 - 锁定执行边界与截图比对方式

- [x] 新建一个“首页像素对齐”实施分支或在当前分支上单独提交，不与无关设置页改动混写。
- [x] 明确本次目标是“参考图首页线程页”，不是整个应用全量像素级还原。
- [x] 记录对比口径：优先以 macOS 桌面窗口态、浅色主题、sidebar 展开态、空线程首页为准。
- [x] 执行前先跑一次现有源码测试，记录哪些断言会阻止目标实现，尤其是 `AppChrome.source.test.ts`。
- [x] 建立截图对比流程：每完成一个 phase，都要在相同窗口尺寸下截屏，与参考图并排肉眼核对。

#### 当前执行口径

- 主对比场景：macOS 桌面窗口态。
- 主题：浅色主题。
- 导航状态：sidebar 展开。
- 页面状态：空线程首页。

#### 执行前源码测试基线

- 命令：`node --test --experimental-strip-types src/components/shell/AppChrome.source.test.ts src/components/shell/Sidebar.source.test.ts src/components/content/ThreadCanvas.source.test.ts`
- 结果：17/17 通过。
- 当前会阻止目标实现的旧断言：
  - `src/components/shell/AppChrome.source.test.ts` 仍断言“主区只允许共享 drag hotspot，不允许可见 title row”。
  - `src/components/content/ThreadCanvas.source.test.ts` 仍断言 `max-w-[44rem]` 单列文档流和 `开始一个新任务` 旧空态文案。
  - `src/components/shell/Sidebar.source.test.ts` 仍将当前弱胶囊选中态与旧分组结构固化，需要后续改成 source list 目标断言。

#### 截图比对流程

- 固定窗口口径：macOS、浅色主题、sidebar 展开、空线程首页、窗口宽高保持一致。
- 固定顺序：完成一个 phase -> 运行对应验证命令 -> 启动页面 -> 截图 -> 与参考图并排肉眼比对 -> 如有偏差继续微调。
- 截图命名：按 phase 输出，例：`/tmp/study-ui-home-phase-1.png`。
- 比对重点：header 轻重、sidebar 密度、中心空态垂直位置、三卡宽高间距、composer 与底栏结构。

### Phase 1 - 先把主区 header 结构做对

- [x] 在 `src/components/shell/AppChrome.tsx` 中恢复“可见主区 header 行”，不要再只有不可见 drag hotspot。
- [x] 让 header 同时满足：
  - 左侧标题 `新线程`
  - 右侧动作组
  - 保留可拖拽区域
  - 不破坏 macOS traffic lights / Windows 自定义控件逻辑
- [x] 将主区 header 设计成超轻量一行，不使用厚背景条、不加独立卡片、不加明显分隔条。
- [x] 预留右侧动作组结构位，至少覆盖：
  - 编辑器/环境按钮
  - 提交模式按钮
  - 补充状态图标位
  - 右侧绿色/红色统计位
- [x] 调整 `src/lib/app-shell.ts` 的顶部 offset 计算，确保 header、空态和 composer 的纵向关系接近参考图。
- [x] 更新 `src/components/shell/AppChrome.source.test.ts`，移除“禁止可见 title row”的旧约束，改为断言存在轻量 header 结构。

### Phase 2 - 把 sidebar 从“按钮列表”收敛到“source list”

- [ ] 以参考图为准重排 `src/components/shell/Sidebar.tsx` 的四段层级：
  - 顶部留白与 traffic lights 对应区
  - 主入口区
  - 线程/文件夹分组区
  - 底部设置区
- [ ] 将主入口区文案和图标视觉统一为更接近参考图的轻列表项，不再像按钮。
- [ ] 在 `src/lib/sidebar-data.tsx` 中扩展首页线程数据模型，至少支持：
  - section 类型
  - folder 类型
  - diff 正负数
  - 时间
  - 是否置顶
  - 是否展开
- [ ] 把当前线程项从“标题 + 说明副文案”改成更接近参考图的稠密列表样式：
  - 主标题单行截断
  - 右侧 green/red diff
  - 时间信息右对齐
  - 尽量不出现多余说明句
- [ ] 将选中态从明显胶囊填充降为更弱的 source list 选中行，只保留最轻表面变化。
- [ ] 收窄 `src/components/shell/ShellButton.tsx` 中 `nav` 变体的按钮感，保留可访问性，去掉“像独立按钮”的视觉暗示。
- [ ] 更新 `src/components/shell/Sidebar.source.test.ts`，让测试锁定“source list 结构、分组、底部设置、弱选中态”，而不是旧的胶囊实现。

### Phase 3 - 重做首页空态中心区

- [ ] 在 `src/components/content/ThreadCanvas.tsx` 中将当前空态文案替换为参考图层级：
  - 顶部小图标
  - 主标题 `开始构建`
  - 项目名 `study-ui`
  - 项目名右侧下拉 affordance
- [ ] 删除当前“平台标签 + 解释文案 + 查看建议起点按钮”的表达。
- [ ] 将首页空态容器改为更宽的工作台容器，不再沿用 44rem 的文档列宽。
- [ ] 在中心区下方加入三张建议卡，结构需稳定：
  - 卡片图标
  - 一句任务建议
  - 左对齐文案
  - 三列布局，窄屏自动变单列
- [ ] 在建议卡右上方加入 `Explore more` 与关闭 affordance，保持低存在感。
- [ ] 确保首页空态整体仍然“安静”，不要额外加说明段落、指标、面板标题。
- [ ] 更新 `src/components/content/ThreadCanvas.source.test.ts`，断言：
  - 存在 `开始构建`
  - 存在 `study-ui`
  - 存在三张建议卡语义
  - 不再存在 `开始一个新任务`

### Phase 4 - 重新搭好 composer 主体

- [ ] 将首页 composer 拆成三层：
  - 输入区
  - 输入器内部工具行
  - composer 下方状态栏
- [ ] 保留 `Textarea` 原语，但让首页 composer 使用更贴近参考图的外层容器，不要让 textarea 自己承担所有圆角和背景。
- [ ] 让输入区顶部 placeholder 更靠左上，整体更像工作台输入器，而不是普通表单。
- [ ] 将工具行左侧重排为：
  - `+`
  - 模型选择
  - 强度/模式选择
- [ ] 将工具行右侧重排为：
  - mic
  - 发送按钮
- [ ] 在 composer 下方补一条状态栏，至少包含：
  - 本地环境入口
  - 完全访问权限状态
  - 当前 git 分支
- [ ] 发送按钮允许保留更强对比，但只能通过主色、形状、轻阴影实现，不得加 glow、渐变、scale。
- [ ] 若需要新增首页专用子组件，优先放在 `src/components/content/` 下，避免污染基础 UI 原语。

### Phase 5 - Token 与样式统一

- [ ] 在 `src/styles/app.css` 中补充首页专用语义 token，至少覆盖：
  - sidebar 行高与密度
  - homepage header 高度
  - suggestion card 圆角/边框/阴影
  - composer 宽度/半径/底栏高度
- [ ] 禁止在组件内新增硬编码颜色；继续复用 `background / card / border / muted / interactive-selected` 等语义 token。
- [ ] 将首页相关圆角收敛到规范允许层级，避免出现新的任意圆角。
- [ ] 审查首页所有阴影，保持极轻；如果某层看起来像悬浮卡片过多，就继续减。
- [ ] 保持浅色主题下“白主区 + 浅灰 sidebar + 极轻边界”的基本关系不变。

### Phase 6 - 测试先对齐目标，再做回归验证

- [ ] 更新以下源码测试，使其描述参考图目标而不是旧首页：
  - `src/components/shell/AppChrome.source.test.ts`
  - `src/components/shell/Sidebar.source.test.ts`
  - `src/components/content/ThreadCanvas.source.test.ts`
- [ ] 如有必要新增首页结构测试，锁定：
  - 主区可见 header
  - 中心标题 `开始构建`
  - 三张建议卡
  - composer 下方状态栏
- [ ] 确认测试不会再强制首页退回“单列文档流 + 无 header”的旧结构。
- [ ] 运行源码测试并记录结果。

### Phase 7 - 最终核对与交付

- [ ] 运行 `npm run lint`
- [ ] 运行 `npm run build`
- [ ] 在与参考图接近的窗口尺寸下手动核对以下项目：
  - sidebar 宽度与密度
  - header 位置与重量
  - 中心空态垂直位置
  - 三张建议卡的宽高、间距、描边
  - composer 高度、圆角、底栏信息布局
- [ ] 如仍有明显差距，继续按“截图比对 -> 微调 -> 再截图”的方式收敛，不提前宣称完成。

---

## 给执行 LLM 的硬性约束

- [ ] 你优化的是现有 Claude Code 写出的代码，不是从零重做。
- [ ] 每次只完成一个 checkbox；每勾一项都要留下文件证据。
- [ ] 先改测试边界，再改实现；不要让旧测试把目标实现拉回去。
- [ ] 不新增组件库，不引入 CSS-in-JS，不改技术栈。
- [ ] 不为了“像参考图”而破坏现有 Tauri 窗口行为和跨平台逻辑。
- [ ] 不把 sidebar、suggestion cards、composer 做成厚重卡片 UI。
- [ ] 未验证不得打勾。

---

## 建议执行顺序

- [ ] 1. `AppChrome` header
- [ ] 2. `Sidebar` source list
- [ ] 3. `ThreadCanvas` 空态中心区
- [ ] 4. suggestion cards
- [ ] 5. composer 主体
- [ ] 6. composer 下方状态栏
- [ ] 7. token 收敛
- [ ] 8. 测试与截图复核

---

## 交付完成的判定标准

- [ ] 打开首页时，肉眼第一印象已明显接近参考图，而不是现在的 demo 首页。
- [ ] 主区存在清晰但克制的 header 行。
- [ ] 中间是“开始构建 + study-ui”，不是解释文案。
- [ ] 下方存在三张建议卡。
- [ ] 底部输入器与状态栏结构完整。
- [ ] sidebar 看起来是 source list，不是按钮栏。
- [ ] lint 与 build 通过。
