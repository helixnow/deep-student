# DeepStudent 对外口径

> 官网（ds-web）、宣传片（video 分支）、README（中英）三处文案的唯一事实来源。
> 改任何一处对外文案前先对照本文；本文与代码冲突时以代码为准，并回头修正本文。
> 更新日期：2026-11-21（按 v0.20.7 核对）

## 1. 定位

| 层级 | 中文 | English |
|---|---|---|
| 口号 | **只专注学习本身就够了，剩下的都交给我。** | **Just focus on learning. Leave the rest to me.** |
| 口号（短版，版面受限时） | 专注学习本身，剩下的交给我。 | Focus on learning. Leave the rest to me. |
| 品类 | 开源、本地优先的 AI 学习工作台 | An open-source, local-first AI learning workbench |
| 主张 | 一个学习 Agent，能直接操作你学习桌面上的每一个应用。 | A study agent that works directly in every app on your Study Desktop. |

- 口号里的「我」是 DeepStudent 的学习 Agent。第一人称只用在口号，正文一律用第三人称「它 / Agent」。
- 主角是 **Agent**，资料是它工作的对象，不是卖点本身。不要再写成「围绕资料问答的工具」。
- 架构底座（v0.20.x 起）：已从上一代 Tauri 2 / Rust（`0.11.x`）切换至 **Electron 45（桌面端）+ Capacitor 8.6（移动端）+ WebUI & PWA + Cordis 4 双内核插件架构**（100% TypeScript + Hybrid N-API / WASI-WASM 原生引擎）。
- 首屏标准组合（官网首屏、README 标题下，两处逐字一致）：

  > **只专注学习本身就够了，剩下的都交给我。**
  > 开源、本地优先的 AI 学习工作台。
  > 它的学习 Agent，可直接操作学习桌面上的每一个应用。

  English：**Just focus on learning. Leave the rest to me.** / An open-source, local-first AI learning workbench. / Its study agent works directly in every app on your Study Desktop.

## 2. 三条支撑 + 底座

各渠道按此顺序讲；每条给出可直接引用的证据点。

### ① 能动手 —— Agent 直接操作学习桌面上的应用

说一句话，它去写笔记、建思维导图、出题、制卡、排复习、建待办、做调研。

- 每个应用都有 Agent 读写工具：笔记、思维导图、题目集、闪卡 / FSRS-6、待办、作文批改、翻译、模板、设置、备份（`docs/Agent工具面总览.md` §2）
- 操作学习桌面窗口：打开应用、观察界面、执行动作（`builtin-workbench_*`），支持学习流阶段预设与 AI 控制中心
- 生成式 UI：在对话中通过 `openui-lang`、结构化生成式 UI 与高保真 HTML 交互沙箱直接渲染交互式讲解组件、图表与可视化演示
- 调研模式：检索、阅读文献、成稿写入笔记；论文下载入库并建立索引
- 音视频学习：网课 / 录音转写为带时间戳字幕，B 站链接导入与应用内播放，课中检查点、单课台账与章节化图文讲义，回答引用到具体时刻（`[媒体@id:mm:ss]`）
- 浏览器自动化（Windows / macOS）、沙箱本地 shell、生成 Word / PPT / Excel 文件

### ② 可托付 —— 长任务自动推进，每一步可审批、可撤销

- 目标模式跨轮自动续跑；子代理与 Super 会话（实验性）并行推进；定时自动化（`builtin-automation_*`）
- 操作按执行档位（谨慎 / 宽松 / 完全访问）与 Low / Medium / High 风险分级审批；学习桌面提供「紧急断电」开关
- 改动可撤销：笔记改动支持逐组 / Hunk Diff 审阅与撤销，对话支持回合级 Diff 审阅与一键回退，学习桌面操作带撤销令牌（`builtin-workbench_undo`）
- 回答带出处：引用可回溯到原文 PDF 页码（`pdfref://` 跨应用反链）、讲义节点或音视频时间戳

### ③ 懂你，可扩展

