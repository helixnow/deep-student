# Todo 与模板管理 — 改造质量评审（v0.9.44 → origin/cursor/0824-cde6 @ 2d41ea8b）

范围：`src/features/todo/**`、`src/features/template-management/**`、workbench 侧的 `TodoAppWindow` / `TemplatesAppWindow`、`todoDriver`、agent 工具（`todo-tools` / `user-todo-tools` / `template-designer`）、模板编辑器组件（`MinimalTemplateEditor` 等）及对应 locale 与测试。相关提交约 61 个，净变化约 +1530/-390 行，其中约六成是移动端 44px 触控热区的机械补丁。`src/dstu/__tests__/emptyResourceTemplates.test.ts` 虽名带 template，实为 DSTU 资源默认名 i18n，不属本域，不评。

## 总体判断

**变好为主，且好得比较扎实**：本轮在这一域修掉了五个真 bug（详见下节），每个都有对应测试锁定，且注释把「为什么这样写」讲得异常清楚。变乱的一面集中在实现手法而非架构：触控热区用了至少五种写法散布在 30 个文件里、`!important` 泛滥、保活可见性守卫三行样板复制了 9+ 处、窗口聚焦门禁逻辑三处近似重复——同一问题被手工修了 N 遍而没有沉淀成机制。功能语义没有变乱，工程卫生有欠账。

## 相对旧版的实质改进

### 真 bug 修复（最有价值的部分）

1. **热键跨窗抢键**（`todoShellNav.ts`，c7145b1d）。旧版 ⌘/Ctrl+1..8 的消费资格只看宿主可见性——workbench 桌面上只要开着一扇待办窗（即使未聚焦），就会截走命令面板的 mod+1（跳智能对话）等全局导航键。新版给 workbench 承载加了 `data-focused` 聚焦门禁，legacy 承载不受影响。头注释把与命令面板的捕获阶段优先级约定写成了明文（「待办上下文内数字键属于待办视图切换，宿主无资格时完全放行」），并新增 `todoShellNav.test.tsx` 锁定门禁矩阵四象限。这是设计债转成明文契约的范例。

2. **窗口内列表快捷键失效**（`TodoMainPanel.tsx`，99b9e77a，标注 P0）。旧版 j/k/Space/Enter 等快捷键硬性要求 `currentView === 'todo'`，workbench 窗口化承载下 currentView 恒不为 'todo'，快捷键整体哑掉。新版按承载环境分流：窗口化要求「本窗聚焦 + 事件发生在窗内」。`TodoMainPanel.test.tsx` 新增 5 个用例覆盖了包括「窗外事件不响应」「未聚焦窗不响应」在内的边界。

3. **共享 viewId 顶栏配置互踩**（`TodoContentView.tsx`）。窗口化实例与独立视图共用 `'todo'` viewId，旧版窗口实例也会写入 `useMobileHeader` 配置并在卸载时误清缓存（汉堡菜单挂错实例、失灵）。新版把 `inWorkbenchWindow` 改为三态（null=未检测），配合 `useMobileHeader` 的 `enabled` 参数，保证窗口化实例连首帧都不写入。修复正确，且依赖 useLayoutEffect 链在绘制前完成的时序论证写在注释里，可复核。

4. **保活层吞返回键**。todo / 模板管理视图在 ViewLayerRenderer 隐藏保活层里保持挂载（visibility:hidden），旧版滞留的详情浮层、勾选模式、日历、标签建议、导入面板、编辑器脏检查会继续消费 Android 返回键，甚至给不可见的编辑器弹脏检查确认。新版在 9 处 back handler 里加了「isConnected + getClientRects + computed visibility」守卫。方向正确，实现方式见下文批评。

5. **todoDriver 回执的字符串嗅探**。旧版用 `u.includes('user_todo')` 嗅探回执内容判断是否出现过不支持的 op——文案一旦本地化就会失灵。新版引入 `sawUnsupported` 布尔标志，同时把全部用户可见错误文案迁到 `todo:agent.*`（zh/en 双语补齐，`defaultValue` 兜底 namespace 异步加载窗口期，语言可运行时切换故用函数不用模块级常量）。`todoDriver.i18n.test.ts`（9 用例）用 key-echo mock 断言与语言无关。小而精确的改造。

