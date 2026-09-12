# 笔记模块 UI/UX 实测与编辑器底座评估

日期：2026-09-12。对象：deep-student 0.9.59，本地工作区基线 e17ee592；Milkdown/Crepe 7.21.3。

## 1. 决策结论

**先保留 Crepe，修复交互与布局组合；如果明确要把笔记升级为完整的 Notion 式块文档，再优先验证 BlockNote。** Tiptap 是适合深度自定义的第二候选，但它需要自己完成更多产品交互，不是换包就能变好用。

“能用但不好用”的主要原因已经有运行证据：

1. **布局约束失效，操作会命中另一个功能。** 默认资源管理器和学习桌面分屏均复现；其中分屏已验证是容器查询被后写 CSS 覆盖。
2. **宿主面板与编辑器各自管理层级。** 学习桌面的背链面板头部被编辑器工具栏覆盖，资源管理器的属性面板则直接盖住正文。
3. **同名命令有不同结果。** 顶栏“链接”打开地址输入框，命令搜索“插入链接”直接往正文塞入 `https://`。
4. **当前格式、当前文档、当前面板的反馈不统一。** 桌面固定格式栏没有选区状态回显，移动版有；属性入口随宿主换位置；手机标题与工具占用过多首屏空间。

Crepe 自带的产品 UI 不是完整 Notion，但已确认的这些问题主要属于我们的集成层。直接迁移会继续携带布局、命令和数据接线问题，同时新增自定义 Markdown 节点的迁移成本。

## 2. 测试环境、方法与边界

真实应用用 `VITE_DS_UI_BRIDGE=1 npm run tauri dev -- --no-watch --config /tmp/ds-note-audit-config.json` 启动。`--no-watch` 避免并发 Rust 改动反复打断编译；临时配置只用于桥接求值与允许窄窗，没有改仓库 Tauri 配置。没有打开本项目 demo.html、hero.html，也没有用 mock 页面代替产品。

- 桌面：macOS WKWebView，1112×773。
- 移动响应式：同一个真实应用窗口缩至 393×852、375×667；仍是鼠标主输入设备，**不是 iOS/Android 真机测试**。软键盘、触屏长按、中文 IME 连续组合输入、横屏键盘未验收。
- 交互：生产页面按钮/菜单事件、DOM selection、浏览器 `execCommand('insertText')` 触发真实编辑与保存链；还做了原生 macOS 按键检查。未用 `textContent` 直接赋值冒充编辑器输入。原生 `/` 一次被当前中文输入源解释为 `、`，因此本轮不把 slash 是否弹出作为本产品通过/失败结论。
- 重叠：真实窗口截图 + `getBoundingClientRect()` + `elementFromPoint()` 命中测试。桥接的程序化 click 可以绕过遮挡，因此**不能用“脚本点得动”证明用户点得动**。
- 测试笔记：`UX审计-20260912`（`note_mtTTHj5iiv`）和 `UX审计-20260912-分屏`。仅在这些新建测试笔记里写入，不修改既有笔记正文。
- Obsidian：本机 1.12.7，独立 `/tmp/ds-note-obsidian-vault` 与独立用户配置；实际打开、输入、加粗、切换阅读模式并检查 Markdown 文件。没有接触用户原有 vault。
- BlockNote：实际操作官方独立最小编辑器，输入文本、换段、输入 `/` 查看块命令菜单。未测试其完整移动端/协作/持久化。
- Notion：官方产品文档对照；**未登录并实操 Notion 工作区**。其他底座属于文档/许可证调研，未做全部框架运行测试。

本次交付是研究与改进方案；没有改动生产笔记代码，没有声称已经修复。

## 3. 三个场景的实际表现

