<div align="center">

<img src="./public/logo.svg" alt="DeepStudent" width="100" />

# DeepStudent

**Deep Student to You — AI 原生的本地优先开源学习系统**

[![CI](https://github.com/000haoji/deep-student/actions/workflows/ci.yml/badge.svg)](https://github.com/000haoji/deep-student/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/000haoji/deep-student?color=blue&label=release)](https://github.com/000haoji/deep-student/releases/latest)
[![License](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Stars](https://img.shields.io/github/stars/000haoji/deep-student?style=social)](https://github.com/000haoji/deep-student)

[![macOS](https://img.shields.io/badge/-macOS-black?style=flat-square&logo=apple&logoColor=white)](#下载安装)
[![Windows](https://img.shields.io/badge/-Windows-blue?style=flat-square&logo=windows&logoColor=white)](#下载安装)
[![Android](https://img.shields.io/badge/-Android-green?style=flat-square&logo=android&logoColor=white)](#下载安装)

智能对话 · 知识管理 · Anki 制卡 · 全能阅读 · 深度调研 · 技能扩展

[**下载安装**](#下载安装) · [快速入门](./docs/user-guide/00-快速入门.md) · [用户手册](./docs/user-guide/README.md) · [参与贡献](./CONTRIBUTING.md) · [报告问题](https://github.com/000haoji/deep-student/issues)

</div>

<p align="center">
  <img src="./example/主页面.png" width="68%" alt="桌面端主界面" />
  <img src="./example/移动端主页面.png" width="28%" alt="移动端主界面" />
</p>

---

## Highlights

| | 功能 | 说明 |
|:---:|---|---|
| 💬 | **智能对话** | 多模态输入、深度推理（思维链）、多模型对比、RAG 知识检索 |
| 📚 | **学习资源中心** | VFS 统一管理笔记/教材/题库，批量 OCR 与向量化索引 |
| 🃏 | **Anki 智能制卡** | 对话式批量制卡，可视化模板编辑，断点续传，一键同步 Anki |
| 🔬 | **深度调研** | 多步骤 Agent，联网搜索（7 引擎），生成结构化报告并保存笔记 |
| 🧠 | **知识导图** | AI 对话生成知识体系，多轮编辑，大纲/导图视图切换，背诵模式 |
| 📖 | **智能阅读器** | PDF / DOCX 分屏阅读，页面引用注入对话上下文 |
| 📝 | **题库与练习** | 一键出题，每日 / 限时 / 模拟考试（按题型难度配置），AI 深度解析 |
| ✍️ | **作文批改** | 多场景评分（高考 / 雅思 / 托福 / 四六级），修改建议与高亮标注 |
| 🧩 | **技能系统** | 按需加载 AI 能力，内置导师 / 调研 / 文献综述等技能，支持自定义 |
| 🔌 | **MCP 扩展** | 兼容 Model Context Protocol，连接 Arxiv、Context7 等外部工具 |
| 🏠 | **本地优先** | 全部数据本地存储（SQLite + LanceDB + Blob），完整审计与备份 |

---

## 下载安装

前往 [GitHub Releases](https://github.com/000haoji/deep-student/releases/latest) 下载最新版本：

| 平台 | 安装包 | 架构 |
|:---:|--------|------|
| <img src="https://img.shields.io/badge/-macOS-black?style=flat-square&logo=apple&logoColor=white" /> | `.dmg` | Apple Silicon / Intel |
| <img src="https://img.shields.io/badge/-Windows-blue?style=flat-square&logo=windows&logoColor=white" /> | `.exe` (NSIS 安装器) | x86_64 |
| <img src="https://img.shields.io/badge/-Android-green?style=flat-square&logo=android&logoColor=white" /> | `.apk` | arm64 |

> iOS 版通过 Xcode 本地构建，详见 [构建配置指南](./BUILD-CONFIG.md)。

---

## 目录

- [核心理念](#核心理念)
- [功能详解](#功能详解)
  - [AI 智能对话](#1-ai-智能对话-chat-v2) · [学习资源中心](#2-学习资源中心-learning-hub) · [Anki 智能制卡](#3-anki-智能制卡-chatanki)
  - [技能系统](#4-技能系统-skills) · [深度调研](#5-深度调研-research-agent) · [知识导图](#6-知识导图-mindmap)
  - [智能阅读器](#7-pdfdocx-智能阅读) · [题库与练习](#8-题目集与-ai-解析-qbank) · [智能记忆](#9-智能记忆-ai-memory)
  - [作文批改](#10-ai-作文批改-essay) · [MCP 与模型配置](#11-mcp-扩展与模型配置) · [数据治理](#12-数据治理)
- [快速上手（开发）](#快速上手)
- [架构概览](#架构概览)
- [技术栈](#技术栈)
- [贡献](#贡献)
- [许可证](#许可证)

---

## 核心理念

DeepStudent 旨在构建一个**完全 AI 原生**的学习闭环，解决碎片化学习痛点：

```
┌─────────────────────────────────────────────────────────┐
│                      DeepStudent                        │
│                                                         │
│  ┌──────────┐  ┌───────────┐  ┌──────────┐             │
│  │  Chat V2 │  │ Learning  │  │ CardForge│   ...Apps   │
│  │  (对话)  │  │    Hub    │  │  (制卡)  │             │
│  └────┬─────┘  └─────┬─────┘  └────┬─────┘             │
│       └───────────────┼─────────────┘                   │
│               引用 / RAG 检索                            │
│  ┌──────────────────────────────────────────────────┐   │
│  │          VFS · 虚拟文件系统 (SSOT)                │   │
│  │    笔记 · 教材 · 题库 · 导图 · 翻译 · 作文       │   │
│  └──────────────────────┬───────────────────────────┘   │
│                         │                               │
│  ┌──────────────────────▼───────────────────────────┐   │
│  │     向量化流水线: OCR → 分块 → 嵌入 → 索引       │   │
│  └──────────────────────┬───────────────────────────┘   │
│                         │                               │
│  ┌──────────┐  ┌───────▼───────┐  ┌──────────────┐     │
│  │  SQLite  │  │    LanceDB    │  │  Blob Files  │     │
│  │ (元数据) │  │  (向量检索)   │  │  (原始文件)  │     │
│  └──────────┘  └───────────────┘  └──────────────┘     │
│                                                         │
│                  🔒 全部数据本地存储                      │
└─────────────────────────────────────────────────────────┘
```

- **AI 原生数据层**：统一的 **虚拟文件系统 (VFS)** 作为所有学习资源的单一数据源 (SSOT)。资源存入后进入待索引队列，通过向量化流水线（OCR → 分块 → 嵌入生成 → LanceDB 存储）批量处理，成为 AI 可读、可检索、可操作的标准资产。
- **以数据为中心**：上层应用（Chat、Learning Hub、CardForge）是对 VFS 数据的不同视图。Chat V2 通过引用模式调用 VFS 资源进行 RAG 检索与上下文注入，打破应用间的数据孤岛。
- **本地优先**：所有数据（SQLite 元数据 + LanceDB 向量库 + Blob 文件）存储在本地，安全可控，支持完整审计与备份。

## 功能详解

### 1. AI 智能对话 (Chat V2)

DeepStudent 的对话引擎专为学习场景打造，支持多模态输入、深度推理与多模型对比。

- **多模态与引用**：支持图片、PDF、Word 等多格式文件拖拽上传。通过引用面板，可直接选取知识库中的笔记或教材作为上下文，实时显示 Token 估算。
- **深度推理**：内置推理模式（思维链），展示 AI 思考全过程，适合处理复杂理科题目或深度分析。
- **多模型对比**：支持同时向多个模型发送相同问题，并排列展示各模型的回答，便于横向对比评估。
- **会话管理**：支持会话分组、图标自定义、分组 System Prompt 注入与默认技能配置，方便管理不同学科的对话上下文。

<details>
<summary>📸 查看截图</summary>
<p align="center"><img src="./example/会话浏览.png" width="90%" alt="会话管理" /></p>
<p align="center"><img src="./example/分组.png" width="90%" alt="会话分组" /></p>
<p align="center"><img src="./example/anki-发送.png" width="90%" alt="引用与发送" /></p>
</details>

### 2. 学习资源中心 (Learning Hub)

像 Finder/访达一样管理你的所有学习资产。

- **全格式支持**：笔记、PDF 教材、题目集、翻译练习、作文批改、知识导图一站式管理。
- **向量化索引**：资源导入后进入待索引队列，支持批量触发 OCR 与向量化，状态实时可视。
- **全能阅读器**：内置 PDF/Office/Markdown 阅读器，支持双页阅读与书签标注。

<details>
<summary>📸 查看截图</summary>
<p align="center"><img src="./example/笔记-1.png" width="90%" alt="笔记编辑" /></p>
<p align="center"><img src="./example/向量化状态.png" width="90%" alt="向量化状态" /></p>
</details>

### 3. Anki 智能制卡 (ChatAnki)

打通从"输入"到"内化"的最后一步。

- **对话式制卡**：在 Chat 中通过自然语言（如"把这个文档做成卡片"）触发制卡，支持批量生成。
- **可视化模板**：内置 Template Designer，支持 HTML/CSS/Mustache 代码编辑与实时预览。
- **任务管理**：提供任务看板，实时监控批量制卡进度，支持断点续传。
- **3D 预览与同步**：生成结果支持 3D 翻转预览，确认无误后一键同步至 Anki。

<details>
<summary>📸 查看截图</summary>
<p align="center"><img src="./example/anki-制卡1.png" width="90%" alt="对话生成" /></p>
<p align="center"><img src="./example/制卡任务.png" width="90%" alt="任务看板" /></p>
<p align="center"><img src="./example/模板管理.png" width="90%" alt="模板管理" /></p>
<p align="center"><img src="./example/anki-制卡2.png" width="90%" alt="3D预览" /></p>
<p align="center"><img src="./example/anki-制卡3.png" width="90%" alt="Anki同步" /></p>
</details>

### 4. 技能系统 (Skills)

通过技能（Skills）按需扩展 AI 能力，避免 System Prompt 臃肿。

- **场景化能力**：内置导师模式（苏格拉底式教学）、调研模式（联网深度搜索）、文献综述助手等。
- **工具按需加载**：激活"知识导图"技能时才加载绘图工具，节省 Token。
- **技能管理**：可视化的技能管理面板，支持导入/导出自定义技能。

<details>
<summary>📸 查看截图</summary>
<p align="center"><img src="./example/技能管理.png" width="90%" alt="技能管理" /></p>
<p align="center"><img src="./example/调研-1.png" width="90%" alt="调研模式" /></p>
</details>

### 5. 深度调研 (Research Agent)

多步骤、长链路的深度调研 Agent。通过 `todo-tools` 跟踪进度，`web_search` 联网检索，`note_create` 保存笔记。

- **交互式引导**：调研开始前通过 `ask_user` 工具向用户确认调研深度和输出格式偏好。
- **多步执行**：自动拆解任务（明确目标 → 网络搜索 → 本地检索 → 整理分析 → 生成报告），实时显示步骤进度。
- **联网搜索**：支持配置并切换 7 种搜索引擎（Google CSE / SerpAPI / Tavily / Brave / SearXNG / 智谱 / 博查）。
- **结构化成文**：按调研技能工作流生成结构化报告，并通过 `note_create` 保存为笔记。

<details>
<summary>📸 查看截图</summary>
<p align="center"><img src="./example/调研-2.png" width="90%" alt="多步执行" /></p>
<p align="center"><img src="./example/调研-3.png" width="90%" alt="执行进度" /></p>
<p align="center"><img src="./example/调研-5.png" width="90%" alt="自动保存笔记" /></p>
<p align="center"><img src="./example/调研-4.png" width="90%" alt="最终报告" /></p>
</details>

### 6. 知识导图 (MindMap)

AI 驱动的知识结构化工具。

- **对话生成**：一句话生成完整学科知识体系（如"生成高中生物导图"）。
- **多轮编辑**：支持通过对话持续修正、扩展导图节点。
- **视图切换**：支持大纲视图和导图视图，右键菜单提供丰富编辑功能。
- **背诵模式**：支持节点遮挡背诵，辅助记忆。

<details>
<summary>📸 查看截图</summary>
<p align="center"><img src="./example/知识导图-1.png" width="90%" alt="对话生成" /></p>
<p align="center"><img src="./example/知识导图-2.png" width="90%" alt="多轮编辑" /></p>
<p align="center"><img src="./example/知识导图-3.png" width="90%" alt="完整导图" /></p>
<p align="center"><img src="./example/知识导图-4.png" width="90%" alt="导图编辑" /></p>
<p align="center"><img src="./example/知识导图-5.png" width="90%" alt="大纲视图" /></p>
<p align="center"><img src="./example/知识导图-6.png" width="90%" alt="背诵模式" /></p>
</details>

### 7. PDF/DOCX 智能阅读

不仅仅是阅读，更是与知识的对话。

- **全格式支持**：PDF、Word (DOCX) 等文档均可阅读。
- **分屏交互**：左侧对话，右侧阅读，实时联动。
- **页面引用**：在 PDF 阅读器中选取页面，自动注入聊天上下文；AI 回答可包含页码引用。

<details>
<summary>📸 查看截图</summary>
<p align="center"><img src="./example/pdf阅读-1.png" width="90%" alt="PDF阅读" /></p>
<p align="center"><img src="./example/pdf阅读-2.png" width="90%" alt="页面引用" /></p>
<p align="center"><img src="./example/pdf阅读-3.png" width="90%" alt="引用跳转" /></p>
<p align="center"><img src="./example/docx阅读-1.png" width="90%" alt="DOCX阅读" /></p>
</details>

### 8. 题目集与 AI 解析 (QBank)

将教材一键转化为可练习的题库。

- **一键出题**：上传教材/试卷，AI 自动提取或生成题目集。
- **多种练习模式**：支持每日练习、限时练习、模拟考试等多种做题模式，实时判分。
- **模拟考试配置**：支持按题型/难度分布配置组卷参数。
- **AI 解析**：支持对题目触发 AI 深度解析，分析知识点与解题思路。
- **知识点视图**：按知识点分类统计题目分布和掌握率，精准定位薄弱环节。

<details>
<summary>📸 查看截图</summary>
<p align="center"><img src="./example/题目集-1.png" width="90%" alt="一键出题" /></p>
<p align="center"><img src="./example/题目集-2.png" width="90%" alt="题库视图" /></p>
<p align="center"><img src="./example/题目集-5.png" width="90%" alt="知识点统计" /></p>
<p align="center"><img src="./example/题目集-3.png" width="90%" alt="做题界面" /></p>
<p align="center"><img src="./example/题目集-4.png" width="90%" alt="深度解析" /></p>
</details>

### 9. 智能记忆 (AI Memory)

让 AI 拥有长期记忆，越用越懂你。

- **主动记忆（默认策略）**：在深度学者技能默认策略下，AI 会主动回忆并按需保存高复用信息。
- **记忆管理**：可视化的记忆管理面板，支持编辑、整理记忆条目。
- **上下文延续**：后续对话中按需调用记忆检索工具，保持上下文连续性。

<details>
<summary>📸 查看截图</summary>
<p align="center"><img src="./example/记忆-1.png" width="90%" alt="记忆提取" /></p>
<p align="center"><img src="./example/记忆-2.png" width="90%" alt="记忆列表" /></p>
<p align="center"><img src="./example/记忆-4.png" width="90%" alt="记忆视图" /></p>
<p align="center"><img src="./example/记忆-3.png" width="90%" alt="记忆编辑" /></p>
</details>

### 10. AI 作文批改 (Essay)

全自动的中英文作文批改与润色。

- **多场景支持**：覆盖高考、雅思、托福、考研、四六级等多种考试标准。
- **智能评分**：基于 AI 的多维度评分（词汇、语法、连贯性等）。
- **修改建议**：提供具体的用词、语法修改建议与高亮标注。

<details>
<summary>📸 查看截图</summary>
<p align="center"><img src="./example/作文批改-1.png" width="90%" alt="类型选择" /></p>
<p align="center"><img src="./example/作文-1.png" width="90%" alt="评分结果" /></p>
<p align="center"><img src="./example/作文-2.png" width="90%" alt="详细建议" /></p>
</details>

### 11. MCP 扩展与模型配置

拥抱开放生态，高度可定制。

- **MCP 支持**：兼容 Model Context Protocol，可连接 Arxiv、Context7 等外部工具服务。
- **多模型管理**：预置 9 家供应商（SiliconFlow / DeepSeek / 通义千问 / 智谱 AI / 字节豆包 / MiniMax / 月之暗面 / OpenAI / Google Gemini），同时支持添加任何兼容 OpenAI 协议的自定义供应商，可精细配置不同功能的模型分配。

<details>
<summary>📸 查看截图</summary>
<p align="center"><img src="./example/mcp-1.png" width="90%" alt="MCP调用" /></p>
<p align="center"><img src="./example/mcp-2.png" width="90%" alt="MCP管理" /></p>
<p align="center"><img src="./example/模型分配.png" width="90%" alt="模型配置" /></p>
<p align="center"><img src="./example/mcp-3.png" width="90%" alt="Arxiv搜索" /></p>
<p align="center"><img src="./example/mcp-4.png" width="90%" alt="搜索详情" /></p>
</details>

### 12. 数据治理

完善的数据管理与安全机制：

- **备份与恢复**：支持全量/增量备份，数据导入导出。
- **审计日志**：记录所有数据操作，可追溯。
- **数据库状态**：实时查看 SQLite 和 LanceDB 的运行状态。

## 快速上手

### 环境要求

| 工具 | 版本 | 说明 |
|------|------|------|
| **Node.js** | v20+ | 前端构建 |
| **Rust** | Stable | 后端编译（建议通过 [rustup](https://rustup.rs) 安装） |
| **npm** | — | 包管理器（请勿混用 pnpm / yarn） |

### 开发环境

```bash
# 克隆项目
git clone https://github.com/000haoji/deep-student.git
cd deep-student

# 安装依赖
npm ci

# 启动前端开发服务器 (端口 1422)
npm run dev

# 启动 Tauri 桌面应用 (前端 + Rust 后端)
npm run dev:tauri
```

> 更多构建命令（macOS / Windows / iOS / Android 打包），请参考 [构建配置指南](./BUILD-CONFIG.md)。

---

## 架构概览

```
DeepStudent
├── src/                    # React 前端
│   ├── chat-v2/            #   Chat V2 对话引擎（适配器、插件、技能）
│   ├── stores/             #   Zustand 状态管理
│   ├── components/         #   UI 组件
│   └── api/                #   前端 API 层
├── src-tauri/              # Tauri / Rust 后端
│   └── src/
│       ├── chat_v2/        #   对话 pipeline & 工具执行器
│       ├── llm_manager/    #   多模型管理 & 适配
│       ├── tools/          #   联网搜索、RAG、文件处理
│       ├── vfs/            #   虚拟文件系统
│       └── question_bank_service.rs
├── docs/                   # 用户文档 & 设计文档
├── tests/                  # Vitest 单元测试 & Playwright CT
└── .github/workflows/      # CI / Release 自动化
```

---

## 技术栈

| 领域 | 技术方案 |
|------|----------|
| **前端框架** | React 18 + TypeScript + Vite 6 |
| **UI 组件** | Tailwind CSS + Ant Design 5 + Radix UI |
| **桌面 / 移动** | Tauri 2 (Rust) — macOS · Windows · Android · iOS |
| **数据存储** | SQLite (Rusqlite) + LanceDB (向量检索) + 本地 Blob |
| **状态管理** | Zustand 5 + Immer |
| **编辑器** | Milkdown (Markdown) + CodeMirror (代码) |
| **文档处理** | PDF.js + OCR (DeepSeek / Paddle) |
| **搜索引擎** | Google CSE · SerpAPI · Tavily · Brave · SearXNG · 智谱 · 博查 |
| **CI / CD** | GitHub Actions — lint · type-check · build · Release Please |

---

## 文档

| 文档 | 说明 |
|------|------|
| [快速入门](./docs/user-guide/00-快速入门.md) | 5 分钟上手指南 |
| [用户手册](./docs/user-guide/README.md) | 完整功能使用说明 |
| [构建配置](./BUILD-CONFIG.md) | 全平台构建与打包 |
| [更新日志](./CHANGELOG.md) | 版本变更记录 |
| [安全政策](./SECURITY.md) | 漏洞报告流程 |

---

## 贡献

欢迎社区贡献！

1. 阅读 [CONTRIBUTING.md](./CONTRIBUTING.md) 了解开发流程与提交规范。
2. 提交 PR 前请确保通过 `npm run lint` 与类型检查。
3. Bug 报告与功能建议请提交 [Issue](https://github.com/000haoji/deep-student/issues)。

---

## 项目历程

DeepStudent 起源于 2025 年 3 月的一个 Python demo 原型，经过近一年的持续迭代演进至今：

| 时间 | 里程碑 |
|------|--------|
| **2025.03** | 🌱 项目萌芽 — Python demo 原型，验证 AI 辅助学习的核心想法 |
| **2025.05** | 🔄 技术栈迁移 — 以 `ai-mistake-manager` 为名，开始切换至 **Tauri + React + Rust** 架构 |
| **2025.08** | 🎨 大规模 UI 重构 — 迁移至 shadcn-ui 体系，引入 Chat 对话架构、知识库向量化 |
| **2025.09** | 📝 笔记系统与模板管理 — Milkdown 编辑器集成、Anki 模板批量导入 |
| **2025.10** | 🌐 国际化与 E2E 测试 — i18n 全覆盖、Playwright 端到端测试、Lance 向量存储迁移 |
| **2025.11** | 💬 Chat V2 架构 — 全新对话引擎（Variant 多模型对比、工具事件系统、快照健康监控） |
| **2025.12** | ⚡ 性能优化 — 会话加载并行化、配置缓存、输入框单例架构、DSTU 资源协议 |
| **2026.01** | 🧩 技能系统与 VFS — 文件式技能加载、统一虚拟文件系统（VFS）、遗留模块清理 |
| **2026.02** | 🚀 开源发布 — 更名为 **DeepStudent**，发布 **v0.9.2**，配置 CI/CD、release-please 自动发版 |

---

## 许可证

DeepStudent 遵循 **[AGPL-3.0](LICENSE)** 开源许可证。
您可以自由使用、修改与分发，但衍生作品须同样开源。

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
[PDF.js](https://mozilla.github.io/pdf.js/) · [pdfium-render](https://github.com/nicholasgasior/pdfium-render) · [docx-preview](https://github.com/nicholasgasior/docx-preview) · [Mustache](https://mustache.github.io) · [DOMPurify](https://github.com/cure53/DOMPurify)

**国际化与工具链**
[i18next](https://www.i18next.com) · [date-fns](https://date-fns.org) · [Vitest](https://vitest.dev) · [Playwright](https://playwright.dev) · [ESLint](https://eslint.org) · [Sentry](https://sentry.io)

---

<p align="center">
  <sub>Made with ❤️ for Lifelong Learners</sub>
</p>