### 可用性改进

- **模板导入失败可读化**（6d76b876）：前端先行 `JSON.parse`，语法错误不再送后端；`classifyTemplateImportError` 纯函数按信号词把 serde/fs 原始报错归为 permission / not_template / invalid_json 三类，UI 给「怎么办」级主文案 + 原始报错降为技术细节附注。归类词表有单测锁定（含优先级：权限 > 结构 > 语法）。旧版直接把 `missing field \`front_template\` at line 1 column 20` 甩给用户，这是实打实的体验提升。
- **⌘F 聚焦模板搜索 + 键盘接力**：TemplatesAppWindow 捕获阶段消费 ⌘F（门禁同快捷键范式），TemplateToolbar 新增 ↓/Enter 把焦点交给第一张模板卡接入既有 roving 导航（`data-template-item` 旧版已有），Esc 清空搜索且带 IME composing 守卫。链路完整。
- **模板编辑器小屏返回语义统一**：顶栏返回箭头与 Android 系统返回共用 `handleEditorBack`（左/右屏先回中屏，中屏才走脏检查退出），选择模式小屏顶栏直接作「返回制卡」出口。旧版两条路径行为不一致。
- **JSON 预览入口恢复**：`onOpenJsonPreview` 从 `_` 前缀弃用参数恢复为侧栏项 + workbench 导航按钮 + 移动抽屉行三处入口。
- **iOS 防自动放大**：模板工具栏搜索/排序 select 从 13px 升 16px，AutomationScheduleEditor 输入框 coarse 下同步升 16px，均带原因注释。
- **TodoAppWindow 侧栏宽度持久化修正**：仅 wide 档提交才写 localStorage，防止 medium 档 300px cap 钳过的值污染用户宽窗偏好；用 `sizeClassRef` 避开 stale closure。取舍合理（代价是 medium 档刻意调宽不被记住，注释已说明是有意的）。

### agent 工具 schema 精简

`todo-tools` / `user-todo-tools` / `template-designer` 三个技能的描述文本大幅压缩（user-todo-tools 恰好 67/67 行进出，纯文案替换）。核对结果：**无信息净损失**——删掉的「【必填】」「每页最多 20 条」「默认 50，最大 200」等在 machine-readable 的 `required` / `maximum` / `default` 字段里仍在；`template_create` 描述改为引用技能说明的「模板结构说明」章节，该章节确实存在；高危工具 `user_todo_delete_list` 的 ask-user 确认要求与「不得记住授权」原文保留。精简克制，是合格的 token 优化。

## 缺陷与风险

1. **导入错误信号词嗅探注定漂移**。归类依赖 serde/V8 的英文措辞（`missing field`、`unexpected token` 等），后端 serde 升级或报错措辞变化会静默退化为 `unknown`——降级路径是旧版原始文案，安全但功能失效无感知。词表新增靠人肉，测试只锁定现有词。根治方案是后端返回结构化错误码（serde error kind → Tauri command error enum），前端不猜。当前实现作为过渡可接受。
2. **触屏行尾按钮的交互决策混在热区补丁里**。`TodoItemRow` 的 Play/Trash 按钮从「coarse 隐藏（走滑动手势）」改为「opacity-60 常显 + 44px」，这是交互设计变更而非热区修补，却埋在 "enlarge leftover ItemRow hit" 这类机械提交流里，回溯困难。且 44px 行高里塞 checkbox + 标题 + 两个 44px 常显按钮，窄触屏下标题可用宽度被明显挤压（有 min-w-0 truncate 兜底，不算 bug，但值得设计侧复核）。
3. **⌘F 覆盖不全**：快捷键 handler 只挂在 TemplatesAppWindow，legacy/独立模板页（Anki 制卡内嵌形态）同一工具栏没有 ⌘F。不是回归，是新功能覆盖面缺口。
4. **保活守卫存在两套可见性判定标准**：todoShellNav 的 `isElementVisible` 查 offsetParent 链 + display/visibility，back handler 守卫查 `getClientRects().length + computed visibility`。两者对 `display:none` 祖先、`content-visibility` 等边界的行为不完全等价，目前各自场景下都对，但没有任何机制阻止下一个人混用。
5. **格式破损**：`TodoItemRow.tsx` 第 976 行附近 Play 按钮的 `className` 行缩进错位（8 空格顶格混在 10 空格属性列表里）。纯格式，但说明这批机械补丁没有统一过 formatter，同类损伤可能不止一处。
6. **TodoContentView 顶栏 deps 略糙**：`useMobileHeader` 依赖数组扩到 10 项，`automationRefreshing` / `automationCapacityFull` 在非 automations 视图变化也会触发无意义的 setConfig 重写。无害（写操作幂等）但反映配置对象整体重建的粗放。容量门禁 `max > 0 && count >= max` 在顶栏与工作区各算一份，靠注释约定同步，宜下沉为 store 派生值。

