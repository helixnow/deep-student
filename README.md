<div align="center">

**简体中文** | [English](./README_EN.md)

<img src="./public/logo.svg" alt="DeepStudent" width="100" />

# DeepStudent

**Deep Student to You — AI 原生的本地优先开源学习系统**

[![CI](https://github.com/helixnow/deep-student/actions/workflows/ci.yml/badge.svg)](https://github.com/helixnow/deep-student/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/helixnow/deep-student?color=blue&label=release)](https://github.com/helixnow/deep-student/releases/latest)
[![License](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Stars](https://img.shields.io/github/stars/helixnow/deep-student?style=social)](https://github.com/helixnow/deep-student)

[![macOS](https://img.shields.io/badge/-macOS-black?style=flat-square&logo=apple&logoColor=white)](#下载安装)
[![Windows](https://img.shields.io/badge/-Windows-blue?style=flat-square&logo=windows&logoColor=white)](#下载安装)
[![Android](https://img.shields.io/badge/-Android-green?style=flat-square&logo=android&logoColor=white)](#下载安装)

智能对话 · 知识管理 · Anki 制卡 · 全能阅读 · 深度调研 · 技能扩展

[**下载安装**](#下载安装) · [快速入门](https://ds.a-q.me/docs/user-guide/00-quick-start.html) · [用户手册](https://ds.a-q.me/docs/user-guide/) · [参与贡献](./CONTRIBUTING.md) · [报告问题](https://github.com/helixnow/deep-student/issues)

</div>

<p align="center">
  <img src="./example/软件主页图.png" width="90%" alt="DeepStudent 主界面" />
</p>

---

## Highlights

| | 功能 | 说明 |
|:---:|---|---|
| 💬 | **智能对话** | 多模态输入、深度推理（思维链）、多模型对比、RAG 知识检索 |
| 📚 | **学习资源中心** | VFS 统一管理笔记/教材/题库，批量 OCR 与向量化索引 |
| 🧩 | **技能系统** | 按需加载 AI 能力，内置 11 项专业技能：制卡 · 调研 · 论文 · 导图 · 题库 · 记忆 · 导师 · 文献综述 · Office 套件，支持自定义扩展 |
| 📖 | **智能阅读器** | PDF / DOCX 分屏阅读，页面引用注入对话上下文 |
| 🌐 | **翻译工作台** | 全文翻译、逐段双语对照、领域预设（学术/技术/文学/法律/医学）与自定义提示词 |
| ✍️ | **作文批改** | 多场景评分（高考 / 雅思 / 托福 / 四六级），修改建议与高亮标注 |
| 🔌 | **MCP 扩展** | 兼容 Model Context Protocol，连接 Arxiv、Context7 等外部工具 |
| 🏠 | **本地优先** | 全部数据本地存储（SQLite + LanceDB + Blob），完整审计与备份 |

---

## 下载安装

前往 [GitHub Releases](https://github.com/helixnow/deep-student/releases/latest) 下载最新版本：

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
  - [AI 智能对话](#1-ai-智能对话-chat-v2) · [学习资源中心](#2-学习资源中心-learning-hub) · [技能系统](#3-技能系统-skills)
  - [智能阅读器](#4-pdfdocx-智能阅读) · [翻译工作台](#5-翻译工作台) · [作文批改](#6-ai-作文批改-essay) · [MCP 与模型配置](#7-mcp-扩展与模型配置) · [数据治理](#8-数据治理)
- [快速上手（开发）](#快速上手)
- [架构概览](#架构概览)
- [技术栈](#技术栈)
- [贡献](#贡献)
- [许可证](#许可证)

---

## 核心理念

DeepStudent 旨在构建一个**完全 AI 原生**的学习闭环，解决碎片化学习痛点：

```
┌─────────────────────────────────────────────────────────────┐
│                        DeepStudent                          │
│                                                             │
│  ┌────────┐  ┌──────────┐  ┌────────┐  ┌────────┐           │
│  │Chat V2 │  │ Learning │  │ Essay  │  │Settings│   React   │
│  │ (对话) │  │   Hub    │  │ (作文) │  │ (配置) │           │
│  └───┬────┘  └──────────┘  └────────┘  └────────┘           │
│      │                                                      │
│  ┌───▼──────────────────────────────────────────────────┐   │
│  │               技能系统 (Skills Engine)               │   │
│  │  默认: 深度学者  │  制卡 · 调研 · 导师 · 文献综述    │   │
│  │  工具: 论文 · 导图 · 题库 · 记忆 · 检索 · ...        │   │
│  └──────────────────────────┬───────────────────────────┘   │
│ ─ ─ ─ ─ ─ ─ ─ ─Tauri IPC ─┼─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─    │
│  ┌───────────┐  ┌───────────▼───────┐  ┌────────────────┐   │
│  │ LLM Mgr   │  │   Chat Pipeline   │  │  MCP Runtime   │   │
│  │ (9供应商) │◄─┤   + 工具执行器    ├─►│  (外部工具)    │   │
│  └───────────┘  └────────┬──────────┘  └────────────────┘   │
│                           │  引用 / RAG 检索                │
│  ┌────────────────────────▼────────────────────────────┐    │
│  │         VFS · 虚拟文件系统 (SSOT)                   │    │
│  │   笔记 · 教材 · 题库 · 导图 · 翻译 · 作文 · 记忆    │    │
│  └────────────────────────┬────────────────────────────┘    │
│  ┌────────────────────────▼────────────────────────────┐    │
│  │    向量化流水线: OCR → 分块 → Embedding → 索引      │    │
│  └────────────────────────┬────────────────────────────┘    │
│  ┌──────────┐  ┌──────────▼────┐  ┌──────────────┐          │
│  │  SQLite  │  │    LanceDB    │  │  Blob Files  │          │
│  │ (元数据) │  │  (向量检索)   │  │  (原始文件)  │          │
│  └──────────┘  └───────────────┘  └──────────────┘          │
│                                                             │
│                   🔒 全部数据本地存储                       │
└─────────────────────────────────────────────────────────────┘
       │                  │                   │
  LLM APIs (9家)  Web Search (7引擎)   MCP Servers
```

- **AI 原生数据层**：统一的 **虚拟文件系统 (VFS)** 作为所有学习资源的单一数据源 (SSOT)。资源存入后进入待索引队列，通过向量化流水线（OCR → 分块 → 嵌入生成 → LanceDB 存储）批量处理，成为 AI 可读、可检索、可操作的标准资产。
- **技能驱动**：Chat V2 通过**技能系统**按需加载 AI 能力（制卡、调研、论文、导图等）。每个技能封装指令与工具集，经后端 Pipeline 调度执行，通过工具执行器操作 VFS 数据，实现对话即操作。
- **以数据为中心**：上层应用（Chat V2、Learning Hub、Essay）是对 VFS 数据的不同视图。Chat V2 通过引用与 RAG 检索调用 VFS 资源注入上下文，打破应用间的数据孤岛。
- **本地优先**：所有数据（SQLite 元数据 + LanceDB 向量库 + Blob 文件）存储在本地，安全可控，支持完整审计与备份。

## 功能详解

### 1. AI 智能对话 (Chat V2)

DeepStudent 的对话引擎专为学习场景打造，支持多模态输入与深度推理。

- **多模态与引用**：支持图片、PDF、Word 等多格式文件拖拽上传。通过引用面板，可直接选取知识库中的笔记或教材作为上下文，实时显示 Token 估算。
- **深度推理**：内置推理模式（思维链），展示 AI 思考全过程，适合处理复杂理科题目或深度分析。
- **多模型对比 (实验性)**：支持同时向多个模型发送相同问题，以并排卡片方式展示各模型的回答，便于横向对比评估。
- **子代理执行 (实验性)**：内置 subagent-worker 机制，支持主代理将复杂任务拆解并分发给子代理执行，子代理在后台自动完成任务并汇报结果。
- **会话管理**：支持会话分组、图标自定义、分组 System Prompt 注入与默认技能配置，方便管理不同学科的对话上下文。

<details>
<summary>📸 查看截图</summary>
<p align="center"><img src="./example/会话浏览.png" width="90%" alt="会话管理" /></p>
<p align="center"><img src="./example/分组.png" width="90%" alt="会话分组" /></p>
<p align="center"><img src="./example/anki-发送.png" width="90%" alt="引用与发送" /></p>
<p align="center"><img src="./example/并行-1.png" width="90%" alt="多模型并行选择" /></p>
<p align="center"><img src="./example/并行-2.png" width="90%" alt="多模型对比回复" /></p>
</details>

### 2. 学习资源中心 (Learning Hub)

像 Finder/访达一样管理你的所有学习资产。

- **全格式支持**：笔记、PDF 教材、题目集、翻译练习、作文批改、知识导图一站式管理。
- **向量化索引**：资源导入后进入待索引队列，支持批量触发 OCR 与向量化，状态实时可视。
- **文档阅读器**：内置 PDF / DOCX 阅读器，支持双页阅读与书签标注。

<details>
<summary>📸 查看截图</summary>
<p align="center"><img src="./example/学习资源管理器.png" width="90%" alt="学习资源管理器" /></p>
<p align="center"><img src="./example/笔记-1.png" width="90%" alt="笔记编辑" /></p>
<p align="center"><img src="./example/向量化状态.png" width="90%" alt="向量化状态" /></p>
</details>

### 3. 技能系统 (Skills)

通过技能（Skills）按需扩展 AI 能力，避免 System Prompt 臃肿。每个技能封装了特定场景的指令与工具集，激活即用。

- **默认策略（深度学者）**：始终开启，主动回忆用户记忆、本地优先检索、个性化回答，无需手动激活。
- **场景化能力**：内置 11 项专业技能，覆盖制卡、调研、论文、导图、题库、记忆、Office 套件等核心学习场景。
- **工具按需加载**：激活技能时才加载对应工具，节省 Token 开销。
- **技能管理**：可视化的技能管理面板，支持设为默认（新会话自动激活）、导入/导出自定义技能。
- **三级加载**：内置 → 全局 → 项目级，用户可通过 SKILL.md 格式编写自定义技能。

<details>
<summary>📸 查看截图</summary>
<p align="center"><img src="./example/技能管理.png" width="90%" alt="技能管理" /></p>
</details>

#### 内置技能一览

| 技能 | 类型 | 说明 |
|------|------|------|
| 🃏 **ChatAnki 智能制卡** | 整合型 | 端到端制卡闭环，批量生成 + 预览 + 同步 Anki |
| 🔬 **深度调研** | 整合型 | 多步骤 Agent，联网搜索 + 本地检索 + 结构化报告 |
| 📚 **文献综述助手** | 整合型 | 学术文献系统化调研、整理与综述撰写 |
| 🎯 **导师模式** | 独立型 | 苏格拉底式教学，引导式提问辅导 |
| 📄 **学术论文** | 工具组 | arXiv / OpenAlex 搜索，批量下载，引用格式化 |
| 🧠 **知识导图** | 工具组 | AI 生成知识体系，多轮编辑，大纲/导图切换 |
| 📝 **题目集与练习** | 工具组 | 一键出题，多种练习模式，AI 深度解析 |
| 💾 **智能记忆** | 工具组 | AI 自动识别并保存高复用信息，长期记忆 |
| 📃 **Word 文档** | 工具组 | DOCX 结构化读取、表格提取、文档生成、round-trip 编辑 |
| 📊 **Excel 表格** | 工具组 | XLSX 读取、表格提取、生成、单元格编辑、文本替换 |
| 🎬 **PPT 演示文稿** | 工具组 | PPTX 结构化读取、演示文稿生成、round-trip 编辑、文本替换 |

---

<details>
<summary><strong>🃏 ChatAnki 智能制卡</strong> — 打通从"输入"到"内化"的最后一步</summary>

- **对话式制卡**：在 Chat 中通过自然语言（如"把这个文档做成卡片"）触发制卡，支持批量生成。
- **可视化模板**：集成模板设计师，支持通过自然语言或 GUI 编辑器修改 HTML/CSS/Mustache 代码并实时预览。
- **任务管理**：提供任务看板，实时监控批量制卡进度，支持断点续传。
- **3D 预览与同步**：生成结果支持 3D 翻转预览，确认无误后一键同步至 Anki。

<p align="center"><img src="./example/anki-制卡1.png" width="90%" alt="对话生成" /></p>
<p align="center"><img src="./example/制卡任务.png" width="90%" alt="任务看板" /></p>
<p align="center"><img src="./example/模板库-1.png" width="90%" alt="模板库" /></p>
<p align="center"><img src="./example/模板库-2.png" width="90%" alt="模板编辑器" /></p>
<p align="center"><img src="./example/anki-制卡2.png" width="90%" alt="3D预览" /></p>
<p align="center"><img src="./example/anki-制卡3.png" width="90%" alt="Anki同步" /></p>

</details>

<details>
<summary><strong>🔬 深度调研</strong> — 多步骤、长链路的深度调研 Agent</summary>

- **交互式引导**：调研开始前通过 `ask_user` 工具向用户确认调研深度和输出格式偏好。
- **多步执行**：自动拆解任务（明确目标 → 网络搜索 → 本地检索 → 整理分析 → 生成报告），实时显示步骤进度。
- **联网搜索**：支持配置并切换 7 种搜索引擎（Google CSE / SerpAPI / Tavily / Brave / SearXNG / 智谱 / 博查）。
- **结构化成文**：生成结构化报告，并通过 `note_create` 自动保存为笔记。

<p align="center"><img src="./example/调研-1.png" width="90%" alt="调研模式" /></p>
<p align="center"><img src="./example/调研-2.png" width="90%" alt="多步执行" /></p>
<p align="center"><img src="./example/调研-3.png" width="90%" alt="执行进度" /></p>
<p align="center"><img src="./example/调研-5.png" width="90%" alt="自动保存笔记" /></p>
<p align="center"><img src="./example/调研-4.png" width="90%" alt="最终报告" /></p>

</details>

<details>
<summary><strong>📄 学术论文搜索与管理</strong> — 一站式学术论文检索、下载与引用</summary>

- **智能搜索**：通过 arXiv API 和 OpenAlex API 搜索学术论文，返回标题、作者、摘要、引用数等结构化元数据。
- **批量下载**：支持批量下载 PDF（单次最多 5 篇），自动存入 VFS，支持 arXiv ID、DOI、直接 URL 三种输入方式。
- **多源自动回退**：下载失败时自动切换备用源（arXiv → Export 镜像 → Unpaywall），最大化成功率。
- **实时进度**：每篇论文独立显示下载进度条，支持手动重试与源切换。
- **SHA256 去重**：已存在的论文自动识别并跳过，避免重复导入。
- **引用格式化**：支持 BibTeX、GB/T 7714、APA 三种标准引用格式，一键生成引用文本。
- **DOI 解析**：通过 Unpaywall API 自动将 DOI 解析为开放获取 PDF 链接。

<p align="center"><img src="./example/论文搜索-1.png" width="90%" alt="论文搜索" /></p>
<p align="center"><img src="./example/论文搜索-2.png" width="90%" alt="论文下载" /></p>
<p align="center"><img src="./example/论文搜索-3.png" width="90%" alt="论文阅读" /></p>

</details>

<details>
<summary><strong>📚 文献综述助手</strong> — 系统化的学术文献综述工作流</summary>

- **全流程覆盖**：选题 → 检索 → 筛选 → 提取 → 撰写，五阶段完整工作流。
- **多源检索**：学术搜索（arXiv + OpenAlex）+ 本地知识库 + 通用网络搜索。
- **自动输出**：按学术规范生成结构化综述报告并保存为笔记。
- **适用场景**：毕业论文、学术研究、课题申报、开题报告等。

</details>

<details>
<summary><strong>🎯 导师模式</strong> — 苏格拉底式学习导师</summary>

- **引导式教学**：不直接给答案，用提示、微步骤和追问让学习者自己发现解法。
- **单题规则**：每回合最多只问一个细分问题，避免信息过载。
- **两次尝试规则**：练习时让学习者最多尝试两次，再给出正确答案与简要理由。
- **学术诚信**：拒绝直接输出作业答案，提供平行示例和引导。
- **适用场景**：学习辅导、概念理解、作业指导、考试复习。

</details>

<details>
<summary><strong>🧠 知识导图</strong> — AI 驱动的知识结构化工具</summary>

- **对话生成**：一句话生成完整学科知识体系（如"生成高中生物导图"）。
- **多轮编辑**：支持通过对话持续修正、扩展导图节点。
- **视图切换**：支持大纲视图和导图视图，右键菜单提供丰富编辑功能。
- **背诵模式**：支持节点遮挡背诵，辅助记忆。

<p align="center"><img src="./example/知识导图-1.png" width="90%" alt="对话生成" /></p>
<p align="center"><img src="./example/知识导图-2.png" width="90%" alt="多轮编辑" /></p>
<p align="center"><img src="./example/知识导图-3.png" width="90%" alt="完整导图" /></p>
<p align="center"><img src="./example/知识导图-4.png" width="90%" alt="导图编辑" /></p>
<p align="center"><img src="./example/知识导图-5.png" width="90%" alt="大纲视图" /></p>
<p align="center"><img src="./example/知识导图-6.png" width="90%" alt="背诵模式" /></p>

</details>

<details>
<summary><strong>📝 题目集与 AI 解析</strong> — 将教材一键转化为可练习的题库</summary>

- **一键出题**：上传教材/试卷，AI 自动提取或生成题目集。
- **多种练习模式**：支持每日练习、限时练习、模拟考试等多种做题模式，自动判分。
- **模拟考试配置**：支持按题型/难度分布配置组卷参数。
- **AI 解析**：支持对题目触发 AI 深度解析，分析知识点与解题思路。
- **知识点视图**：按知识点分类统计题目分布和掌握率，精准定位薄弱环节。

<p align="center"><img src="./example/题目集-1.png" width="90%" alt="一键出题" /></p>
<p align="center"><img src="./example/题目集-2.png" width="90%" alt="题库视图" /></p>
<p align="center"><img src="./example/题目集-5.png" width="90%" alt="知识点统计" /></p>
<p align="center"><img src="./example/题目集-3.png" width="90%" alt="做题界面" /></p>
<p align="center"><img src="./example/题目集-4.png" width="90%" alt="深度解析" /></p>

</details>

<details>
<summary><strong>💾 智能记忆</strong> — 让 AI 拥有长期记忆，越用越懂你</summary>

- **主动记忆**：AI 在对话中自动识别并保存高复用信息（如学习偏好、知识背景），后续会话自动调用。
- **记忆管理**：可视化的记忆管理面板，支持编辑、整理记忆条目。
- **上下文延续**：后续对话中按需调用记忆检索工具，保持上下文连续性。

<p align="center"><img src="./example/记忆-1.png" width="90%" alt="记忆提取" /></p>
<p align="center"><img src="./example/记忆-2.png" width="90%" alt="记忆列表" /></p>
<p align="center"><img src="./example/记忆-4.png" width="90%" alt="记忆视图" /></p>
<p align="center"><img src="./example/记忆-3.png" width="90%" alt="记忆编辑" /></p>

</details>

### 4. PDF/DOCX 智能阅读

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

### 5. 翻译工作台

智能翻译，不止是逐句对照。

- **全文翻译**：支持整篇文档翻译，左右分栏同步滚动，原文与译文一目了然。
- **逐段双语对照**：逐段落拆分对齐，精确对比原文与译文差异，适合精读学习。
- **领域预设**：内置学术论文、技术文档、文学作品、法律文书、医学文献等多种翻译领域预设，一键切换翻译风格。
- **自定义提示词**：支持自定义翻译提示词，精准控制翻译语气与术语偏好。

<details>
<summary>📸 查看截图</summary>
<p align="center"><img src="./example/翻译-1.png" width="90%" alt="全文翻译" /></p>
<p align="center"><img src="./example/翻译-2.png" width="90%" alt="逐段双语对照" /></p>
<p align="center"><img src="./example/翻译-3.png" width="90%" alt="翻译设置" /></p>
</details>

### 6. AI 作文批改 (Essay)

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

### 7. MCP 扩展与模型配置

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

### 8. 数据治理

完善的数据管理与安全机制：

- **备份与恢复**：支持全量备份与恢复，数据导入导出（增量备份试验性支持）。
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
git clone https://github.com/helixnow/deep-student.git
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
│   ├── chat-v2/            #   Chat V2 对话引擎
│   │   ├── adapters/       #     后端适配器 (TauriAdapter)
│   │   ├── skills/         #     技能系统 (builtin / builtin-tools / 加载器)
│   │   ├── components/     #     对话 UI 组件
│   │   └── plugins/        #     插件 (事件处理、工具渲染)
│   ├── components/         #   UI 组件（含各功能模块页面）
│   ├── stores/             #   Zustand 状态管理
│   ├── mcp/                #   MCP 客户端 & 内置工具定义
│   ├── essay-grading/      #   作文批改前端
│   ├── dstu/               #   DSTU 资源协议 & VFS API
│   ├── api/                #   前端 API 层 (Tauri invoke 封装)
│   └── locales/            #   i18n 国际化（中 / 英）
├── src-tauri/              # Tauri / Rust 后端
│   └── src/
│       ├── chat_v2/        #   对话 Pipeline & 工具执行器
│       ├── llm_manager/    #   多模型管理 & 适配 (含 9 家内置供应商)
│       ├── vfs/            #   虚拟文件系统 & 向量化索引
│       ├── dstu/           #   DSTU 资源协议后端
│       ├── tools/          #   联网搜索引擎适配 (7 引擎)
│       ├── memory/         #   智能记忆后端
│       ├── mcp/            #   MCP 协议实现
│       ├── data_governance/ #  备份、审计、迁移
│       ├── essay_grading/  #   作文批改后端
│       └── ocr_adapters/   #   OCR 适配器 (DeepSeek VL / PaddleOCR)
├── docs/                   # 用户文档 & 设计文档
├── tests/                  # Vitest 单元测试 & Playwright CT
└── .github/workflows/      # CI / Release 自动化
```

---

## 技术栈

| 领域 | 技术方案 |
|------|----------|
| **前端框架** | React 18 + TypeScript + Vite 6 |
| **UI 组件** | Tailwind CSS + Radix UI + Lucide Icons |
| **桌面 / 移动** | Tauri 2 (Rust) — macOS · Windows · Android · iOS |
| **数据存储** | SQLite (Rusqlite) + LanceDB (向量检索) + 本地 Blob |
| **状态管理** | Zustand 5 + Immer |
| **编辑器** | Milkdown (Markdown) + CodeMirror (代码) |
| **文档处理** | PDF.js + OCR 远程适配（DeepSeek VL / PaddleOCR API） |
| **搜索引擎** | Google CSE · SerpAPI · Tavily · Brave · SearXNG · 智谱 · 博查 |
| **CI / CD** | GitHub Actions — lint · type-check · build · Release Please |

---

## 文档

| 文档 | 说明 |
|------|------|
| [快速入门](https://ds.a-q.me/docs/user-guide/00-quick-start.html) | 5 分钟上手指南 |
| [用户手册](https://ds.a-q.me/docs/user-guide/) | 完整功能使用说明 |
| [构建配置](./BUILD-CONFIG.md) | 全平台构建与打包 |
| [更新日志](./CHANGELOG.md) | 版本变更记录 |
| [安全政策](./SECURITY.md) | 漏洞报告流程 |

---

## 贡献

欢迎社区贡献！

1. 阅读 [CONTRIBUTING.md](./CONTRIBUTING.md) 了解开发流程与提交规范。
2. 提交 PR 前请确保通过 `npm run lint` 与类型检查。
3. Bug 报告与功能建议请提交 [Issue](https://github.com/helixnow/deep-student/issues)。

---

## 路线图

我们正在通往 **v1.0** 正式版的路上。以下是我们近期的关注重点：

1. **用户体验与稳定性**：展开大规模用户测试，修复已知 Bug，优化用户体验。
2. **UI/UX 升级**：对桌面端与移动端的前端设计进行进一步优化，提升视觉与交互质感。
3. **云同步与备份**：测试和实验云同步功能，强化备份功能的稳定性与可靠性。
4. **DSTU 子应用优化**：对各个 DSTU 子应用进行全面测试与性能优化。
5. **资源全生命周期管理**：对学习资源管理（导入 → 处理 → 学习 → 复习）的整个生命周期进行优化。
6. **Chat V2 模型适配**：增加更多新模型的接入支持，并优化历史模型的适配与迁移体验。

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