| 场景 | 正常走通 | 已观察到的问题 | 设计方向 |
| --- | --- | --- | --- |
| 资源管理器 | 空白处右键新建；重命名；正文输入；选区加粗；自动保存；重新打开仍有内容 | 320px 应用侧栏 + 约 200px 资源列表挤压编辑器；固定工具栏互相覆盖；属性浮层遮住标题/正文 | 文件列表负责找文件，打开后复用统一编辑面；窄宽度允许收起列表，属性显式切页或分配空间 |
| 学习桌面 | 搜索测试笔记并打开；标签页；第二篇笔记；右侧分屏与退出分屏；命令能作用到右侧编辑器 | 分屏重复出现工具栏覆盖；背链头部被正文工具栏覆盖；打开背链会自动收起资源树；同名插链接命令行为不同 | 工作台只管理窗口、导航、分屏；笔记层统一管理内容工具与上下文面板 |
| 移动响应式 | 笔记打开/返回；底部插入展开；插入表格；撤销表格；属性子页进入/返回；属性页隐藏底部工具条 | 顶栏标题、标签页标题、正文标题重复；编辑内容约从 y=287 开始；工具栏横滚，部分命令初始在视口外；开发悬浮件盖住底部按钮 | 单页编辑，移除单文档时的重复标签条；正文标题为主；次要动作收进更多菜单；真机另验键盘/选区 |

移动端并非“四套工具栏同时显示”：代码和实测都确认 `.notes-editor-toolbar` 与 Crepe 内置选区格式气泡在窄屏/触屏笔记壳中隐藏。需要保留这部分已有的正确设计。

## 4. 已复现问题与根因

### F1 / P1：资源管理器和分屏的工具栏会点错功能

**复现 A：** 1112×773 → 学习资源 → 全部文件 → 空白处右键新建笔记，保留应用侧栏与资源列表。

| 想点的按钮 | 按钮矩形，CSS px | 中心点实际命中 |
| --- | --- | --- |
| 链接 | x=846.94, y=84.25, w=24.5, h=24.5 | 生成卡片 |
| 双链引用 | x=881.44, y=84.25, w=24.5, h=24.5 | 笔记模板 |
| 折叠块 | x=932.44, y=84.25, w=24.5, h=24.5 | 询问 Agent |

**复现 B：** 学习桌面笔记 → 打开两篇测试笔记 → 标签页右键 → 在右侧分屏打开。两侧 chrome 实测宽 551.5px，内联格式栏计算样式仍是 `display:flex`；“链接”中心命中“格式化”。

根因定位：

- [CrepeEditor.css:1417](/Users/heli/code/deep-student/src/components/crepe/CrepeEditor.css:1417) 的 `@container notes-chrome (max-width:560px)` 先写 `display:none`；后面 [同文件:1432](/Users/heli/code/deep-student/src/components/crepe/CrepeEditor.css:1432) 同优先级基础规则重新写 `display:flex`。
- 实验：只在真实页面末尾临时追加完全相同的容器查询，两个分屏的计算值立即都变为 `none`。随后移除临时样式。这验证了 CSS 顺序因果，尚未落修复。
- Finder 宿主 chrome 约 588px，560px 阈值本身也覆盖不到；所以**只挪规则顺序不足以解决全部场景**。
- [NotesEditorToolbar.tsx:320](/Users/heli/code/deep-student/src/features/notes/components/NotesEditorToolbar.tsx:320) 已尝试用横滚处理溢出，但实际 flex 分配仍让内联按钮画到生成卡片/更多操作区域。需要约束可滚动区域获得的宽度，而不只是给子项加 overflow。

改进：先修 cascade 顺序，再让格式区占用“扣除右侧固定动作后”的剩余宽度，窄宽度收进现有格式菜单。验收应检查按钮中心与边缘命中、菜单是否仍可达，不能只截一张宽屏图。

证据：[Finder 工具栏](assets/notes-ux-audit-20260912/finder-toolbar-overlap.png)、[学习桌面分屏](assets/notes-ux-audit-20260912/workbench-split.png)。

### F2 / P1：学习桌面背链面板被编辑器工具栏压住

**复现：** 默认窗口打开测试笔记 → 左侧“属性与链接”。右侧属性/链接/图谱页签位于 y=79～118；正文工具栏按钮位于 y≈83～110，在同一条横带上。截图中页签文字被工具按钮覆盖；页签中心命中编辑器按钮。右上刷新/关闭区域也受上层覆盖影响。

根因：[NotesWorkspaceApp.css:484](/Users/heli/code/deep-student/src/features/workbench/apps/notes/NotesWorkspaceApp.css:484) overlay `z-index:6; top:0`；[NotesCrepeEditor.tsx:2004](/Users/heli/code/deep-student/src/features/notes/NotesCrepeEditor.tsx:2004) 编辑器头部 `sticky top-0 z-10`。当前组合没有把编辑器的层级限制在自己的区域内。

