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

<p align="center">
  <img src="./example/主页面.png" width="48%" alt="桌面端主界面" />
  <img src="./example/移动端主页面.png" width="48%" alt="移动端主界面" />
</p>

---

## 核心理念

DeepStudent 旨在构建一个**完全 AI 原生**的学习闭环，解决碎片化学习痛点：

- **AI 原生数据层 (AI-Native Data Layer)**：系统核心是一个统一的**虚拟文件系统 (VFS)**，作为所有学习资源（笔记、教材、题目集、翻译、作文、知识导图）的单一数据源 (SSOT)。资源存入后会异步进入向量化流水线（OCR 识别 → 内容分块 → 嵌入生成 → LanceDB 存储），最终成为 **AI 可读、可检索、可操作** 的标准资产。
- **以数据为中心的应用 (Data-Centric Apps)**：上层应用（Chat、Learning Hub、CardForge）是对 VFS 数据的不同视图与操作接口。Chat V2 通过引用模式调用 VFS 资源进行 RAG 检索与上下文注入，打破了应用间的数据孤岛。
- **本地优先 (Local-First)**：所有数据（SQLite 元数据 + LanceDB 向量库 + Blob 文件）存储在本地，安全可控，支持完整审计与备份，密钥不经系统钥匙串。

## 功能概览

### 1. AI 智能对话 (Chat V2)

DeepStudent 的对话引擎专为学习场景打造，支持多模态输入、深度推理与多模型对比。

- **多模态与引用**：支持图片、PDF、Word 等多格式文件拖拽上传。通过引用面板，可直接选取知识库中的笔记或教材作为上下文，实时显示 Token 估算。
- **深度推理**：内置推理模式（思维链），展示 AI 思考全过程，适合处理复杂理科题目或深度分析。
- **多模型对比**：支持同时向多个模型发送相同问题，并排列展示各模型的回答，便于横向对比评估。
- **会话管理**：支持会话分组、图标自定义、分组 System Prompt 注入与默认技能配置，方便管理不同学科的对话上下文。

<p align="center">
  <img src="./example/会话浏览.png" width="32%" alt="会话管理" />
  <img src="./example/分组.png" width="32%" alt="会话分组" />
  <img src="./example/anki-发送.png" width="32%" alt="引用与发送" />
</p>

### 2. 学习资源中心 (Learning Hub)

像 Finder/访达一样管理你的所有学习资产。

- **全格式支持**：笔记、PDF 教材、题目集、翻译练习、作文批改、知识导图一站式管理。
- **向量化索引**：资源导入即自动进行 OCR 与向量化，状态实时可视。
- **全能阅读器**：内置 PDF/Office/Markdown 阅读器，支持双页阅读与书签标注。

<p align="center">
  <img src="./example/笔记-1.png" width="48%" alt="笔记编辑" />
  <img src="./example/向量化状态.png" width="48%" alt="向量化状态" />
</p>

### 3. Anki 智能制卡 (ChatAnki)

打通从"输入"到"内化"的最后一步。

- **对话式制卡**：在 Chat 中通过自然语言（如"把这个文档做成卡片"）触发制卡，支持批量生成。
- **可视化模板**：内置 Template Designer，支持所见即所得的 HTML/CSS 模板编辑。
- **任务管理**：提供任务看板，实时监控批量制卡进度，支持断点续传。
- **3D 预览与同步**：生成结果支持 3D 翻转预览，确认无误后一键同步至 Anki。

<p align="center">
  <img src="./example/anki-制卡1.png" width="32%" alt="对话生成" />
  <img src="./example/制卡任务.png" width="32%" alt="任务看板" />
  <img src="./example/模板管理.png" width="32%" alt="模板管理" />
</p>
<p align="center">
  <img src="./example/anki-制卡2.png" width="32%" alt="3D预览" />
  <img src="./example/anki-制卡3.png" width="32%" alt="Anki同步" />
</p>

### 4. 技能系统 (Skills)

通过技能（Skills）按需扩展 AI 能力，避免 System Prompt 臃肿。

- **场景化能力**：内置导师模式（苏格拉底式教学）、调研模式（联网深度搜索）、文献综述助手等。
- **工具按需加载**：激活"知识导图"技能时才加载绘图工具，节省 Token。
- **技能管理**：可视化的技能管理面板，支持导入/导出自定义技能。

<p align="center">
  <img src="./example/技能管理.png" width="48%" alt="技能管理" />
  <img src="./example/调研-1.png" width="48%" alt="调研模式" />
</p>

### 5. 深度调研 (Research Agent)

能够执行多步骤、长链路的深度调研任务。通过 `todo-tools` 跟踪任务进度，`web_search` 联网检索，`note_create` 自动写入笔记。

- **交互式引导**：调研开始前通过 `ask_user` 工具向用户确认调研深度和输出格式偏好。
- **多步执行**：自动拆解任务（明确目标 → 网络搜索 → 本地检索 → 整理分析 → 生成报告），实时显示步骤进度。
- **联网搜索**：支持配置并切换多个搜索引擎，快速获取最新信息。
- **自动成文**：调研结束后自动生成结构化报告并保存为笔记。

<p align="center">
  <img src="./example/调研-2.png" width="32%" alt="多步执行" />
  <img src="./example/调研-3.png" width="32%" alt="执行进度" />
  <img src="./example/调研-5.png" width="32%" alt="自动保存笔记" />