- 记忆与学习空间：记住薄弱点和学习习惯，支持按学习空间隔离长期记忆
- **58 个内置技能**（8 个工作流技能 + 50 个渐进披露工具组，桌面端插件工坊动态追加 `dstu-plugin-development`），支持社区技能市场与 MCP 外部工具
- **AI 插件工坊与 `.dstuplugin`**：在应用内用自然语言由 AI 编写、Host 托管 `esbuild` 编译、隔离试装载修复并热加载新应用/选区按钮/AI 工具，支持版本回滚与导出分享（同进程运行，无物理沙箱，需如实披露边界）
- **15 家预置模型服务商**（含 DeepSeek 官方应用 API 9 项能力、OpenCode Go、Codex、Mistral 等）+ 一键 API Key 自动配置，支持多模型并行作答
- 渠道扩展：内置微信 iLink Bot（`ilinkbot`，v0.20.7 处于预览 / 接入中阶段，已完成桌面端扫码绑定与长轮询，远程任务桥与图片批处理正在接入中，对外务必如实标注）

### 底座 —— 数据在本机，多端可达，开源可核对

- 资料、笔记、聊天记录与索引默认存本机（SQLite + LanceDB / Android OPFS）；调用模型、外部搜索、MCP、云同步或错误报告时相应请求才会离开本机（不得写成「完全离线」）
- 云同步（实验性，Sync V5 引擎）：桌面端与桌面浏览器访问的自托管 WebUI 支持 WebDAV / S3 / 实验性 FTP，Android 原生端仅支持 WebDAV；支持 6 位 PIN 二维码设备配对（`DSPAIR1`）与 FSRS 复习计划原子同步
- 三大运行形态：桌面端（Electron 45）、移动端（Capacitor 8.6 Android / iOS 源码构建）、自托管 WebUI & PWA（Node.js 24+）
- AGPL-3.0-or-later

## 3. 硬数字

数字只能从这里取；发版前按「核对方式」复核。

| 项 | 当前值 | 核对方式 |
|---|---|---|
| 内置技能 | **58**（静态 8 工作流 + 50 工具组；Linux / 移动 / WebUI 为 49 工具组不含 `browser-tools`；桌面端插件工坊动态追加 `dstu-plugin-development`） | `src/features/chat/skills/builtin/index.ts`（8）+ `builtin-tools/index.ts`（50）+ `src/app/pluginWorkshop.ts` |
| 预置模型服务商 | **15**（SiliconFlow、OpenCode Go 固定置顶前 2 位；手动添加类型下拉共 19 项） | `host/plugins/llm/src/data/builtin_catalog.ts`（14）+ `gemini_model_registry.ts`（1） |
| 联网搜索引擎 | **9**（Bing RSS 免费默认 + Google CSE / SerpAPI / Tavily / Brave / SearXNG / 智谱 / 博查 / DeepSeek 官方搜索）+ 2 条 Fetch 抓取路径 | `host/plugins/mcp/src/web-search-providers.ts` & `EngineSettingsSection.tsx` |
| OCR 引擎 | **6**（DeepSeek-OCR、PaddleOCR-VL-1.5、PaddleOCR-VL、GLM-4.6V、通用多模态模型、系统 OCR） | `host/plugins/llm/src/ocr_runtime.ts` & `ocr/types.ts` |
| 题目集题型 / 练习模式 | **13 种题型**（AI 出题支持 8 种）/ **9 种练习模式**（5 基础 + 4 高级） | `src/api/questionBankApi.ts` & `PracticeLauncher.tsx` |
| 闪卡与题库间隔重复 | **FSRS-6**（正式版默认，闪卡与题库统一调度算法）；**FSRS-7** 为桌面端 CLI 隔离试跑脚本（设置界面无开关） | `host/plugins/review/src/{review-plan-fsrs,fsrs7}.ts` & `scripts/fsrs-eval/desktop.mjs` |
| 学习桌面官方应用 | **16 个**（开启内置浏览器后 **17 个**，含新增「AI 仪表盘」「插件工坊」）+ 自动镜像第三方插件页 | `src/features/workbench/apps/registerAll.ts` |
| 翻译领域预设 | **7** | `src/components/translation/PromptPanel.tsx` & `host/plugins/translation` |
| 平台与安装包 | macOS 13+（Apple Silicon / Intel `.dmg`）、Windows 10+ x64（`.exe`）、Linux x86_64（**仅 `.deb` / `.AppImage`，无 `.rpm`、无 arm64**）、Android 7.0+ ARM64（`.apk`）、自托管 WebUI & PWA（Node.js 24+）；iOS 15+ 仅源码构建 | `.github/workflows/reusable-build-*.yml` & `electron/electron-builder.config.cjs` |
| 许可证 | AGPL-3.0-or-later | `package.json` |
| 官网 / 文档 | https://deepstudent.cn ・ https://deepstudent.cn/user-guide/ | |

## 4. 术语表

以应用内界面名称为准（`src/locales/*/workbench.json` 的 `apps.*`）。