还有一个可解释但突兀的行为：[NotesWorkspaceApp.tsx:1812](/Users/heli/code/deep-student/src/features/workbench/apps/notes/NotesWorkspaceApp.tsx:1812) 在 overlay 条件下打开背链会自动关闭资源树。用户只是看关联信息，左侧导航却随之消失；关闭背链后也需要重新找回导航。

改进：先隔离编辑器内部层叠上下文，保证打开面板时其头部与关闭按钮完整可点；随后把“宽屏并排、窄屏明确切换”的策略统一到两种宿主。不要只把 z-index 调成更大的魔法数字。

证据：[背链面板重叠](assets/notes-ux-audit-20260912/workbench-backlinks.png)。

### F3 / P1：同名“插入链接”有两套语义

**真实命令路径：** 聚焦右侧测试笔记 → 顶部“搜索应用与命令” → 搜索“插入链接” → 执行。结果只在右侧正文添加 `<a href="https://">https://</a>`；不是地址填写流程。刷新并恢复桌面后，这个占位链接仍存在，说明它进入了保存链。

**顶栏路径：** 非分屏且按钮可见时点击“链接”，会出现 `Paste link...` 地址输入框；填写地址后可以生成链接。该输入框仍是英文，与周边中文不一致。

根因：[NoteContentView.tsx:888](/Users/heli/code/deep-student/src/features/learning-hub/apps/views/NoteContentView.tsx:888) 给命令写死 `insertLink('https://','')`；[CrepeEditor.tsx:1435](/Users/heli/code/deep-student/src/components/crepe/CrepeEditor.tsx:1435) 的无参数 `insertLink()` 才走 LinkTooltip。Workbench 命令转发复用了这条路径。

改进：命令搜索、固定工具栏、移动插入栏统一调用现有的交互式插链入口。已有 `notes.commands.ts` 与 Editor API，不需要再造第二套命令注册系统。保存 selection 并明确点击后焦点落点；合法地址未填写时不要改正文。

相邻图片命令同样写死 `insertImage('https://','')`，**属于已确认的代码接线风险，未完成图片选择/上传/失败恢复全链路实测**，不把它写成已复现的上传故障。

### F4 / P2：资源管理器属性面板覆盖正文，而非分配空间

默认编辑面左边界约 x=523，正文 x≈565～1069。打开属性后面板约 288px 宽，占据右半部分，标题、正文长行在其下方被遮住。面板本身可打开/关闭，这属于空间与任务切换问题，不是“属性功能未实现”。

代码：[NoteContentView.tsx:1005](/Users/heli/code/deep-student/src/features/learning-hub/apps/views/NoteContentView.tsx:1005) 为 absolute `top-12`（48px）、right/bottom 12px、z30；没有从正文布局中扣除宽度。

改进：有足够正文宽度时并排；宽度不足时属性作为明确子页/抽屉，打开后不暗示背后的正文仍是完整可操作编辑面。复用移动端已经存在的属性子页，而不是为每个宿主造一种面板。

证据：[属性遮挡](assets/notes-ux-audit-20260912/finder-properties.png)。

### F5 / P2：桌面与移动端的格式状态反馈不一致

选中 `audit bold test` 点击粗体后真实正文出现 `<strong>`，动作成功。但固定顶部“粗体”没有 `aria-pressed`，实现只有 hover/按下态，没有根据 selection 更新的持续 active state。Crepe 自带气泡能显示格式状态；移动工具栏也已有 active states。

根因：[NotesEditorToolbar.tsx:339](/Users/heli/code/deep-student/src/features/notes/components/NotesEditorToolbar.tsx:339) 只消费动作和 disabled，没有消费当前 mark/node 状态。

改进：复用已有编辑器 selection 状态，把固定栏、移动栏和菜单的 active/disabled 状态对齐。切入标题、列表、链接、只读、未就绪状态时，用户都应能判断“现在是什么”和“按下会发生什么”。

### F6 / P2：移动首屏信息层级过重；开发悬浮件影响实测

393×852 下：顶栏 56px、标签页约 38px、操作栏约 46px，正文标题起点约 y=168，正文编辑区 y=287。375×667 保持相同的顶部支出。底部展开插入栏后再占约 100px；此时还未出现手机键盘。

这不证明键盘一定遮挡，但说明小屏有效写作面积已经很有限。移动版本应减少壳层：单文档不重复标签页，标题不在三个地方同权重出现；模板/Agent/查找等次要动作集中到更多菜单。长文写作时允许收起元信息。

