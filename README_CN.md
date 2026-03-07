<div align="center">

**简体中文** | [English](./README.md)

<img src="./public/logo.svg" alt="DeepStudent" width="120" />

# DeepStudent

### 一个开源、本地优先的 AI 学习工作台

把分散在多个软件里的学习流程，收进一个地方：<br/>
**资料学习 · 深度调研 · 笔记整理 · 思维导图 · 题目练习 · 翻译精读 · 复习制卡**

[![CI](https://github.com/helixnow/deep-student/actions/workflows/ci.yml/badge.svg)](https://github.com/helixnow/deep-student/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/helixnow/deep-student?color=blue&label=release)](https://github.com/helixnow/deep-student/releases/latest)
[![License](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Stars](https://img.shields.io/github/stars/helixnow/deep-student?style=social)](https://github.com/helixnow/deep-student)

[![macOS](https://img.shields.io/badge/-macOS-black?style=flat-square&logo=apple&logoColor=white)](#下载安装)
[![Windows](https://img.shields.io/badge/-Windows-blue?style=flat-square&logo=windows&logoColor=white)](#下载安装)
[![Android](https://img.shields.io/badge/-Android-green?style=flat-square&logo=android&logoColor=white)](#下载安装)

[官网](https://deepstudent.cn) ·
[**下载安装**](#下载安装) ·
[快速入门](https://deepstudent.cn/docs/) ·
[用户手册](https://deepstudent.cn/docs/) ·
[反馈问题](https://github.com/helixnow/deep-student/issues) ·
[参与贡献](./CONTRIBUTING.md)

</div>

<p align="center">
  <img src="./example/软件主页图.png" width="90%" alt="DeepStudent 主界面" />
</p>

---

## 为什么会有 DeepStudent

学习流程散落在太多工具里。

打开 PDF 阅读器看教材，用 XMind 画导图，用有道做翻译，用 Notion 记笔记，上学习通刷题，去知网和 arXiv 搜论文，自己做闪卡导入 Anki，遇到问题再截图发给 DeepSeek 或 ChatGPT——这是很多人的日常。但学习数据一旦分散，你就要在学习之外花大量精力搬运和维护，而不是专注学习本身。

DeepStudent 要解决的就是这件事：**把"读 → 问 → 查 → 记 → 理 → 练 → 背"串成一条连续的学习链。**

一个工作台，就是你的学习主场。

---

## 用熟悉的产品来理解

> **NotebookLM + Notion + XMind + Quizlet + DeepL**，装进一个可扩展的本地优先工作台。

| 需求 | 你可能在用 | DeepStudent 的做法 |
|---|---|---|
| 围绕资料学习 | NotebookLM | NotebookLM 也能生成导图和闪卡，DeepStudent 在此基础上加入间隔复习、做题模式、翻译精读和调研，且数据全部在本地 |
| 笔记与知识库 | Notion / Obsidian | 本地优先的知识组织，所有学习资产统一管理，无需依赖云端 |
| 思维整理 | XMind / 幕布 | AI 驱动的导图生成与编辑，可从同一份材料一键展开知识结构 |
| 刷题与复习 | Quizlet / Anki | AI 出题 + 多种做题模式 + 间隔复习 + 导出 Anki，Quizlet 和 Anki 各自擅长一部分，这里是完整链路 |
| 翻译精读 | DeepL | DeepL 擅长高质量翻译，DeepStudent 增加逐段双语对照、领域预设与自定义术语，面向深度阅读场景 |

区别在于：这些能力不是各自独立的模块，而是共享同一套学习数据和同一条工作流。同一份材料可以被阅读、提问、生成导图、拆成题目、转成卡片——不需要在多个软件间来回搬运。

---

## 核心能力

### 1. 资料学习与智能对话

围绕你的材料持续学习，而不只是通用聊天。

- 多模态输入（图片 / PDF / Word 拖拽上传）与多轮对话
- 引用面板直选知识库笔记或教材注入上下文，实时 Token 估算
- 深度推理模式（思维链），展示完整思考过程
- 多 Tab 会话与会话分支，探索不同解题路径
- 多模型对比（实验性）：同一问题并排展示多个模型的回答
- 会话分组、分组 System Prompt、默认技能配置
- 子代理执行（实验性）：复杂任务自动拆解、后台完成

<details>
<summary>📸 查看截图</summary>
<p align="center"><img src="./example/会话浏览.png" width="90%" alt="会话管理" /></p>
<p align="center"><img src="./example/分组.png" width="90%" alt="会话分组" /></p>
<p align="center"><img src="./example/anki-发送.png" width="90%" alt="引用与发送" /></p>
<p align="center"><img src="./example/并行-1.png" width="90%" alt="多模型并行选择" /></p>
<p align="center"><img src="./example/并行-2.png" width="90%" alt="多模型对比回复" /></p>
</details>

### 2. 学习资源中心

把资料、笔记、题目、导图、翻译、卡片统一组织起来。

- 笔记 / 教材 / 题库 / 导图等全格式管理
- 导入后自动进入向量化队列（OCR → 分块 → Embedding → 索引），状态实时可视
- 内置 PDF / DOCX 阅读器，双页阅读与书签标注
- 为后续问答、导图、制题、制卡提供统一数据源

<details>
<summary>📸 查看截图</summary>
<p align="center"><img src="./example/学习资源管理器.png" width="90%" alt="学习资源管理器" /></p>
<p align="center"><img src="./example/笔记-1.png" width="90%" alt="笔记编辑" /></p>
<p align="center"><img src="./example/向量化状态.png" width="90%" alt="向量化状态" /></p>
</details>

### 3. 知识导图

把知识整理成结构。

- 一句话生成完整知识体系（如"生成高中生物导图"）
- 多轮对话持续编辑节点
- 大纲视图与导图视图切换，右键菜单编辑
- 节点遮挡背诵模式

<details>
<summary>📸 查看截图</summary>
<p align="center"><img src="./example/知识导图-1.png" width="90%" alt="对话生成" /></p>
<p align="center"><img src="./example/知识导图-2.png" width="90%" alt="多轮编辑" /></p>
<p align="center"><img src="./example/知识导图-3.png" width="90%" alt="完整导图" /></p>
<p align="center"><img src="./example/知识导图-4.png" width="90%" alt="导图编辑" /></p>
<p align="center"><img src="./example/知识导图-5.png" width="90%" alt="大纲视图" /></p>
<p align="center"><img src="./example/知识导图-6.png" width="90%" alt="背诵模式" /></p>
</details>

### 4. 题目集与练习

把教材、试卷变成可练习的题库。

- 上传教材 / 试卷，AI 自动提取或生成题目集
- 每日练习、限时练习、模拟考试，自动判分
- AI 深度解析，分析知识点与解题思路
- 按知识点统计掌握率，定位薄弱环节

<details>
<summary>📸 查看截图</summary>
<p align="center"><img src="./example/题目集-1.png" width="90%" alt="一键出题" /></p>
<p align="center"><img src="./example/题目集-2.png" width="90%" alt="题库视图" /></p>
<p align="center"><img src="./example/题目集-5.png" width="90%" alt="知识点统计" /></p>
<p align="center"><img src="./example/题目集-3.png" width="90%" alt="做题界面" /></p>
<p align="center"><img src="./example/题目集-4.png" width="90%" alt="深度解析" /></p>
</details>

### 5. Anki 智能制卡

把理解推进到长期记忆。

- 对话中自然语言触发制卡（如"把这个文档做成卡片"），支持批量生成
- 可视化模板编辑器（HTML / CSS / Mustache），实时预览
- 任务看板，批量制卡进度追踪与断点续传
- 3D 翻转预览，一键同步至 Anki

<details>
<summary>📸 查看截图</summary>
<p align="center"><img src="./example/anki-制卡1.png" width="90%" alt="对话生成" /></p>
<p align="center"><img src="./example/制卡任务.png" width="90%" alt="任务看板" /></p>
<p align="center"><img src="./example/模板库-1.png" width="90%" alt="模板库" /></p>
<p align="center"><img src="./example/模板库-2.png" width="90%" alt="模板编辑器" /></p>
<p align="center"><img src="./example/anki-制卡2.png" width="90%" alt="3D预览" /></p>
<p align="center"><img src="./example/anki-制卡3.png" width="90%" alt="Anki同步" /></p>
</details>

### 6. PDF / DOCX 智能阅读

围绕文档学习，而不只是打开文档。

- PDF、DOCX 全格式支持
- 左侧对话，右侧阅读，分屏联动
- 选取页面或片段自动注入聊天上下文
- AI 回答可带页码引用

<details>
<summary>📸 查看截图</summary>
<p align="center"><img src="./example/pdf阅读-1.png" width="90%" alt="PDF阅读" /></p>
<p align="center"><img src="./example/pdf阅读-2.png" width="90%" alt="页面引用" /></p>
<p align="center"><img src="./example/pdf阅读-3.png" width="90%" alt="引用跳转" /></p>
<p align="center"><img src="./example/docx阅读-1.png" width="90%" alt="DOCX阅读" /></p>
</details>

### 7. 翻译工作台

翻译是学习链的一环。

- 全文翻译，左右分栏同步滚动
- 逐段双语对照，精读友好
- 学术 / 技术 / 文学 / 法律 / 医学等领域预设
- 自定义提示词与术语偏好

<details>
<summary>📸 查看截图</summary>
<p align="center"><img src="./example/翻译-1.png" width="90%" alt="全文翻译" /></p>
<p align="center"><img src="./example/翻译-2.png" width="90%" alt="逐段双语对照" /></p>
<p align="center"><img src="./example/翻译-3.png" width="90%" alt="翻译设置" /></p>
</details>

### 8. AI 作文批改

中英文写作批改与润色。

- 高考 / 雅思 / 托福 / 四六级 / 考研等多场景
- 多维度智能评分（词汇、语法、连贯性等），支持多轮迭代
- 修改建议与高亮标注
- 逐句润色对比
- 自定义评分维度与批改设置

<details>
<summary>📸 查看截图</summary>
<p align="center"><img src="./example/作文-1.png" width="90%" alt="类型选择与批改标注" /></p>
<p align="center"><img src="./example/作文-2.png" width="90%" alt="评分结果" /></p>
<p align="center"><img src="./example/作文-3.png" width="90%" alt="润色提升" /></p>
<p align="center"><img src="./example/作文-4.png" width="90%" alt="批改设置" /></p>
</details>

### 9. 深度调研

多步骤、长链路的调研 Agent。

- 调研前交互式确认深度与格式偏好
- 自动拆解任务：明确目标 → 联网搜索 → 本地检索 → 分析整理 → 生成报告
- 支持 7 种搜索引擎（Google CSE / SerpAPI / Tavily / Brave / SearXNG / 智谱 / 博查）
- 报告自动保存为笔记

<details>
<summary>📸 查看截图</summary>
<p align="center"><img src="./example/调研-1.png" width="90%" alt="调研模式" /></p>
<p align="center"><img src="./example/调研-2.png" width="90%" alt="多步执行" /></p>
<p align="center"><img src="./example/调研-3.png" width="90%" alt="执行进度" /></p>
<p align="center"><img src="./example/调研-5.png" width="90%" alt="自动保存笔记" /></p>
<p align="center"><img src="./example/调研-4.png" width="90%" alt="最终报告" /></p>
</details>

### 10. 学术论文搜索与管理

一站式论文检索、下载与引用。

- 通过 arXiv / OpenAlex 搜索论文，返回结构化元数据
- 批量下载 PDF，自动存入 VFS，多源自动回退（arXiv → Export 镜像 → Unpaywall）
- SHA256 去重，避免重复导入
- 支持 BibTeX、GB/T 7714、APA 引用格式
- DOI 自动解析为开放获取链接

<details>
<summary>📸 查看截图</summary>
<p align="center"><img src="./example/论文搜索-1.png" width="90%" alt="论文搜索" /></p>
<p align="center"><img src="./example/论文搜索-2.png" width="90%" alt="论文下载" /></p>
<p align="center"><img src="./example/论文搜索-3.png" width="90%" alt="论文阅读" /></p>
</details>

### 11. 智能记忆

越用越懂你。

受 [mem0](https://github.com/mem0ai/mem0) / [memU](https://github.com/NevaMind-AI/memU) 启发，在桌面端实现完整的记忆生命周期。

- 每轮对话后自动提取用户事实（身份 / 偏好 / 目标 / 学科状态）
- 新旧记忆向量比对，LLM 判定 ADD / UPDATE / APPEND / DELETE / NONE
- 分类汇总为画像，自动注入后续对话
- 标签系统：90 天未命中降权，高频命中升权，搜索命中自动康复
- 支持浏览、编辑、批量删除、导出
- 隐私模式：一键禁止所有外部 API 调用

<details>
<summary>📸 查看截图</summary>
<p align="center"><img src="./example/记忆-1.png" width="90%" alt="记忆提取" /></p>
<p align="center"><img src="./example/记忆-2.png" width="90%" alt="记忆列表" /></p>
<p align="center"><img src="./example/记忆-4.png" width="90%" alt="记忆视图" /></p>
<p align="center"><img src="./example/记忆-3.png" width="90%" alt="记忆编辑" /></p>
</details>

### 12. 技能系统与 MCP 扩展

可扩展的工作台，不是封闭的功能集合。

- 技能（Skills）按需加载 AI 能力，激活时才加载对应工具，节省 Token
- 内置 11 项技能：制卡 · 调研 · 论文 · 导图 · 题库 · 记忆 · 导师 · 文献综述 · 试卷分析 · 会话管理 · Office 套件
- 三级加载（内置 → 全局 → 项目级），支持 SKILL.md 自定义
- MCP 协议兼容，可连接 Arxiv、Context7 等外部工具
- 预置 9 家模型供应商，支持任意 OpenAI 兼容接口
- 已适配 Gemini 3、GPT-5.2 Pro、GLM-5、Seed 2.0、Kimi K2.5 等最新模型

<details>
<summary>📸 查看截图</summary>
<p align="center"><img src="./example/技能管理.png" width="90%" alt="技能管理" /></p>
<p align="center"><img src="./example/mcp-1.png" width="90%" alt="MCP调用" /></p>
<p align="center"><img src="./example/mcp-2.png" width="90%" alt="MCP管理" /></p>
<p align="center"><img src="./example/模型分配.png" width="90%" alt="模型配置" /></p>
<p align="center"><img src="./example/mcp-3.png" width="90%" alt="Arxiv搜索" /></p>
</details>

### 13. 本地优先与数据治理

学习数据由你控制。

- 全部数据本地存储（SQLite + LanceDB + Blob）
- 全量备份与恢复，数据导入导出
- AES-256-GCM 加密敏感数据，双槽位 A/B 切换
- 审计日志，全操作可追溯
- 云同步（实验性）：S3 兼容存储与 WebDAV

## 下载安装

前往 [GitHub Releases](https://github.com/helixnow/deep-student/releases/latest) 下载最新版：

| 平台 | 安装包 | 架构 |
|:---:|---|---|
| macOS | `.dmg` | Apple Silicon / Intel |
| Windows | `.exe` | x86_64 |
| Android | `.apk` | arm64 |

> iOS 可通过 Xcode 本地构建，详见 [构建配置指南](./BUILD-CONFIG.md)。

### 上手建议

第一次打开后，试试这条路径：

1. 导入一份 PDF / 教材 / 论文
2. 围绕材料发起对话
3. 生成一份思维导图
4. 继续生成题目集或闪卡
5. 用翻译 / 精读继续深化

这条路径最能体现 DeepStudent 的核心价值：不是单点功能，是一整条学习链。

---

## 技术上有什么不同

如果你是开发者，这部分值得看。

**统一学习数据层** — 所有学习资源（教材、笔记、题目、导图、翻译、记忆）共享统一的虚拟文件系统（VFS）。资源导入后自动 OCR + 向量化，使其 AI 可读、可检索；技能系统为 AI 提供操作工具，使其 AI 可写。上层应用是同一份数据的不同视图，而非各自独立的孤岛。

**Local-first** — 元数据（SQLite）、向量索引（LanceDB）、文件内容（Blob）全部本地存储。学习数据天然需要长期沉淀，不应该依赖第三方服务的存续。

**技能驱动的可扩展架构** — 对话引擎通过技能系统按需加载 AI 能力，每个技能封装指令与工具集。配合 MCP 协议和多搜索引擎接入，形成可扩展的工作流管线。

**从材料到记忆的闭环** — 多数产品止步于"读"或"问"。DeepStudent 做的是完整链路：**导入 → 理解 → 调研 → 结构化 → 练习 → 制卡 → 记忆**。

---

## 架构概览

```
DeepStudent
├── 学习资料层：PDF / DOCX / 教材 / 题目 / 笔记 / 导图 / 翻译结果
├── 统一数据层：VFS + SQLite 元数据 + LanceDB 向量索引 + Blob 文件存储
├── 工作流层：对话 / 调研 / 导图 / 题目集 / 翻译 / 作文 / 记忆
├── 扩展层：Skills / MCP / 多搜索引擎 / 自定义模型供应商
└── 交互层：桌面端（macOS · Windows）与移动端（Android · iOS）
```

<details>
<summary>查看代码结构</summary>

```
DeepStudent
├── src/                    # React 前端
│   ├── chat-v2/            #   Chat V2 对话引擎
│   │   ├── adapters/       #     后端适配器 (TauriAdapter)
│   │   ├── skills/         #     技能系统 (builtin / builtin-tools / 加载器)
│   │   ├── components/     #     对话 UI 组件
│   │   └── plugins/        #     插件 (事件处理、工具渲染)
│   ├── components/         #   UI 组件（含各功能模块页面）
│   ├── stores/             #   Zustand 状态管理
│   ├── mcp/                #   MCP 客户端 & 内置工具定义
│   ├── essay-grading/      #   作文批改前端
│   ├── translation/        #   翻译工作台前端
│   ├── command-palette/    #   命令面板（快捷键 / 收藏 / 拼音搜索）
│   ├── dstu/               #   DSTU 资源协议 & VFS API
│   ├── api/                #   前端 API 层 (Tauri invoke 封装)
│   ├── hooks/              #   React Hooks（主题、快捷键、平台检测等）
│   ├── services/           #   服务层（更新检查、审计、日志等）
│   ├── engines/            #   渲染引擎（Markdown、代码高亮等）
│   ├── debug-panel/        #   调试面板 & 开发工具
│   └── locales/            #   i18n 国际化（中 / 英）
├── src-tauri/              # Tauri / Rust 后端
│   └── src/
│       ├── chat_v2/        #   对话 Pipeline & 工具执行器
│       ├── llm_manager/    #   多模型管理 & 适配 (含 9 家内置供应商)
│       ├── vfs/            #   虚拟文件系统 & 向量化索引
│       ├── dstu/           #   DSTU 资源协议后端
│       ├── tools/          #   联网搜索引擎适配 (7 引擎)
│       ├── memory/         #   智能记忆（自进化画像 / 三层架构 / LLM 决策）
│       ├── mcp/            #   MCP 协议实现
│       ├── translation/    #   翻译 Pipeline 后端
│       ├── cloud_storage/  #   云同步 (S3 / WebDAV)
│       ├── data_governance/ #  备份、审计、迁移
│       ├── essay_grading/  #   作文批改后端
│       ├── qbank_grading/  #   题目集 AI 评分
│       ├── crypto/         #   加密 & 安全存储 (AES-256-GCM)
│       ├── multimodal/     #   多模态处理
│       ├── ocr_adapters/   #   OCR 适配器 (6 引擎)
│       └── llm_usage/      #   LLM 使用量追踪
├── docs/                   # 用户文档 & 设计文档
├── tests/                  # Vitest 单元测试 & Playwright CT
└── .github/workflows/      # CI / Release 自动化
```

</details>

---

## 技术栈

| 领域 | 技术方案 |
|------|----------|
| **前端框架** | React 18 + TypeScript 5.6 + Vite 6 |
| **UI 组件** | Tailwind CSS 3 + Radix UI + Lucide Icons |
| **桌面 / 移动** | Tauri 2 (Rust) — macOS · Windows · Android · iOS |
| **数据存储** | SQLite (Rusqlite) + LanceDB (向量检索) + 本地 Blob |
| **状态管理** | Zustand 5 + Immer |
| **编辑器** | Milkdown (Markdown) + CodeMirror (代码) |
| **文档处理** | PDF.js + pdfium-render + OCR 多引擎适配 |
| **搜索引擎** | Google CSE · SerpAPI · Tavily · Brave · SearXNG · 智谱 · 博查 |
| **CI / CD** | GitHub Actions — lint · type-check · build · Release Please |

---

## 开发

### 环境要求

| 工具 | 版本 | 说明 |
|------|------|------|
| **Node.js** | v20+ | 前端构建 |
| **Rust** | Stable | 后端编译（建议通过 [rustup](https://rustup.rs) 安装） |
| **npm** | — | 包管理器（请勿混用 pnpm / yarn） |

### 本地开发

```bash
git clone https://github.com/helixnow/deep-student.git
cd deep-student

npm ci
npm run dev
npm run dev:tauri
```

更多打包与构建信息见 [BUILD-CONFIG.md](./BUILD-CONFIG.md)

---

## 文档

| 文档 | 说明 |
|------|------|
| [快速入门](https://deepstudent.cn/docs/) | 5 分钟上手指南 |
| [用户手册](https://deepstudent.cn/docs/) | 完整功能使用说明 |
| [构建配置](./BUILD-CONFIG.md) | 全平台构建与打包 |
| [更新日志](./CHANGELOG.md) | 版本变更记录 |
| [安全政策](./SECURITY.md) | 漏洞报告流程 |

---

## 路线图

正在通往 **v1.0**，近期重点：

- 用户体验与稳定性提升
- 桌面端与移动端 UI/UX 优化
- 云同步与备份能力增强
- 资源全生命周期管理优化
- 技能与工作流继续扩展
- 更多新模型接入与适配

---

## 项目历程

DeepStudent 起源于 2025 年 3 月的一个 Python demo，经过近一年持续迭代：

| 时间 | 里程碑 |
|------|--------|
| **2025.03** | 🌱 项目萌芽 — Python demo 原型，验证 AI 辅助学习的核心想法 |
| **2025.05** | 🔄 技术栈迁移 — 切换至 Tauri + React + Rust 架构 |
| **2025.08** | 🎨 大规模 UI 重构 — 迁移至 shadcn-ui，引入 Chat 架构、知识库向量化 |
| **2025.09** | 📝 笔记系统与模板管理 — Milkdown 编辑器集成、Anki 模板批量导入 |
| **2025.10** | 🌐 国际化与 E2E 测试 — i18n 全覆盖、Playwright 测试、Lance 向量存储迁移 |
| **2025.11** | 💬 Chat V2 架构 — 全新对话引擎（多模型对比、工具事件系统、快照监控） |
| **2025.12** | ⚡ 性能优化 — 会话加载并行化、配置缓存、DSTU 资源协议 |
| **2026.01** | 🧩 技能系统与 VFS — 文件式技能加载、统一虚拟文件系统 |
| **2026.02** | 🚀 开源发布 — 更名 DeepStudent，发布至 v0.9.23；新增翻译工作台、云同步、会话分支、智能记忆增强等 |

---

## 贡献

欢迎一起把 DeepStudent 做得更好。

1. 阅读 [CONTRIBUTING.md](./CONTRIBUTING.md) 了解开发流程
2. 提交 PR 前请通过 `npm run lint` 与类型检查
3. Bug 与建议请提交 [Issue](https://github.com/helixnow/deep-student/issues)

---

## 许可证

[AGPL-3.0](./LICENSE)

---

## 致谢

DeepStudent 的诞生离不开以下优秀的开源项目：

**框架与运行时**
[Tauri](https://tauri.app) · [React](https://react.dev) · [Vite](https://vite.dev) · [TypeScript](https://www.typescriptlang.org) · [Rust](https://www.rust-lang.org) · [Tokio](https://tokio.rs)

**编辑器与内容渲染**
[Milkdown](https://milkdown.dev) · [ProseMirror](https://prosemirror.net) · [CodeMirror](https://codemirror.net) · [KaTeX](https://katex.org) · [Mermaid](https://mermaid.js.org) · [react-markdown](https://github.com/remarkjs/react-markdown)

**UI 与样式**
[Tailwind CSS](https://tailwindcss.com) · [Radix UI](https://www.radix-ui.com) · [Lucide](https://lucide.dev) · [Framer Motion](https://www.framer.com/motion) · [Recharts](https://recharts.org) · [React Flow](https://reactflow.dev)

**数据与状态**
[LanceDB](https://lancedb.com) · [SQLite](https://www.sqlite.org) / [rusqlite](https://github.com/rusqlite/rusqlite) · [Apache Arrow](https://arrow.apache.org) · [Zustand](https://zustand.docs.pmnd.rs) · [Immer](https://immerjs.github.io/immer) · [Serde](https://serde.rs)

**文档处理**
[PDF.js](https://mozilla.github.io/pdf.js/) · [pdfium-render](https://github.com/nicholasgasior/pdfium-render) · [docx-preview](https://github.com/nicholasgasior/docx-preview) · [docx-rs](https://github.com/cstkingkey/docx-rs) · [umya-spreadsheet](https://github.com/MathNya/umya-spreadsheet) · [Mustache](https://mustache.github.io) · [DOMPurify](https://github.com/cure53/DOMPurify)

**国际化与工具链**
[i18next](https://www.i18next.com) · [date-fns](https://date-fns.org) · [Vitest](https://vitest.dev) · [Playwright](https://playwright.dev) · [ESLint](https://eslint.org) · [Sentry](https://sentry.io)

---

<p align="center">
  <sub>Made with ❤️ for Lifelong Learners</sub>
</p>
