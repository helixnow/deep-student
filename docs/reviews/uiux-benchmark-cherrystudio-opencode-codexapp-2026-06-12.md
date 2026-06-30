# UI/UX 对标调研：Cherry Studio / OpenCode / Codex App（2026-06-12）

> 目的：充分调研三款 AI 桌面/终端产品的 UI/UX 设计，结合 DeepStudent（Tauri 2 + React 18 学习应用）现状，提炼可借鉴的设计点。
> 信息截至 2026-06：Cherry Studio v2 分支重构中；OpenCode v1.15.x（桌面版已由 Tauri 迁移 Electron）；Codex App 2026-02 发布 macOS 版、2026-03 发布 Windows 版、2026-04 大版本更新。

---

## 一、Cherry Studio：全能 AI 客户端的"工具箱"路线

**定位**：开源跨平台 LLM 桌面客户端（Electron），主打多模型聚合、知识库、300+ 预配置助手、MCP 扩展。日活百万级，GitHub 47k+ stars。

### 1.1 信息架构
- **左侧图标导航栏**（可配置顶部/左侧、可隐藏排序）：助手、智能体、绘画、翻译、小程序、知识库、文件等一级功能。
- **聊天页三栏**：助手列表 + 话题（topic）列表（位置可配左/右）｜消息流｜设置面板。话题有自动命名、创建时间显示、"点击助手自动切换话题"等细节开关。
- **助手（Assistant）= 预设角色 + 模型 + 提示词**，话题挂在助手下。内置 300+ 助手 + 助手市场（法律/医疗/教育等垂直领域）。
- **小程序（Mini Apps）**：内嵌常用 AI Web 工具的启动台（Launchpad 网格 + 搜索）。
- **快捷助手**：全局快捷键呼出的系统级悬浮窗，在任意应用中划词翻译/摘要/润色；划词选择助手（Selection Assistant）系统级取词。

### 1.2 v2 设计系统（DESIGN.md 摘要，2026-04 起）
Cherry v2 用一份 DESIGN.md 作为"设计契约"，要点：
- **Neutral-first / Calm UI**：界面底色纯中性灰，`--color-primary` 只用于真正的主操作/选中态/链接；语义色（destructive/success/warning/info）只承载状态反馈；明令禁止页面局部引入品牌色。"像 iA Writer 遇上 VS Code——屏幕上最鲜艳的应该是用户的内容"。
- **中性色走 alpha、彩色走实色**：文本/边框/悬浮填充一律黑白 + 透明度（自动适配任何表面）；品牌/状态色用实色 oklch 階梯（任何背景上保持身份）。
- **深度靠表面色分层而非阴影**：background → card → popover 逐层变亮；阴影只留给"悬浮反馈"和"漂浮元素"。
- **组件级硬性契约**：
  - `PageHeader` 强制统一（32px 高、pl-5 与菜单图标列对齐、左右两栏标题自动对齐），禁止手写 `<h2>`；
  - Dialog 宽度只能用 `size="sm|default|lg"`，禁止调用方 `max-w-*` 覆写；
  - `PageSidePanel`：浮动式抽屉（`top-3 bottom-3 right-3`、`rounded-3xl`、`shadow-xl`、body 传送门到 document.body），用于页面级设置/历史面板，区别于贴边的 Drawer；
  - 图标按钮颜色决策树："这个图标是不是用户来这个页面的主要目的？"是→ghost 默认色；否→muted 默认 + hover 恢复。同一区域 3+ 图标按钮时至多一个用默认色，其余必须弱化；
  - 危险行内操作平时不许常红，确认时才用 destructive；收藏星标的琥珀色只许用于收藏语义；
  - 禁止 `border-border/40` 这类透明度边框类，必须用语义 token（border-muted/subtle/frame）；
  - 设置页两栏契约：左 200px 子菜单（PageHeader+MenuList）、右栏强制 `px-6 py-4` 外层 + `max-w-3xl mx-auto` 内层；
  - 独立设置窗口：主窗口的 80% 大小，下限 760×560、上限宽 1280，居中于主窗口。
- **工程化治理**：tokens 为唯一来源、theme.css 为公共契约、新引入 legacy 变量会触发 lint + PR 评论提醒。

### 1.3 特色交互
- **多模型并行对话**：同一问题 @ 多个模型同时作答、并排对比（翻译/解题对照场景）。
- **消息布局可定制**：列表/气泡两种消息样式、自定义代码块样式、自定义 CSS 逃生舱（社区主题包生态）。
- **v2 新增**：CherryClaw 自主智能体（多渠道接入 Telegram/Discord/微信、定时任务）、技能安装与安全审查、本地文件渲染与快速编辑、Webhook 通知。
- **数据**：WebDAV 备份同步、全局搜索（历史+知识库）。