| 中文 | English | 不要写成 |
|---|---|---|
| 学习桌面 | Study Desktop | OS 模式、Workbench mode、工作台模式 |
| 学习 Agent / Agent | study agent / agent | AI 助手（泛称时可用「AI」） |
| 学习空间 | Study Space | （旧称「课题分组」已升级为学习空间） |
| 资源库 | Files | 学习中心、学习资源、学习资源中心、Learning Hub |
| 对话 | Chat | |
| 笔记 | Notes | |
| 思维导图 | Mind Map | 知识导图 |
| 题目集 | Exam Set | 题库 |
| 闪卡 | Flashcards | 经典外壳里「闪卡」页合并了复习 / 制卡 / 模板三个标签 |
| 音视频 | Media | 视频学习、媒体转写 |
| Anki 制卡 | Anki Cards | |
| 作文批改 | Essay Review | |
| 翻译 | Translation | |
| 待办 / 番茄钟 | Todo / Pomodoro | |
| 技能 | Skills | |
| 插件工坊 | Plugin Workshop | |

- 「音视频 / Media」是应用名（经典侧栏与 Dock 里都有）。应用列表、导航一律用应用名；正文描述这项能力时可写「音视频学习」。

## 5. 文案语体

调研结论（Apple 中国、Notion、WPS AI、Goodnotes 产品页）：主流宣传文案是**主标题 + 副文案**两层，书面语。

- **主标题**：8–14 字，一句话说一个结论，句号收尾；可以有态度。
- **副文案**：一句完整书面陈述，交代具体事实（文件格式、算法名、数字），不写感受。
- **用词**：用「可、即可、自动、逐项、一并」；少用「就、也、了、吧、到底、讲讲」等口语虚词。
- **避免 AI 味**：句长全篇一致、对仗排比连用、「越 A 越 B」「不是…而是…」「一 X 就 Y」反复出现、只有形容词没有名词。同一篇里对仗句不超过两三处。
- **宣传片字幕**：主句读速 ≤ 4.5 字/秒；不显示章节编号；副文案晚主句约 0.3 秒出现，同时退出。

## 6. 各渠道落点

| 渠道 | 口号位置 | 结构要求 |
|---|---|---|
| README（中英） | 标题与 Logo 下第一行 | 首屏一张静态主图（学习桌面 + Agent 正在操作）→ Agent 一节 → 各应用 → 安装 → 架构跃迁与开发者区。截图真机重拍，中英文界面各一套 |
| 官网 | 首屏主标题 | 学习桌面之后第一节讲 Agent；应用列表放后面 |
| 宣传片 | 片尾 Logo 下 | 字幕主语写「它」，让观众意识到动作是 Agent 做的；数字按 §3 |

## 7. 变更与校准记录

### 2026-11-21 复查（v0.20.7）

- [x] 本文：全面核对并更新至 v0.20.7（Electron 45 / Capacitor 8.6 / WebUI & PWA / Cordis 4、15 家预置供应商、58 个静态内置技能、9 个搜索引擎、6 个 OCR 引擎、13 题型 / 9 练习模式、FSRS-6 与 FSRS-7 桌面试跑边界、AI 插件工坊、生成式 UI、Sync V5、微信 iLink Bot 预览状态、Linux 移除 `.rpm`）
- [x] 用户指南（`docs/user-guide/`）：全部 19 章按 v0.20.7 代码核对更新，新增 `20-AI插件工坊与插件管理.md` 与 `21-WebUI与PWA自托管.md`，更新 `README.md`
- [x] 官网（`ds-web`）：同步 21 章用户指南，更新首页中英双语消息表、`what-is-deepstudent.md`、`about.md`、`timeline.md`、`A-Q.md`、`download.md`、`llms.txt`，新增 `developers.md`
- [ ] 待 `v0.20.x` 转正 `Latest` 后：重新触发 Demo Publish 同步演示镜像，并重跑 `gen-features-live.mjs` 与 `gen-share-images.mjs` 刷新官网截图；核对 `README.md` / `README_CN.md` 中「13 家模型服务商」→「15 家」及 WebUI S3/FTP 表述

### 2026-10-05 / 10-06 历史复查（已归档）

- [x] v0.10.x 阶段：完成音视频独立应用与 B 站导入口径统一、FSRS-6 排程、「知识导图 → 思维导图」「题库 → 题目集」「学习资源中心 → 资源库」全仓术语对齐，以及宣传片 v6 / v6.1 与官网演示镜像首次打通