底部格式按钮是横滚设计：44px 命中区是优点，但 H2 及后续命令初始位于视口之外，需要有滚动可发现性。dev 环境的恢复 FAB/调试球会压在 H1/H2 附近，375×667 时更明显。**这是开发环境污染，不应冒充 release 产品故障**；它同时说明开发悬浮件不能参与正式 UX 验收。

证据：[393px 编辑](assets/notes-ux-audit-20260912/mobile-393.png)、[375px 插入表格](assets/notes-ux-audit-20260912/mobile-375-table.png)。

## 5. 正常项与未确认项

正常项：真实新建与改名、正文输入、加粗、自动保存、跨宿主重新打开；移动插表格后撤销；属性进入/返回与底栏隐藏；Workbench 两篇笔记分屏/退出；命令插链只作用到聚焦右窗，没有发现本次命令同时污染两个文档。

保存补充：第一次“改标题后立即写正文”出现过一次 OCC conflict 日志，随后页面恢复已保存，跨视图读取保留正文。现有实现有保存队列、flush 与冲突处理，不能得出“没有可靠保存机制”或“已经发生正文丢失”。另一次在填链接后立刻脚本 reload，最后一个未等保存的链接没有恢复；本轮没有完成原生关闭/退出的 flush 验收，**保存中刷新、关窗、多窗口冲突仍需独立验证**。

未确认：桌面自定义“引用到聊天”浮条与 Crepe 气泡是否同时遮挡。本轮 selection 操作只稳定显示 Crepe 气泡，不能把“两组件都挂载”写成已复现重叠。AI 续写/改写、Anki 生成、图片上传、数学、toggle/wikilink 往返、长文窗口化、附件导出、离线与双窗口冲突也没有全量跑完。

因此，本报告确认了具体坏路径，并不宣称完成所有功能与设备的验收。后续测试应围绕这些未决路径补齐，避免再把整仓库扫一遍当作验证。

## 6. 为什么 Notion / Obsidian 更容易让人觉得顺手

| 维度 | Notion（官方文档对照） | Obsidian（隔离库实操 + 官方文档） | 当前实现的差距 |
| --- | --- | --- | --- |
| 核心对象 | 页面里的块；块有稳定的新增、移动、转换入口 | Markdown 文件；Live Preview/Source 与阅读视图职责明确 | UI 混用文件、页面、块、资源对象，入口分散在宿主/编辑器两层 |
| 插入与变换 | `+`、块手柄、slash 菜单承担明确职责；选区操作修改文字 | Markdown 输入与快捷键直接反映到文件 | 同名链接命令竟有不同结果，比少一个高级功能更损害信任 |
| 空间与导航 | 页面和上下文面板围绕当前任务组织 | 文件树、标签页、面板形成稳定工作区 | Finder、Workbench、移动各套布局规则组合后有真实冲突 |
| 格式反馈 | 选区工具提供上下文动作 | 光标所在区域可见 Markdown 语法，阅读切换结果可检查 | 固定顶部栏没有格式 active state，别的工具条却有 |
| 移动策略 | 官方说明移动没有 hover/slash，改用键盘上方工具条与更多菜单 | 文件模型延续，但本次未实测手机 App | 已有独立底栏，但仍携带桌面标签层与太多常驻操作 |
| 扩展和数据 | 块文档丰富，导出不等同完整内部模型 | Markdown 是可直接检查的本地文件 | 正文存 Markdown，外部期望却接近任意 Notion 块，需要明确哪些结构能无损保存 |

Obsidian 实操中，输入、Cmd+B、Cmd+E 后可以检查到文件中的 `**...**` 与阅读渲染对应；截图：[Live Preview](assets/notes-ux-audit-20260912/obsidian-live-preview.png)、[阅读视图](assets/notes-ux-audit-20260912/obsidian-reading.png)。它也会重复显示文件名，不应把“标题出现多处”单独当作所有场景的缺陷；问题在于小屏上的累计占高和动作优先级。

可借鉴的其他产品方向：Joplin 的笔记本/编辑职责，Logseq 的大纲块引用，AFFiNE/BlockSuite 的文档与画布。这些是不同定位，不能把功能并集全部加进我们的默认写作界面。本轮没有实际操作这三个产品。