### 1.4 公开评测中的教训
- 图标区分度不高，初上手需逐个试（需要 tooltip 与更强的图标语义）；
- Electron/CEF 内存 400MB+；
- 快速迭代期偶发数据丢失（备份/迁移测试不足）；
- 关闭功能后全局快捷键未注销（快捷键生命周期管理）。

---

## 二、OpenCode：终端优先的键盘流 + 客户端/服务端分离

**定位**：开源（MIT）AI 编码代理，SST 团队出品，162k+ stars、月活开发者 500 万级。三种形态：TUI（主形态）、桌面 App、VS Code 扩展。

### 2.1 架构对 UX 的影响
- **客户端/服务端分离**：服务端（Bun/Hono）持有全部状态（SQLite 持久化），TUI 只是"可替换的视口"。关掉 UI 会话不死；可远程跑服务端、手机/轻客户端接入；多客户端共享同一会话。
- **教训（对 Tauri 项目重要）**：桌面版最初用 Tauri，2026 年迁移到 Electron。官方原因：macOS/Linux 的 WebKit 渲染与 Chromium 存在性能与样式不一致，无法保证跨平台一致体验。结论不是"Tauri 不行"，而是"重 Web UI + 跨三端一致性要求高"时 WebKit 差异成本高。

### 2.2 TUI 设计细节
- **两栏布局**：左侧对话流（消息/工具调用/结果），右侧边栏常驻显示**上下文 token 用量、费用、LSP 状态**；底部输入框内联显示当前模式+模型（`Build Claude Sonnet 4.5`）。
- **键盘优先**：`Tab` 切换 Build/Plan 代理、`Ctrl+P` 命令面板、`Ctrl+N` 新会话、`/` 斜杠命令；全程无需鼠标（但支持鼠标）。
- **Build/Plan 双模式**：Build 全权执行；Plan 只读分析，任何写操作都需逐条批准。一键 Tab 切换，安全边界非常清晰。
- **权限对话**：`Allow once / Allow always / Reject` 三档，展示匹配的命令模式。
- **检查点**：`/undo` `/redo` 基于 git 快照回滚"对话 + 文件修改"整体状态。
- **布局密度系统**（2026 新增）：仿主题系统做了 layout 配置（JSONC），内置 default/dense 两套，18 个间距/可见性参数可调，`/layout` 命令切换——起因是视障用户大字体下 24 行终端被空行吃掉。无障碍需求直接产品化。
- **主题系统**：内置 aura/catppuccin/dracula 等，自动适配终端配色，"尊重用户既有环境"。
- **输入框 extmark**：@文件/@代理在输入框内渲染成带样式的 pill 标签（底层存元数据，显示友好名）。
- **输出纪律**：系统提示词强制回复 <3 行、禁止寒暄，保证终端可读性与上下文节约。
- **自动压缩**：上下文用量达 95% 自动摘要压缩（Auto-Compact）。
- **分享链接**：一条 URL 分享会话完整状态（对话+文件上下文），用于协作排障。
- **GitHub 集成**：issue/PR 评论里 `/oc` 即可触发代理建分支-改码-提 PR。

---

## 三、Codex App：多代理"指挥中心"（Command Center for Agents）

**定位**：OpenAI 出品 macOS/Windows 桌面应用（2026-02 发布），核心命题是"当代理能干数小时-数周的活时，人需要一个指挥、监督、协作的中心"，与 CLI/IDE 扩展/Web 共享会话与配置。

### 3.1 信息架构
- **项目（Project）→ 线程（Thread）**两级组织；一个窗口跨多项目并行多代理。可让 Codex 自己管理线程（找相关线程、续线程、置顶、归档）。
- **线程三种运行模式**：Local（直接改本地）/ Worktree（git worktree 隔离副本，多代理同仓不冲突）/ Cloud（远端执行）。
- **Chats**：不绑定项目的纯对话线程（调研/规划/插件工作流），落在独立的 `~/.codex/threads` 工作目录。

### 3.2 长任务监督 UX（精华）
- **任务侧栏（Task Sidebar）**：线程运行中常驻展示**计划（plan）、来源（sources）、生成产物（artifacts）、任务摘要**，并对 PDF/表格/文档/幻灯片等非代码产物提供富预览。"边跑边看、随时转向"。
- **Diff 审阅面板**：线程内看 git diff、对 diff 行内评论让代理继续改、按块/按文件暂存或回退、直接 commit/push/建 PR。
- **集成终端**：每线程一个终端（Cmd+J），代理能读取终端输出（如 dev server 状态、失败的构建）。常用命令可定义成窗口顶部的快捷按钮（actions）。
- **自动化（Automations）+ 审阅队列**：定时后台任务（结合技能），结果统一落入 review queue 等人审阅继续。另有"线程自动化"= 周期性唤醒同一线程（保留上下文的心跳任务）。
- **浮动弹出窗**：把活跃线程弹成独立小窗、可置顶，贴着浏览器/编辑器迭代前端。
- **通知策略**：默认"仅当应用在后台且任务完成/需要审批"才通知；可改为 always/never。
- **防休眠**："Prevent sleep while running" 开关，长任务时阻止系统睡眠。