</p>
<p align="center">
  <img src="./example/调研-4.png" width="60%" alt="最终报告" />
</p>

### 6. 知识导图 (MindMap)

AI 驱动的知识结构化工具。

- **对话生成**：一句话生成完整学科知识体系（如"生成高中生物导图"）。
- **多轮编辑**：支持通过对话持续修正、扩展导图节点。
- **视图切换**：支持大纲视图和导图视图，右键菜单提供丰富编辑功能。
- **背诵模式**：支持节点遮挡背诵，辅助记忆。

<p align="center">
  <img src="./example/知识导图-1.png" width="32%" alt="对话生成" />
  <img src="./example/知识导图-2.png" width="32%" alt="多轮编辑" />
  <img src="./example/知识导图-3.png" width="32%" alt="完整导图" />
</p>
<p align="center">
  <img src="./example/知识导图-4.png" width="32%" alt="导图编辑" />
  <img src="./example/知识导图-5.png" width="32%" alt="大纲视图" />
  <img src="./example/知识导图-6.png" width="32%" alt="背诵模式" />
</p>

### 7. PDF/DOCX 智能阅读

不仅仅是阅读，更是与知识的对话。

- **全格式支持**：PDF、Word (DOCX) 等文档均可阅读。
- **分屏交互**：左侧对话，右侧阅读，实时联动。
- **页面引用**：在 PDF 阅读器中选取页面，自动注入聊天上下文；AI 回答可包含页码引用。

<p align="center">
  <img src="./example/pdf阅读-1.png" width="32%" alt="PDF阅读" />
  <img src="./example/pdf阅读-2.png" width="32%" alt="页面引用" />
  <img src="./example/pdf阅读-3.png" width="32%" alt="引用跳转" />
</p>
<p align="center">
  <img src="./example/docx阅读-1.png" width="60%" alt="DOCX阅读" />
</p>

### 8. 题目集与 AI 解析 (QBank)

将教材一键转化为可练习的题库。

- **一键出题**：上传教材/试卷，AI 自动提取或生成题目集。
- **多种练习模式**：支持每日练习、限时练习、模拟考试等多种做题模式，实时判分。
- **模拟考试配置**：支持按题型/难度分布配置组卷参数。
- **深度解析**：错误题目自动触发 AI 深度解析，分析知识点与解题思路。
- **知识点视图**：按知识点分类统计题目分布和掌握率，精准定位薄弱环节。

<p align="center">
  <img src="./example/题目集-1.png" width="32%" alt="一键出题" />
  <img src="./example/题目集-2.png" width="32%" alt="题库视图" />
  <img src="./example/题目集-5.png" width="32%" alt="知识点统计" />
</p>
<p align="center">
  <img src="./example/题目集-3.png" width="48%" alt="做题界面" />
  <img src="./example/题目集-4.png" width="48%" alt="深度解析" />
</p>

### 9. 智能记忆 (AI Memory)

让 AI 拥有长期记忆，越用越懂你。

- **主动记忆（默认策略）**：在深度学者技能默认策略下，AI 会主动回忆并按需保存高复用信息。
- **记忆管理**：可视化的记忆管理面板，支持编辑、整理记忆条目。
- **上下文延续**：后续对话中按需调用记忆检索工具，保持上下文连续性。

<p align="center">
  <img src="./example/记忆-1.png" width="32%" alt="记忆提取" />
  <img src="./example/记忆-2.png" width="32%" alt="记忆列表" />
  <img src="./example/记忆-4.png" width="32%" alt="记忆视图" />
</p>
<p align="center">
  <img src="./example/记忆-3.png" width="60%" alt="记忆编辑" />
</p>

### 10. AI 作文批改 (Essay)

全自动的中英文作文批改与润色。

- **多场景支持**：覆盖高考、雅思、托福、考研、四六级等多种考试标准。
- **智能评分**：基于 AI 的多维度评分（词汇、语法、连贯性等）。
- **修改建议**：提供具体的用词、语法修改建议与高亮标注。

<p align="center">
  <img src="./example/作文批改-1.png" width="32%" alt="类型选择" />
  <img src="./example/作文-1.png" width="32%" alt="评分结果" />
  <img src="./example/作文-2.png" width="32%" alt="详细建议" />
</p>

### 11. MCP 扩展与模型配置

拥抱开放生态，高度可定制。

- **MCP 支持**：兼容 Model Context Protocol，可连接 Arxiv、Context7 等外部工具服务。
- **多模型管理**：预置 SiliconFlow、DeepSeek、Google Gemini、OpenAI 等 9 家模型商，同时支持添加任何兼容 OpenAI 协议的自定义供应商，可精细配置不同功能的模型分配。

<p align="center">
  <img src="./example/mcp-1.png" width="32%" alt="MCP调用" />
  <img src="./example/mcp-2.png" width="32%" alt="MCP管理" />
  <img src="./example/模型分配.png" width="32%" alt="模型配置" />
</p>
<p align="center">
  <img src="./example/mcp-3.png" width="48%" alt="Arxiv搜索" />
  <img src="./example/mcp-4.png" width="48%" alt="搜索详情" />
</p>

### 12. 数据治理

完善的数据管理与安全机制：

- **备份与恢复**：支持全量/增量备份，数据导入导出。
- **审计日志**：记录所有数据操作，可追溯。
- **数据库状态**：实时查看 SQLite 和 LanceDB 的运行状态。

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
