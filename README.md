# DeepStudent

<div align="center">

[![License](https://img.shields.io/badge/license-AGPLv3-blue.svg)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2.0-orange.svg)](https://tauri.app)
[![React](https://img.shields.io/badge/React-18-blue.svg)](https://react.dev)
[![Rust](https://img.shields.io/badge/Rust-Stable-black.svg)](https://www.rust-lang.org)

**Deep Student (dstu)**

> *Deep Student to You*

**AI 原生的本地优先开源学习系统**

DeepStudent 将智能对话、知识管理、Anki 制卡与全能阅读器无缝融合，<br/>为您打造一个隐私安全、高度可扩展的终身学习工作台。

[快速入门](./docs/user-guide/00-快速入门.md) · [用户手册](./docs/user-guide/README.md) · [开发指南](./CONTRIBUTING.md) · [报告问题](https://github.com/000haoji/deep-student/issues)

</div>

---

## 核心理念

DeepStudent 旨在构建一个**完全 AI 原生**的学习闭环，解决碎片化学习痛点：

- **AI 原生数据层 (AI-Native Data Layer)**：系统核心是一个统一的**虚拟文件系统 (VFS)**，作为所有学习资源（笔记、教材、题目集、翻译、作文、知识导图）的单一数据源 (SSOT)。资源存入后会异步进入向量化流水线（OCR 识别 → 内容分块 → 嵌入生成 → LanceDB 存储），最终成为 **AI 可读、可检索、可操作** 的标准资产。
- **以数据为中心的应用 (Data-Centric Apps)**：上层应用（Chat、Learning Hub、CardForge）是对 VFS 数据的不同视图与操作接口。Chat V2 通过引用模式调用 VFS 资源进行 RAG 检索与上下文注入，打破了应用间的数据孤岛。
- **本地优先 (Local-First)**：所有数据（SQLite 元数据 + LanceDB 向量库 + Blob 文件）存储在本地，安全可控，支持完整审计与备份，密钥不经系统钥匙串。

## 主要功能

### 智能对话 (Chat V2)
- **基于 VFS 的 RAG**：使用 `VfsFullSearchService` 检索 VFS 中的学习资源，支持文件夹范围、资源类型过滤与重排序。
- **引用模式上下文注入**：消息通过 `ContextSnapshot` 引用 VFS 资源，发送时按需解析为文本或图片块。
- **多模态交互**：支持文本、截图、PDF/DOCX/Markdown 等多格式输入，实时 Token 估算。
- **深度思考**：内置推理模式（思维链）与多模型对比，辅助深度学习与决策。

### 学习资源中心 (Learning Hub)
- **VFS 资源管理**：对 VFS 中学习资源（笔记、教材、题目集、翻译、作文、知识导图）的访达式管理与可视化。
- **智能辅助阅读**：内置专用阅读器，支持 PDF/Office 文档，集成 AI 解释、翻译与摘要。
- **自动化处理**：资源导入时同步执行 OCR 识别，异步触发向量化索引，支持索引状态追踪。

### 记忆与复习 (CardForge & Anki)
- **数据流转**：从 VFS 文档无缝提取知识点，转换为 Anki 卡片。
- **无缝同步**：直接对接 AnkiConnect，生成的卡片即刻可复习。
- **可视化预览**：支持 3D 卡片预览与素材队列管理。

### 技能系统 (Skills)
Skill 系统是 DeepStudent 的可扩展指令与工具注入机制，基于 SKILL.md 规范设计。

- **渐进披露架构**：工具不再全量预加载，而是通过 Skill 的 `embeddedTools` 字段按需注入，显著减少上下文占用。
- **三级加载机制**：内置 Skill → 全局 Skill (`~/.deep-student/skills/`) → 项目 Skill (`.skills/`)，后加载的覆盖先加载的。
- **灵活激活方式**：支持 `/skill <id>` 命令手动激活、UI 选择器、LLM 自动推荐（通过 `<available_skills>` 元数据）以及默认技能自动加载。
- **内置技能**：
  - **指令型**：`tutor-mode`（苏格拉底式教学）、`chatanki`（端到端制卡闭环）、`literature-review`（文献综述）、`research-mode`（调研模式）
  - **工具组**：`knowledge-retrieval`（RAG 检索）、`canvas-note`（笔记工具）、`vfs-memory`（记忆系统）、`mindmap-tools`、`todo-tools` 等
- **用户自定义**：支持通过技能管理页面创建、编辑、导入/导出自定义 Skill（SKILL.md 格式），内置技能可自定义但不可删除。

### 扩展与定制
- **MCP 生态**：兼容 Model Context Protocol，支持 SSE/WebSocket/Streamable HTTP 工具扩展。Skill 系统通过 `embeddedTools` 与 MCP 工具无缝集成。
- **个性化设置**：自定义主题（8 种配色）、字体、快捷键与 AI 模型参数。

## 快速上手

### 环境要求
- **Node.js**: v20+
- **Rust**: Stable (建议通过 `rustup` 安装)
- **包管理器**: npm

### 安装与运行

```bash
# 1. 克隆项目
git clone https://github.com/000haoji/deep-student.git
cd deep-student

# 2. 安装依赖
npm ci

# 3. 启动开发环境
npm run dev              # 启动前端 (端口 1422)
npm run dev:tauri        # 启动 Tauri 桌面应用
```

更多详细构建命令（如 macOS/Windows/iOS/Android 打包），请参考 [构建配置指南](./BUILD-CONFIG.md)。

## 技术栈

本项目基于现代化的技术栈构建，确保高性能与良好的开发体验：

| 领域 | 技术方案 |
|------|----------|
| **前端框架** | React 18.3 + TypeScript 5.6 + Vite 6 |
| **UI 组件** | Tailwind CSS 3.4 + Ant Design 5 + Radix UI |
| **桌面运行时** | Tauri 2 (Rust Edition 2021) |
| **数据存储** | SQLite (Rusqlite) + LanceDB (向量检索) |
| **状态管理** | Zustand 5 + Immer |
| **核心编辑器** | Milkdown (Markdown) + CodeMirror |
| **文档处理** | PDF.js + DeepSeek/Paddle OCR |

## 贡献

我们非常欢迎社区贡献！帮助我们把 DeepStudent 变得更好。

1. 阅读 [CONTRIBUTING.md](./CONTRIBUTING.md) 了解开发流程。
2. 代码规范请参考 [AGENTS.md](./AGENTS.md)。
3. 提交 Pull Request 前请确保通过 `npm run lint` 与测试。

## 许可证

DeepStudent 遵循 **[AGPL-3.0](LICENSE)** 开源许可证。
您可以自由使用、修改与分发，但需保持开源。

---
<p align="center">Made for Lifelong Learners</p>