### 3.3 输入与个性化
- **语音口述**：按住 Ctrl+M 说话即转写进 composer。
- **人格选择**：`/personality` 二选一——简洁执行型 vs 健谈共情型，能力不变只换语气。
- **记忆（Memories）**：跨线程携带稳定偏好、项目惯例、已知坑。
- **技能（Skills）**：侧栏可浏览/管理技能库（含团队共享），技能+自动化组合成常规工作流。
- **图像**：拖拽图片入 composer（Shift 强制作为上下文）；线程内直接生图（gpt-image-2）。

### 3.4 安全 UX
- **审批分级**："approve once / approve for this session"等不同授权范围；沙箱限定目录与网络；可配置规则让特定命令自动提权；有"automatic review"策略可替代人工逐条批。
- 计算机使用（computer use）这类越界能力，文档反复强调"任务收窄 + 审阅权限提示"。

### 3.5 社区反馈
- 功能强但 UI 打磨被指不如 Cursor 等成熟 IDE（VentureBeat 等评测）；说明"指挥中心"形态仍在演化期。

---

## 四、三款产品的共性规律

1. **"安静界面"成为共识**：Cherry v2 与 DeepStudent 的设计哲学几乎逐字一致（中性灰外壳、强调色克制、表面分层代替阴影）。这个方向不用动摇，差距在**治理深度**。
2. **AI 长任务的监督界面成为新赛道**：计划/来源/产物/摘要的结构化呈现 + diff/产物审阅 + 审阅队列，是 2026 年代理类产品的标配心智。
3. **键盘优先与命令面板**是专业工具的底线（OpenCode 全键盘、Codex Cmd+K、Cherry 快捷键体系）。
4. **系统级入口**（全局快捷键、划词、托盘、弹出置顶窗）决定"使用频率"，Cherry 的快捷助手是其留存利器。
5. **透明度**：token/费用/上下文用量常驻可见（OpenCode 侧栏、Codex 用量页）。
6. **个性化分层**：主题/强调色（所有人）→ 布局密度（进阶）→ 自定义 CSS/主题市场（极客），逐层开放。

---

## 五、DeepStudent 可借鉴清单

> 现状基线：已有安静中性设计语言与 token 体系、Learning Hub（文件树+标签页+分屏）、chat_v2（SelectionToolbar/ToolApprovalCard/TokenUsageDisplay/AgentTaskPanel/session-browser）、命令面板（cmdk）、语音输入、番茄钟、task-dashboard（制卡任务）、技能管理、移动端三屏滑动。**没有**：系统托盘/全局快捷键/独立小窗、自动化调度、会话检查点回滚、多模型对照、密度设置。

### P0：低成本高确定性（打磨现有体验）

| # | 借鉴点 | 来源 | 落到 DeepStudent |
|---|---|---|---|
| 1 | 通知策略三档（后台才通知/总是/从不） | Codex | 制卡、批改、PDF 处理等长任务完成或需审批时系统通知；前台不打扰 |
| 2 | 防休眠开关 | Codex | task-dashboard 跑批量任务时 "运行中防止睡眠" toggle（Tauri 有现成插件能力） |
| 3 | 上下文/费用常驻透明 | OpenCode | TokenUsageDisplay 升级：会话级累计 token/费用 + 上下文水位（接近上限提示压缩） |
| 4 | 审批分级 | Codex/OpenCode | ToolApprovalCard 增加 "仅此次 / 本会话内允许 / 总是允许" 三档，替代反复弹卡 |
| 5 | 话题自动命名 + 时间显示 + 分组 | Cherry | session-browser 借鉴话题列表细节（自动命名、创建时间开关、按助手/学科分组） |
| 6 | 图标按钮层级决策树 | Cherry v2 | 把"3+ 图标至多一个默认色、其余 muted"写进 CODE_STYLE/设计文档并 lint 化；解决工具栏图标过载 |

### P1：中成本高价值（补结构性能力）

