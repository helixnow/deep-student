# 进度

- **分支**：`cursor/mobile-uiux-unify-0888`
- **目标**：覆盖全部移动页面的顶栏统一、桌面组件收敛、可达/可回退，持续打磨到 SOTA。
- **轮次**：Round 2–90 已落地；收尾见 `WRAP-UP.md`。
- **PR**：https://github.com/helixnow/deep-student/pull/172

## 轮次日志

| 轮 | 模型 | 动作 | 结果 |
|---|---|---|---|
| 0 | 父代理 cursor-grok-4.6-high-fast | 建分支、列视图、划边界、写方案 | 见 INVENTORY.md |
| 1 | claude-fable-5-thinking-xhigh ×10 | 全页只读审查（6 个因并发上限未启动） | 见 ROUND-01-AUDIT.md |
| 2 | claude-fable-5-thinking-xhigh ×10 | 落地 P0/P1 + 补扫 | 见 ROUND-02-FIXES.md |
| 3 | claude-fable-5-thinking-xhigh ×10 | Settings 标题、作文断点、stale 返回、触控 | 见 ROUND-03-FIXES.md |
| 4 | claude-fable-5-thinking-xhigh ×4 | 搜索条测试/返回、Todo enabled、引擎/治理触控 | 已落地并提交（无独立文档） |
| 5 | claude-fable-5-thinking-xhigh | 选择器触控、桌面-only 开关、overlay 返回 | 见 ROUND-05-FIXES.md |
| 6 | claude-fable-5-thinking-xhigh | 面包屑热区、callout 折叠、coarse caret | 已落地（清单见 ROUND-05 残留节） |
| 7 | claude-fable-5-thinking-xhigh | Popover 返回、沙箱 chrome、PDF stale 守卫 | 见 ROUND-07-FIXES.md |
| 8 | claude-fable-5-thinking-xhigh | 导图子屏藏工具条、热力图 tap | 已落地（见 git `6da7a82e`） |
| 9 | claude-fable-5-thinking-xhigh | 灯箱返回、作文/翻译 isActive、Sheet 去 safe-top | 见 ROUND-09-FIXES.md |
| 10 | claude-fable-5-thinking-xhigh | skills/anki enabled、改期守卫、Settings overlay 返回 | 见 ROUND-10-FIXES.md |
| 11 | claude-fable-5-thinking-xhigh ×10 | 导图 44px、删 NotesHome/VideoPreview、Sheet 底安全区、Table 横滚 | 见 ROUND-11-FIXES.md |
| 12 | claude-fable-5-thinking-xhigh ×10 | 侧栏 hover、自动化顶栏、保活 isActive、MCP/插件返回、触控补齐 | 见 ROUND-12-FIXES.md |
| 13 | claude-fable-5-thinking-xhigh ×10 | 子屏顶栏接管、Resizable fixed、Epub isActive、预览死代码、触控 | 见 ROUND-13-FIXES.md |
| 14 | claude-fable-5-thinking-xhigh ×10 | 笔记窄窗返回、侧栏/备份 hover、题库/制卡/分屏手柄 44 | 见 ROUND-14-FIXES.md |
| 15 | claude-fable-5-thinking-xhigh ×10 | 搜索/图片保活、compact 分屏冻结、手柄 44、删 Header 孤儿 | 见 ROUND-15-FIXES.md |
| 16 | claude-fable-5-thinking-xhigh ×10 | 搜索条保活、闪卡 hover、引用选择器/标签 X 44、删 Sidebar 孤儿 | 见 ROUND-16-FIXES.md |
| 17 | claude-fable-5-thinking-xhigh ×10 | 大纲/访达/Anki 行/查看器 44、ContextRefs hover、删搜索孤儿 | 见 ROUND-17-FIXES.md |
| 18 | claude-fable-5-thinking-xhigh ×10 | 笔记 tab/手柄、收藏、题库头、PDF 侧栏、输入栏 chip、设置 44 | 见 ROUND-18-FIXES.md |
| 19 | claude-fable-5-thinking-xhigh ×10 | 翻译 Popover、Crepe 工具栏、FolderPicker、作文轮次、chip X | 见 ROUND-19-FIXES.md |
| 20 | claude-fable-5-thinking-xhigh ×10 | 删 reference-selector、试卷/番茄钟/复习勾选 44、PluginsTab 去自绘返回 | 见 ROUND-20-FIXES.md |
| 21 | claude-fable-5-thinking-xhigh ×10 | 批量条/会话更多/Agent 抽屉/题库草稿、迁类型删 DndFileTree | 见 ROUND-21-FIXES.md |
| 22 | claude-fable-5-thinking-xhigh ×10 | 番茄钟关闭、沙箱轨、AccentPicker、侧栏搜索、来源 compact、内联编辑 | 见 ROUND-22-FIXES.md |
| 23 | claude-fable-5-thinking-xhigh ×10 | 会话卡/判对错/题库更多/模板返回/caret/Anki 模板库 44；删 workspaceShared | 见 ROUND-23-FIXES.md |
| 24 | claude-fable-5-thinking-xhigh ×12 | 番茄钟簇/题库练习/草稿/加标签/Skill 关闭/CRUD/模板图标/笔记退出/搜索关闭 | 见 ROUND-24-FIXES.md |
| 25 | claude-fable-5-thinking-xhigh ×10 | 内联剩余 40、检查器/Finder/结果轮次、页导航、会话侧栏、TagInput、FormatBar | 见 ROUND-25-FIXES.md |
| 26 | claude-fable-5-thinking-xhigh ×10 | 页码输入、Finder 搜索、翻译选择、分组 segmented、MCP chip、Todo/备份、清 rct-tree | 见 ROUND-26-FIXES.md |
| 27 | claude-fable-5-thinking-xhigh ×10 | 灯箱底栏、面包屑、记忆空态、MCP 加环境变量、导出全选、PromptPanel、位置筛选 | 见 ROUND-27-FIXES.md |
| 28 | claude-fable-5-thinking-xhigh ×10 | 画布导航宽屏 coarse、标签清除、导出分段、笔记折叠、设置输入、技能确认条 | 见 ROUND-28-FIXES.md |
| 29 | claude-fable-5-thinking-xhigh ×10 | 维度确认、MCP 筛选输入、Todo 重命名、Vendor 搜索、设置/题库/PDF/技能残留 | 见 ROUND-29-FIXES.md |
| 30 | claude-fable-5-thinking-xhigh ×10 | 模型搜索、笔记加标签、日历导航、模板 Select、迁移横幅、壁纸、Agent 下载行 | 见 ROUND-30-FIXES.md |
| 31 | claude-fable-5-thinking-xhigh ×10 | 迁移关闭、分组顶栏、ShadApi 输入、Changes chip、Memory icon、设置/聊天/笔记残留 | 见 ROUND-31-FIXES.md |
| 32 | claude-fable-5-thinking-xhigh ×10 | 外搜输入、诊断钮、技能 chip、Todo 折叠、聊天筛选、PDF 色点、TabBar 伪条 | 见 ROUND-32-FIXES.md |
| 33 | claude-fable-5-thinking-xhigh ×10 | 填空 40→44、TabBar 更多关闭加高、paperSave、EmbeddedTools、聊天展开、闪卡搜索 | 见 ROUND-33-FIXES.md |
| 34 | claude-fable-5-thinking-xhigh ×10 | DeepSeek 刷新、复习重做、日历关闭、模型钉、标签建议、导图 Aa/ab、备份勾选 | 见 ROUND-34-FIXES.md |
| 35 | claude-fable-5-thinking-xhigh ×10 | 滑轨/chip/展开、MCP 勾选、Workspace、标签云、复习/自动化残留 | 见 ROUND-35-FIXES.md |
| 36 | claude-fable-5-thinking-xhigh ×10 | DEV 测试/Playground、作文去图、制卡 min-h-10、外搜/侧栏/壁纸滑轨 | 见 ROUND-36-FIXES.md |
| 37 | claude-fable-5-thinking-xhigh ×10 | 匹配/排序 40、Finder 伪元素、导图/壁纸 chrome、模板输入、标签清除 | 见 ROUND-37-FIXES.md |
| 38 | claude-fable-5-thinking-xhigh ×10 | 导图关闭/移除 36、块折叠、MCP/外搜刷新、维度 Badge、笔记回收站 | 见 ROUND-38-FIXES.md |
| 39 | claude-fable-5-thinking-xhigh ×10 | 作文结果区 36、MCP compact、大纲 caret/勾选、笔记导入 radio | 见 ROUND-39-FIXES.md |
| 40 | claude-fable-5-thinking-xhigh ×10 | 试卷文字链、标签行、权限折叠、模板 segmented、笔记标签 X、调试壳 | 见 ROUND-40-FIXES.md |
| 41 | claude-fable-5-thinking-xhigh ×10 | PDF 页码、笔记搜索/收藏头、一批 DEV 插件工具栏 | 见 ROUND-41-FIXES.md |
| 42 | claude-fable-5-thinking-xhigh ×10 | 流式/外搜/编排/思维链/制卡/框选/排版/访达/图片预览调试插件 | 见 ROUND-42-FIXES.md |
| 43 | claude-fable-5-thinking-xhigh ×10 | 工具调用/思维块/多变体/浮层/媒体/导入/删除/多智能体/解析/试卷 | 见 ROUND-43-FIXES.md |
| 44 | claude-fable-5-thinking-xhigh ×10 | 剩余 debug 插件：子代理流/流监控/导图 hover/交互测/会话加载/Anki 集成/图片检查/会话切换/Crepe 上传/制卡/OCR/注入/流水线 | 见 ROUND-44-FIXES.md |
| 45 | claude-fable-5-thinking-xhigh ×10 | 生命周期/模板/大纲/DSTU 筛选；style-lab；模板子 tab；作文维度输入；AnkiConnect；笔记标签重命名；DEV FAB/导图色板 | 见 ROUND-45-FIXES.md |
| 46 | claude-fable-5-thinking-xhigh ×10 | 番茄钟文字钮；Crepe 筛选；作文 DSTU 工具栏；导图面包屑；设置/Todo 返回行；模板日志行；测试 label；权限跳转 | 见 ROUND-46-FIXES.md |
| 47 | claude-fable-5-thinking-xhigh ×10 | DSTU 文件/图/PDF/笔记/导图/试卷/翻译工具栏；沙箱展开；笔记 Diff 切换；引用测试 label；番茄钟药丸 | 见 ROUND-47-FIXES.md |
| 48 | claude-fable-5-thinking-xhigh ×10 | 番茄钟迷你窗；CreateAgentCard；工作区重试/派发；附件删除；技能选择器；文档查看器；MCP 溢出菜单；侧栏折叠；DEV FAB | 见 ROUND-48-FIXES.md |
| 49 | claude-fable-5-thinking-xhigh ×10 | 文档查看器动作；技能 footer；笔记库关闭；MCP 表单/权限；PDF 密码框；记忆建夹；闪卡库刷新/批量；Playground 顶栏；语音权限；消息重试 | 见 ROUND-49-FIXES.md |
| 50 | claude-fable-5-thinking-xhigh ×10 | MCP 编辑器 OAuth；模板导入导出；DSTU 启动器；索引透视；厂商图标；自动化历史；Anki 行文字钮；通用设置；数据导入导出；批准条 | 见 ROUND-50-FIXES.md |
| 51 | claude-fable-5-thinking-xhigh ×10 | 制卡块编辑；自动化工作区；输入栏附件；题库工具栏；Codex 账号；并行变体；工具批准卡；恢复中心；开源声明；同步冲突 | 见 ROUND-51-FIXES.md |
| 52 | claude-fable-5-thinking-xhigh ×10 | 备份恢复；引擎帮助图标；JSON 预览；MCP 工具块；模板浏览；SiliconFlow；PDF 重置；翻译提示；记忆设置；索引维护 | 见 ROUND-52-FIXES.md |
| 53 | claude-fable-5-thinking-xhigh ×10 | 调度保存；OCR 重置；系统主题；厂商密钥/弹窗；同步设置；OCR 测试；Markdown 行窗；译文编辑；API 编辑底栏 | 见 ROUND-53-FIXES.md |
| 54 | claude-fable-5-thinking-xhigh ×8 | 笔记工具栏；模型选择器；用量统计；Anki 任务；云存储；聊天空态；模板顶栏；题库空态；设置弹窗 | 见 ROUND-54-FIXES.md |
| 55 | claude-fable-5-thinking-xhigh ×10 | 外观重置；系统权限；自动化；子代理档案；厂商编辑；MCP 加环境变量；Sheet 关闭；AskUser；记忆选夹；导图搜索 Aa/ab | 见 ROUND-55-FIXES.md |
| 56 | claude-fable-5-thinking-xhigh ×10 | 导图结构/样式触发；来源预览；治理 Tabs；归档；聊天顶栏图标；记忆工具栏；总览归档；审计重试；Agent 熔断 | 见 ROUND-56-FIXES.md |
| 57 | claude-fable-5-thinking-xhigh ×10 | 会话浏览；批量编辑；记忆重试；MCP 预设；模型多选；自动化列表；侧栏图标；模板 nav；恢复壳退出 | 见 ROUND-57-FIXES.md |
| 58 | claude-fable-5-thinking-xhigh ×10 | 消息操作；触控条；闪卡库；翻译浮层；试卷上传；图片工具栏；资源重试；复习开始；计划暂停；来源定位 | 见 ROUND-58-FIXES.md |
| 59 | claude-fable-5-thinking-xhigh ×11 | 插件详情；PDF 上传；筛选器；AgentStrip；多变体图标；总览导出；style-lab；FilePreview；闪卡统计/今日/复习 | 见 ROUND-59-FIXES.md |
| 60 | claude-fable-5-thinking-xhigh ×11 | 大纲多选；Todo 删除确认；厂商侧栏；MCP/搜索面板；变体溢出/tab；内联编辑；工具限额/计划门；练习步进；导入/错误回退 | 见 ROUND-60-FIXES.md |
| 61 | claude-fable-5-thinking-xhigh ×10 | Todo 顶栏；OCR 头；工具限额块；睡眠块；生图；聊天错误边界；CSV 导入；附件校验；标签树/隐私；教材 PDF/错误处理 | 见 ROUND-61-FIXES.md |
| 62 | claude-fable-5-thinking-xhigh ×10 | 模板预览；子代理嵌入；引用浮层；模板输出；输入栏；块重置；标签树面板；摘要盒；用量页；翻译工作台 | 见 ROUND-62-FIXES.md |
| 63 | claude-fable-5-thinking-xhigh ×10 | 沙箱顶栏；安全状态；抽屉关闭/聊天标题栏；画布缩放；关于安装；限时/模考；雷达空态；加号菜单；上下文用量 | 见 ROUND-63-FIXES.md |
| 64 | claude-fable-5-thinking-xhigh ×10 | 每日练习；组卷；启动器返回；趋势空态；图表重试；作文重试；浏览器 chrome；复习日历关闭；冲突加载更多；题库保存 | 见 ROUND-64-FIXES.md |
| 65 | claude-fable-5-thinking-xhigh ×10 | 收藏空态；复习关闭；技能 chip；记忆树重试；模型默认；RAG 关闭；引用展开；译文复制；子代理空态；原始请求复制 | 见 ROUND-65-FIXES.md |
| 66 | claude-fable-5-thinking-xhigh ×10 | 历史重试；选夹底栏；桌面对话框关闭；会话重命名；作曲面板关闭；备份重试；诊断展开；试卷重试；大纲确认；回收站返回 | 见 ROUND-66-FIXES.md |
| 67 | claude-fable-5-thinking-xhigh ×10 | 通知动作；模板加字段；画布确认；Anki 测试；预览关闭；作文取消；工作台撤销；闪卡摘要；聊天顶栏；库卡保存 | 见 ROUND-67-FIXES.md |
| 68 | claude-fable-5-thinking-xhigh ×10 | 压缩摘要；引用清空；备份取消；问用户确认；侧栏加载更多；工作区日志复制；时间线继续；历史加载更多；作文批改；Crepe 顶栏 | 见 ROUND-68-FIXES.md |
| 69 | claude-fable-5-thinking-xhigh ×10 | Runtime 展开；笔记预览展开；FilePreview 更多；Todo 专注/清空；欢迎语言；导图色板；PDF 选色；笔记加标签 | 见 ROUND-69-FIXES.md |
| 70 | claude-fable-5-thinking-xhigh ×10 | 回收站删除；Composer 搜索；笔记大纲；会话浏览搜索；幽灵新行；导图更多；发送 iPad 洞；热力图；变体圆点；题库清筛选 | 见 ROUND-70-FIXES.md |
| 71 | claude-fable-5-thinking-xhigh ×10 | 复习空态关闭；仪表盘重试；导入导出动作；恢复中心；侧栏重试；导图错误边界；Crepe 桌面返回；插件扫码；题库返回；技能全屏 | 见 ROUND-71-FIXES.md |
| 72 | claude-fable-5-thinking-xhigh ×10 | 技能弹窗类型/底栏；冲突策略；DsDialog 确认底栏；自动化创建；快捷键关闭；版本恢复确认；关于下载；索引钮；导图嵌入重试；组件恢复壳 | 见 ROUND-72-FIXES.md |
| 73 | claude-fable-5-thinking-xhigh ×10 | 导图加载重试；记忆配置重试；MCP 测连；欢迎 CTA；作文桌面批改；用户协议；不可用恢复入口；分组顶栏保存；技能钉住；模型行 | 见 ROUND-73-FIXES.md |
| 74 | claude-fable-5-thinking-xhigh ×10 | 子代理/自动化顶栏；技能弹窗 tab；题库提交；Select/Combobox/折叠选择器；模型分组头；作文结果 tab；复习关闭 | 见 ROUND-74-FIXES.md |
| 75 | claude-fable-5-thinking-xhigh ×10 | Input/Checkbox/Slider/icon Button；api-key-field；技能搜索/工具名；Todo 日期；Anki 行展开 | 见 ROUND-75-FIXES.md |
| 76 | claude-fable-5-thinking-xhigh ×10 | About 行；子代理/自动化高级 summary；OCR/工具 JSON/隔离 payload；RunHistory 行；askUser 多选；sleep 头；Todo 侧栏图标 | 见 ROUND-76-FIXES.md |
| 77 | claude-fable-5-thinking-xhigh ×10 | 子代理取消；记忆行；workspaceStatus 头；ChatCollapsible；队列气泡；OCR SwitchRow；Todo 确认/主行；AskUser 行；用量环 | 见 ROUND-77-FIXES.md |
| 78 | claude-fable-5-thinking-xhigh ×10 | 共用/PDF/Params SwitchRow；子代理/自动化展开行；试卷筛选；笔记树行；大纲 +N；作文题头；反链行 | 见 ROUND-78-FIXES.md |
| 79 | claude-fable-5-thinking-xhigh ×10 | 模型/Combobox 选项；笔记溢出/菜单/空态/搜索 overlay；TagFilter 输入；反链上下文；Agent 父目录；记忆编辑/横幅 | 见 ROUND-79-FIXES.md |
| 80 | claude-fable-5-thinking-xhigh ×10 | 树右键/caret；收藏行；确认/重试/溢出；反链 extras/chrome；画布模式；搜索重试；AppsPanel；Agent 控制；Anki 筛选 iPad 洞 | 见 ROUND-80-FIXES.md |
| 81 | claude-fable-5-thinking-xhigh ×10 | Expose/速查关闭；日程 38→44；技能/Todo/番茄钟分段 iPad 洞；快捷助手；Crepe 块手柄 | 见 ROUND-81-FIXES.md |
| 82 | claude-fable-5-thinking-xhigh ×10 | 平铺菜单/快捷助手残留；欢迎语言与设置/Todo/复习分段 `!min-h-11` | 见 ROUND-82-FIXES.md |
| 83 | claude-fable-5-thinking-xhigh ×10 | 主题/Agent/图表/翻译/日程/导图分段；Dock 关闭 iPad 洞；题库导出 | 见 ROUND-83-FIXES.md |
| 84 | claude-fable-5-thinking-xhigh ×10 | AppMenu/Checkbox/Switch/工具类 iPad 洞；桌面重命名；壁纸开关；导图搜索/缩放；能力 toggle | 见 ROUND-84-FIXES.md |
| 85 | claude-fable-5-thinking-xhigh ×10 | 整区域打包：Crepe/设置/学习中心/笔记/Todo/导图/聊天插件/技能/工作台/模板·Anki | 见 ROUND-85-FIXES.md |
| 86 | claude-fable-5-thinking-xhigh ×10 | 整区域打包：聊天消息页/变体卡片/工作区·playground、题库练习、作文翻译、闪卡、模板导入、共享组件、DSTU、PDF·批量 | 见 ROUND-86-FIXES.md |
| 87 | claude-fable-5-thinking-xhigh ×10 | 整区域打包：Todo 自动化、恢复中心、导图 TSX、图片查看器真洞、标签导航、通知/兜底、学习中心 Input、番茄钟·debug | 见 ROUND-87-FIXES.md |
| 88 | claude-fable-5-thinking-xhigh ×10 | 整区域打包：SelectItem 原语、debug 原生、工作台 CSS、聊天/共享/学习中心原生、拖拽把手、PDF 菜单项、快捷助手 | 见 ROUND-88-FIXES.md |
| 89 | claude-fable-5-thinking-xhigh ×11 | 整区域打包：侧栏非活动行、题库虚列表、设置 Label/16px、分段原语 `!`、Crepe 勾选/图控、聊天插件 inset、工作台 CSS 层叠 | 见 ROUND-89-FIXES.md |
| 90 | fable 残留 + sol 收尾 | 死 CSS、6b 合同、Label/16px、640–767 chrome、侧栏/subagent 重叠、共享/学习中心/笔记/设置 | 见 ROUND-90-FIXES.md、WRAP-UP.md |