## 变乱的地方（模式性问题）

**触控热区是本轮最大的「同一问题手工修 N 遍」现场**。约 20+ 个 "enlarge leftover … hits" 提交、200+ 处 `[@media(pointer:coarse)]` 类名，同一个 44px 目标至少五种实现：`!min-h-11`、`h-11 w-11`、`after:` 伪元素外扩、`p-3.5 -m-3.5 box-content` 透明外扩、CSS 文件里 `min-height: 44px`。大量 Tailwind `!` 前缀硬压 DsButton 内部尺寸。每处选择都有注释解释原因（伪元素避免热区互相覆盖、负 margin 保布局、min-h 压过 lg: 档固定尺寸……），说明作者清楚自己在做什么——但正确的解法是给 DsButton 加 coarse 档的默认 min 尺寸（或一个 `touchTarget` prop / 全局 utility），一次性覆盖 90% 场景，剩下 10% 特殊布局再散点处理。现在的形态下，任何新增按钮都默认不达标，"leftover" 会永远修不完。旧版其实已有零星 `pointer:coarse` 40px（2.5rem）写法，本轮把标准提到 44px 却没有趁机收敛机制，是错过的窗口。

**三行保活守卫样板复制 9+ 处**（TodoMainPanel×2、TodoItemDetail、TodoItemRow、TagsEditor、TemplateManagementApp×3、TodoTrashDialog，另有跨域同款）。每处都带一段几乎相同的注释。该抽 `isEffectivelyVisible(el)` 到共享 util——漏写一处就是回归吞返回键 bug，且这种漏写 lint 抓不到。

**窗口聚焦门禁三处近似重复**：todoShellNav 的 `isHostWindowFocused`、TodoMainPanel 的 handleKeyDown 内联判定、TemplatesAppWindow 的 ⌘F handler，都是 `closest('[data-wb-window]') + data-focused (+ scope.contains(target))` 的变体。这是 workbench 快捷键的通用契约，应由 workbench 侧导出一个 helper（甚至和既有 `isShortcutGuardedEvent` 放一起），而不是每个 app 各抄一份。

## 优化空间（按性价比排序）

1. DsButton / SegmentedControl 内建 coarse 触控目标（全局 CSS 一条规则起步），随后批量删除散点 `!min-h-11`——收益是消灭一整类 leftover。
2. 抽 `isEffectivelyVisible(el)` 共享 util，back handler 守卫统一走它；与 todoShellNav 的 `isElementVisible` 合并或明文区分适用场景。
3. workbench 导出窗口聚焦门禁 helper，todoShellNav / TodoMainPanel / TemplatesAppWindow 三处收敛。
4. 后端模板导入返回结构化错误码，替换前端信号词嗅探。
5. 自动化容量门禁下沉为 `useAutomationStore` 派生 selector，顶栏与工作区共用。
6. 补 TemplateToolbar 搜索接力与 TemplatesAppWindow ⌘F 的测试（当前只有纯函数层有测试，交互层裸奔）。

## 验证情况

本域 4 个新增/扩充测试文件（`todoShellNav.test.tsx`、`TodoMainPanel.test.tsx`、`todoDriver.i18n.test.ts`、`templateLibrary.viewModeAndImportError.test.ts`）本地实跑 27 用例全部通过。测试选点准：全部对准本轮修复的行为契约（门禁矩阵、快捷键作用域、i18n key、归类词表），而非凑覆盖率。