| # | 借鉴点 | 来源 | 落到 DeepStudent |
|---|---|---|---|
| 7 | **全局快捷助手 + 划词工具栏（系统级）** | Cherry | 学习应用杀手锏：任意应用里划词→翻译/查词/收藏到生词本/存为卡片；全局快捷键呼出迷你问答窗（Tauri tray + global-shortcut + 独立 WebView 窗口）。注意 Cherry 的教训：快捷键注销生命周期 |
| 8 | **任务侧栏结构化**（计划/来源/产物/摘要） | Codex | AgentTaskPanel 演进：AI 深度任务（批改作文、生成卡组、调研课题）运行时展示 plan + 引用来源 + 产物列表（可预览 PDF/表格）+ 完成摘要 |
| 9 | **自动化 + 审阅队列** | Codex/Cherry v2 | 定时任务（每日错题汇总、周学习报告、复习计划生成）结果进入"待审阅"队列，与 todo 模块打通；支持"线程心跳"式持续任务 |
| 10 | **AI 编辑检查点 /undo** | OpenCode | AI 改笔记/思维导图（useCanvasAIEditHandler 已存在）前自动快照，一键回滚整轮 AI 修改；学习资料是用户核心资产，回滚是信任基础 |
| 11 | **浮动置顶小窗** | Codex | 番茄钟、单词卡速刷、AI 追问窗可弹出为置顶小窗（Tauri 多窗口），伴随网页/论文阅读使用 |
| 12 | 按住说话口述 | Codex | voice-input 增加"长按快捷键即说即转写"进聊天输入框 |
| 13 | 学习助手人格 | Codex | "严格教练 / 温和陪伴 / 苏格拉底提问" 等语气人格，能力不变只换风格；对学习动机管理价值大 |
| 14 | 布局密度（舒适/紧凑） | OpenCode | 题库、文件树、todo 列表提供 dense 模式；本质是无障碍 + 大屏信息密度需求 |

### P2：战略级（形态升级）

| # | 借鉴点 | 来源 | 落到 DeepStudent |
|---|---|---|---|
| 15 | 助手/场景模板中心 | Cherry | 把 template-management + skills 融合为"学习助手中心"：错题分析师、论文润色、单词教练、口算陪练……支持社区分享 |
| 16 | 多模型对照答题 | Cherry | 同一题 @ 多模型并排作答（数学解法对照、翻译对照），学习场景天然适合"交叉验证" |
| 17 | 会话/成果分享链接 | OpenCode | 解题过程、AI 批改结果导出为分享页（同学/老师查看），现有 SharedPreview 可扩展 |
| 18 | 设计系统治理工程化 | Cherry v2 | 把 design-tokens 文档升级为带组件级硬契约的 DESIGN.md（PageHeader/Dialog size/边框 token 禁令），配 stylelint/PR 机器人提醒——DeepStudent 已有 contract tests，路径一致，可加深 |
| 19 | 自定义 CSS 逃生舱 + 主题分享 | Cherry | 在现有 accent palette 基础上开放高级自定义 CSS（风险可控：仅作用于用户自己） |
| 20 | 纯聊天 vs 资源会话分离 | Codex | "Chats"（不绑资料的快速问答）与"绑定学习资料的会话"在 UI 上区分组织 |

### 工程警示（反面教材）

- **OpenCode 弃 Tauri 转 Electron**：原因是 macOS/Linux WebKit 与 Chromium 的渲染不一致 + 性能。DeepStudent 作为 Tauri 应用应：把 WebKit 差异纳入 CI 视觉回归、避免依赖 Chromium-only 特性、重交互组件在 Safari/WebKit 上专项测试。
- **Cherry 的数据丢失投诉**：快速迭代 + 本地数据 = 必须有自动备份/迁移测试（DeepStudent 的 VFS 迁移测试方向正确，坚持）。
- **Cherry 图标可读性差评**：图标必须配 tooltip 与文案，新功能入口不要只靠图标。
- **Codex "UI 不如 Cursor 打磨"的批评**：功能堆叠快时，交互一致性会成为口碑短板——契约化设计系统正是解药。

---

## 附：信息来源

- Cherry Studio：官方 README/文档（docs.cherry-ai.com）、GitHub `CherryHQ/cherry-studio` DESIGN.md（v2，2026-04）、v2 UI 边界重构 Issue #14331 / PR #14328、腾讯云/笨鸟先飞深度评测（2026）
- OpenCode：DeepWiki TUI 架构、TUICommander 渲染分析（v1.2.20, 2026-03）、Medium 深度评测（2026-05, v1.15.5）、GitHub PR #5020（layout 系统）、Brendonovich《Moving OpenCode Desktop to Electron》
- Codex App：OpenAI 官方发布文（2026-02-02）、developers.openai.com/codex/app/features、VentureBeat / FelloAI 2026-04-16 更新报道