## 收尾队列

- **收尾完成，不再派 fable。** PR #172 可审。有意折衷如下，勿当新洞。
- 内联引用 chip 设计未决；MiniCalendar/TabBar 宽 28 有意折衷
- FinderToolbar 视觉 40 + 伪元素 48：标题栏约束，勿再硬叠 44 视觉
- ShortcutSettings 属 #166 不碰
- WorkbenchSidebar 桌面壳分区头属 #161，不碰
- 翻译 SourcePanel / ComparisonView 已用 COARSE_HIT 凑 44，勿重做视觉

## 已落地

- 本目录方案与清单
- Round 2–11：顶栏契约、可达契约、废弃 MobileHeader 禁令；聊天/设置/沙箱/PDF/导图/热力图/Anki/Todo 移动 chrome；死代码 NotesHome / VideoPreview / AudioPreview / PreviewPanel
- Round 41–90：DEV debug-panel 插件工具栏几乎扫完；`deep-student.css` 6b 合同、死 CSS、640–767 桌面条泄漏已收
- 契约测试：`tests/vitest/mobile-uiux/*`（非法 viewId allowlist 已清空）

## Wave2-C 进度（0824-wave2-mobile-uiux-a875）

- R1–R8 已做；R9 进行中。
- 真机验证仍留白。