建议产品定位：**面向学习的 Markdown 笔记工作区，提供少量一致的块交互；AI 引用、双链和学习材料协同是特色。** 如果未来确定需要嵌套块 ID、任意块属性、数据库视图与协作，应正式改变文档模型，而不是不断把复杂结构塞进 Markdown 扩展语法。

## 7. 开源底座比较

| 方案 | 可复用能力与许可 | 对本项目的实际代价 | 建议 |
| --- | --- | --- | --- |
| Milkdown/Crepe | Markdown 导向；现成 PM 插件、slash/表格/图片/数学；MIT | 已有插件、AI diff、保存接线可保留；需精简默认 UI 并修宿主组合 | **近期首选**。允许关闭/定制 Crepe feature，不必整套默认 UI 再叠一套 |
| BlockNote | React 块编辑产品组件；slash、拖拽、块菜单；core MPL-2.0，XL 包另有 GPL-3.0/商业许可 | `blocksToMarkdownLossy` 明确是有损导出；自定义 toggle/callout/wikilink、资源引用必须验证；若以块 JSON 为真源需改存储与 AI 接口 | **完整块体验优先时第一原型候选**，不能当作无损 Markdown 替换件 |
| Tiptap | ProseMirror 扩展框架，core MIT；官方 Markdown 扩展已有自定义 tokenizer/parse/render；商业服务与部分产品资源另论 | UI、块手柄、菜单、状态与移动适配仍需产品层建设；与现有 PM 概念接近，但扩展 API 不同 | **深度定制第二候选**。不要用“没有 Markdown 支持”淘汰，也不要低估建设成本 |
| Plate | Slate/React 编辑器及丰富插件/UI，根仓库 MIT，具体子包/付费模板单独看 | 不是从零搭所有 Notion UI，但要更换现有 PM 插件栈；自定义语法与保存往返需重做 | 已有强 Slate 经验时可考虑，本项目暂排后 |
| BlockSuite | block/canvas、协作与本地优先方向，MPL-2.0 | 数据/渲染/协作架构跨度较大，当前自定义 Markdown 与窗口化逻辑难直接搬 | 要做 AFFiNE 式工作区时研究，非近期替换 |
| Lexical | MIT，编辑器基础设施，可扩展 | 仍要补产品菜单、Markdown 扩展、移动交互等；低层更换不解决宿主 UX | 本项目当前不优先 |
| Vditor | MIT，Markdown 所见即所得/即时渲染/分屏模式 | 对 Markdown 写作合适，但不天然提供本项目所需的完整块文档和现有 PM 插件兼容 | 若产品转向纯 Markdown 写作可验证 |

Obsidian 和 Notion 本体均不是可直接采用的开源嵌入底座；参考其交互不能等同于嵌入其产品。许可证结论是技术筛选信息，不替代最终依赖清单核对。

### 迁移真正贵在哪里

当前正文在 `resources.data`，是 Markdown 字符串；元数据另存（[note_repo.rs:3](/Users/heli/code/deep-student/src-tauri/src/vfs/repos/note_repo.rs:3)）。已有自定义 wikilink、callout、`> [!toggle]-`/`> [!toggle]`，还关联 AI 改写、图片资源、窗口化长文、搜索、导入导出和跨窗口保存。

新底座必须回答：这些结构导入后是什么节点？保存后还能回到原文语义吗？AI 修改哪种表示？引用与资源 ID 是否仍稳定？未支持节点怎么展示与保留？这比首页外观是否像 Notion 更能决定总成本。

不要同时维护 Markdown 和块 JSON 两个互相可写的真源。短期保持现有 Markdown；只有 BlockNote 原型证明块模型的收益值得迁移，才明确 JSON 真源与 Markdown 导出边界。

## 8. 怎么改：按可验收切片推进

### 第一批：修确定故障，恢复可预测性

1. **工具栏空间**：修容器规则顺序与 flex 宽度分配，复用现有溢出菜单。覆盖默认 Finder、Workbench 单窗、左右分屏、375/393px；每个可见按钮命中自身，所有被收起动作仍有入口。
2. **面板层级**：编辑器内部层级局限在编辑面；背链页签和关闭按钮完整可点。资源管理器与 Workbench 共用明确的面板开关/空间策略，避免打开右栏偷偷改变左栏却没有恢复路径。
3. **命令语义**：修现有 `insertLink`/图片命令路由，统一顶栏、命令搜索和移动插入；无有效输入时不写占位正文。统一 selection active/disabled 反馈与文案。
4. **保存边界验证**：新建后改名立即输入、保存中切页/关窗、同篇笔记双窗编辑、失败重试分别跑真实路径；记录最终持久化结果。现有队列和 OCC 先复用，有证据再修改。

### 第二批：把写作界面减到一个主任务

- 桌面：保留一条简洁的页面操作栏；文字格式归同一套选区/格式菜单；块新增/转换/移动归同一套块入口。把“引用到聊天”并入当前选区操作，而不是另起一个争抢定位的气泡。
- 移动：单文档去重复标签条，缩减标题元信息占高；常用格式与插入共用一个键盘上方入口，其余进更多。真机验证 IME、不唤起键盘的阅读、键盘开合、选区手柄、返回与横屏。
- 默认不同时展示文件导航、标签筛选、收藏、灵感、完整格式栏、AI 操作、属性、背链和图谱。按当前任务渐进展示，保留一条明确的找回入口。
- 不增加新的命令总线/状态管理框架。先合并已有命令转发、复用编辑器 API 和选择状态；只有真实重复逻辑无法在现有边界解决时再抽取。

### 第三批：两个短原型决定是否换底座

只比较“修好集成后的 Crepe”与“BlockNote”；如果自定义能力不够，再加入 Tiptap。使用同一份包含中文、列表、表格、公式、图片、双链、callout、toggle 的测试笔记。

| 必须通过的路径 | 看什么结果 |
| --- | --- |
| 输入、选区、加粗、撤销/重做、块转换 | 光标稳定；动作可预测；一次撤销恢复一次用户操作 |
| 两个宿主、两个编辑窗、分屏切换 | 工具只作用到当前编辑器；无相互遮挡；未保存状态可解释 |
| 手机真机 + 中文 IME | 不丢组合输入；菜单不偷键盘焦点；光标与操作可见 |
| 自定义节点导入、编辑、保存、重开、导出 | 不丢语义/资源 ID；不支持结构有明确保留策略 |
| 大型真实笔记与 AI 外部更新 | 测输入延迟和保存延迟；撤销、selection、更新合并可用，不凭框架宣传判断 |

**换底座的条件**：BlockNote 在上述路径中明显减少我们需要维护的交互代码，同时数据往返、许可与真机体验可接受。若仅最小 demo 更漂亮，而迁移需要重新补齐同样多的宿主逻辑，就继续 Crepe 并定制其 UI。

## 9. 一手资料

以下均为本轮访问的官方文档或官方仓库；产品描述与实操边界见第 2 节。

- [Notion：Writing & editing basics](https://www.notion.com/help/writing-and-editing-basics)
- [Obsidian：Views and editing mode（官方帮助源码）](https://github.com/obsidianmd/obsidian-help/blob/master/en/Editing%20and%20formatting/Views%20and%20editing%20mode.md)
- [Milkdown：Using Crepe](https://milkdown.dev/docs/guide/using-crepe)
- [BlockNote：官方最小编辑器，本轮实操](https://www.blocknotejs.org/examples/basic/minimal)
- [BlockNote：Markdown export，有损说明](https://www.blocknotejs.org/docs/features/export/markdown)
- [BlockNote：许可证及 XL 范围](https://github.com/TypeCellOS/BlockNote/blob/main/LICENSE.txt)
- [Tiptap：Markdown](https://tiptap.dev/docs/editor/markdown)、[MIT License](https://github.com/ueberdosis/tiptap/blob/main/LICENSE.md)
- [Plate：官方仓库](https://github.com/udecode/plate)、[LICENSE](https://github.com/udecode/plate/blob/main/LICENSE)
- [BlockSuite：官方仓库](https://github.com/toeverything/blocksuite)
- [Lexical：官方仓库](https://github.com/facebook/lexical)
- [Vditor：官方仓库](https://github.com/Vanessa219/vditor)

## 10. 测试结束后的工作区状态

开发应用继续运行，窗口恢复 1112×773，并通过产品菜单恢复测试前的经典模式。两篇带 `UX审计-20260912` 前缀的测试笔记保留用于复现；截图与本报告单独落盘。生产代码未改动，他人的未提交文件未纳入本次交付。
