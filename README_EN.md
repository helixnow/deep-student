<div align="center">

[简体中文](./README.md) | **English**

<img src="./public/logo.svg" alt="DeepStudent" width="100" />

# DeepStudent

**Deep Student to You — AI-Native, Local-First, Open-Source Learning System**

[![CI](https://github.com/000haoji/deep-student/actions/workflows/ci.yml/badge.svg)](https://github.com/000haoji/deep-student/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/000haoji/deep-student?color=blue&label=release)](https://github.com/000haoji/deep-student/releases/latest)
[![License](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Stars](https://img.shields.io/github/stars/000haoji/deep-student?style=social)](https://github.com/000haoji/deep-student)

[![macOS](https://img.shields.io/badge/-macOS-black?style=flat-square&logo=apple&logoColor=white)](#installation)
[![Windows](https://img.shields.io/badge/-Windows-blue?style=flat-square&logo=windows&logoColor=white)](#installation)
[![Android](https://img.shields.io/badge/-Android-green?style=flat-square&logo=android&logoColor=white)](#installation)

Smart Chat · Knowledge Management · Anki Card Making · Universal Reader · Deep Research · Skill Extensions

[**Download**](#installation) · [Quick Start](./docs/user-guide/00-快速入门.md) · [User Guide](./docs/user-guide/README.md) · [Contributing](./CONTRIBUTING.md) · [Report Issues](https://github.com/000haoji/deep-student/issues)

</div>

<p align="center">
  <img src="./example/软件主页图.png" width="90%" alt="DeepStudent Main Interface" />
</p>

---

## Highlights

| | Feature | Description |
|:---:|---|---|
| 💬 | **Smart Chat** | Multi-modal input, deep reasoning (chain-of-thought), multi-model comparison, RAG knowledge retrieval |
| 📚 | **Learning Hub** | VFS-based unified management for notes/textbooks/question banks, batch OCR & vectorized indexing |
| 🧩 | **Skill System** | On-demand AI capabilities with 8 built-in professional skills: Card Making · Research · Paper · Mind Map · Question Bank · Memory · Tutor · Literature Review, plus custom extensions |
| 📖 | **Smart Reader** | PDF / DOCX split-screen reading with page reference injection into chat context |
| 🌐 | **Translation Workbench** | Full-text translation, paragraph-level bilingual comparison, domain presets (Academic/Technical/Literary/Legal/Medical) & custom prompts |
| ✍️ | **Essay Grading** | Multi-scenario scoring (Gaokao / IELTS / TOEFL / CET-4/6), revision suggestions with highlights |
| 🔌 | **MCP Extensions** | Model Context Protocol compatible, connecting external tools like Arxiv, Context7, etc. |
| 🏠 | **Local-First** | All data stored locally (SQLite + LanceDB + Blob), full audit trail & backup |

---

## Installation

Download the latest version from [GitHub Releases](https://github.com/000haoji/deep-student/releases/latest):

| Platform | Package | Architecture |
|:---:|--------|------|
| <img src="https://img.shields.io/badge/-macOS-black?style=flat-square&logo=apple&logoColor=white" /> | `.dmg` | Apple Silicon / Intel |
| <img src="https://img.shields.io/badge/-Windows-blue?style=flat-square&logo=windows&logoColor=white" /> | `.exe` (NSIS Installer) | x86_64 |
| <img src="https://img.shields.io/badge/-Android-green?style=flat-square&logo=android&logoColor=white" /> | `.apk` | arm64 |

> iOS version can be built locally via Xcode. See [Build Configuration Guide](./BUILD-CONFIG.md) for details.

---

## Table of Contents

- [Core Philosophy](#core-philosophy)
- [Feature Details](#feature-details)
  - [AI Smart Chat](#1-ai-smart-chat-chat-v2) · [Learning Hub](#2-learning-hub) · [Skill System](#3-skill-system)
  - [Smart Reader](#4-pdfdocx-smart-reader) · [Translation Workbench](#5-translation-workbench) · [Essay Grading](#6-ai-essay-grading) · [MCP & Model Configuration](#7-mcp-extensions--model-configuration) · [Data Governance](#8-data-governance)
- [Getting Started (Development)](#getting-started)
- [Architecture Overview](#architecture-overview)
- [Tech Stack](#tech-stack)
- [Contributing](#contributing)
- [License](#license)

---

## Core Philosophy

DeepStudent aims to build a **fully AI-native** learning loop, solving the pain points of fragmented learning:

```
┌─────────────────────────────────────────────────────────────┐
│                        DeepStudent                           │
│                                                               │
│  ┌────────┐  ┌──────────┐  ┌────────┐  ┌────────┐           │
│  │Chat V2 │  │ Learning │  │ Essay  │  │Settings│   React   │
│  │ (Chat) │  │   Hub    │  │(Essay) │  │(Config)│           │
│  └───┬────┘  └──────────┘  └────────┘  └────────┘           │
│      │                                                        │
│  ┌───▼──────────────────────────────────────────────────┐    │
│  │             Skills Engine                              │    │
│  │  Default: Deep Scholar │ Cards · Research · Tutor ·  │    │
│  │                          Literature Review              │    │
│  │  Tools: Paper · MindMap · Q-Bank · Memory · Search…   │    │
│  └──────────────────────────┬───────────────────────────┘    │
│ ─ ─ ─ ─ ─ ─ ─ ─Tauri IPC ─┼─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─    │
│  ┌───────────┐  ┌───────────▼───────┐  ┌────────────────┐   │
│  │ LLM Mgr  │  │   Chat Pipeline   │  │  MCP Runtime   │   │
│  │(9 provs) │◄─┤  + Tool Executor  ├─►│ (External Tools)│   │
│  └───────────┘  └────────┬──────────┘  └────────────────┘   │
│                           │  Reference / RAG Retrieval        │
│  ┌────────────────────────▼────────────────────────────┐     │
│  │       VFS · Virtual File System (SSOT)               │     │
│  │  Notes · Textbooks · Q-Bank · MindMap · Translation  │     │
│  │  · Essay · Memory                                     │     │
│  └────────────────────────┬────────────────────────────┘     │
│  ┌────────────────────────▼────────────────────────────┐     │
│  │  Vectorization Pipeline: OCR → Chunk → Embed → Index │     │
│  └────────────────────────┬────────────────────────────┘     │
│  ┌──────────┐  ┌──────────▼────┐  ┌──────────────┐          │
│  │  SQLite  │  │    LanceDB    │  │  Blob Files  │          │
│  │(Metadata)│  │(Vector Search)│  │ (Raw Files)  │          │
│  └──────────┘  └───────────────┘  └──────────────┘          │
│                                                               │
│                   🔒 All Data Stored Locally                  │
└─────────────────────────────────────────────────────────────┘
       │                  │                   │
  LLM APIs (9)    Web Search (7 engines)  MCP Servers
```

- **AI-Native Data Layer**: A unified **Virtual File System (VFS)** serves as the single source of truth (SSOT) for all learning resources. Once imported, resources enter an indexing queue and are batch-processed through the vectorization pipeline (OCR → Chunking → Embedding → LanceDB storage), becoming AI-readable, searchable, and actionable standard assets.
- **Skill-Driven**: Chat V2 loads AI capabilities on demand through the **Skill System** (card making, research, paper, mind map, etc.). Each skill encapsulates instructions and tool sets, dispatched by the backend Pipeline, operating on VFS data via the tool executor — making conversation the interface for action.
- **Data-Centric**: Upper-layer applications (Chat V2, Learning Hub, Essay) are different views of VFS data. Chat V2 accesses VFS resources through references and RAG retrieval to inject context, breaking down data silos between applications.
- **Local-First**: All data (SQLite metadata + LanceDB vector store + Blob files) is stored locally, secure and controllable, with full audit trail and backup support.

## Feature Details

### 1. AI Smart Chat (Chat V2)

DeepStudent's conversation engine is purpose-built for learning scenarios, supporting multi-modal input and deep reasoning.

- **Multi-Modal & References**: Supports drag-and-drop upload of images, PDFs, Word documents, and other formats. The reference panel allows direct selection of notes or textbooks from the knowledge base as context, with real-time token estimation.
- **Deep Reasoning**: Built-in reasoning mode (chain-of-thought) that displays the AI's full thinking process, ideal for complex STEM problems or deep analysis.
- **Multi-Model Comparison (Experimental)**: Send the same question to multiple models simultaneously, displaying responses in side-by-side cards for easy horizontal comparison.
- **Sub-Agent Execution (Experimental)**: Built-in subagent-worker mechanism that allows the main agent to decompose complex tasks and dispatch them to sub-agents, which complete tasks in the background and report results.
- **Session Management**: Supports session grouping, custom icons, group-level System Prompt injection and default skill configuration, making it easy to manage conversation contexts across different subjects.

<details>
<summary>📸 View Screenshots</summary>
<p align="center"><img src="./example/会话浏览.png" width="90%" alt="Session Management" /></p>
<p align="center"><img src="./example/分组.png" width="90%" alt="Session Grouping" /></p>
<p align="center"><img src="./example/anki-发送.png" width="90%" alt="References & Sending" /></p>
</details>

### 2. Learning Hub

Manage all your learning assets like Finder/Explorer.

- **Full Format Support**: One-stop management for notes, PDF textbooks, question sets, translation exercises, essay corrections, and knowledge mind maps.
- **Vectorized Indexing**: Imported resources enter an indexing queue with support for batch OCR and vectorization triggers, with real-time status visualization.
- **Document Reader**: Built-in PDF / DOCX reader with dual-page reading and bookmark annotations.

<details>
<summary>📸 View Screenshots</summary>
<p align="center"><img src="./example/学习资源管理器.png" width="90%" alt="Learning Resource Manager" /></p>
<p align="center"><img src="./example/笔记-1.png" width="90%" alt="Note Editing" /></p>
<p align="center"><img src="./example/向量化状态.png" width="90%" alt="Vectorization Status" /></p>
</details>

### 3. Skill System

Extend AI capabilities on demand through Skills, avoiding bloated System Prompts. Each skill encapsulates scenario-specific instructions and tool sets — activate and use.

- **Default Strategy (Deep Scholar)**: Always active — proactively recalls user memories, prioritizes local retrieval, and delivers personalized answers without manual activation.
- **Scenario-Based Capabilities**: 8 built-in professional skills covering core learning scenarios: card making, research, paper, mind map, question bank, memory, and more.
- **On-Demand Tool Loading**: Tools are loaded only when their corresponding skill is activated, saving token costs.
- **Skill Management**: Visual skill management panel supporting default settings (auto-activate for new sessions), import/export of custom skills.
- **Three-Tier Loading**: Built-in → Global → Project-level. Users can write custom skills in SKILL.md format.

<details>
<summary>📸 View Screenshots</summary>
<p align="center"><img src="./example/技能管理.png" width="90%" alt="Skill Management" /></p>
</details>

#### Built-in Skills Overview

| Skill | Type | Description |
|------|------|------|
| 🃏 **ChatAnki Smart Cards** | Integrated | End-to-end card-making loop: batch generation + preview + Anki sync |
| 🔬 **Deep Research** | Integrated | Multi-step Agent: web search + local retrieval + structured reports |
| 📚 **Literature Review Assistant** | Integrated | Systematic academic literature research, organization, and review writing |
| 🎯 **Tutor Mode** | Standalone | Socratic teaching with guided questioning |
| 📄 **Academic Papers** | Tool Set | arXiv / OpenAlex search, batch download, citation formatting |
| 🧠 **Knowledge Mind Map** | Tool Set | AI-generated knowledge structures, multi-round editing, outline/mind map toggle |
| 📝 **Question Sets & Practice** | Tool Set | One-click question generation, multiple practice modes, AI deep analysis |
| 💾 **Smart Memory** | Tool Set | AI auto-identifies and saves high-reuse information for long-term memory |

---

<details>
<summary><strong>🃏 ChatAnki Smart Cards</strong> — Bridging the last mile from "input" to "internalization"</summary>

- **Conversational Card Making**: Trigger card creation in Chat via natural language (e.g., "turn this document into flashcards"), with batch generation support.
- **Visual Templates**: Integrated template designer supporting natural language or GUI editor for modifying HTML/CSS/Mustache code with real-time preview.
- **Task Management**: Task board for real-time monitoring of batch card creation progress, with checkpoint resume support.
- **3D Preview & Sync**: Generated results support 3D flip preview; confirm and sync to Anki with one click.

<p align="center"><img src="./example/anki-制卡1.png" width="90%" alt="Conversational Generation" /></p>
<p align="center"><img src="./example/制卡任务.png" width="90%" alt="Task Board" /></p>
<p align="center"><img src="./example/模板库-1.png" width="90%" alt="Template Library" /></p>
<p align="center"><img src="./example/模板库-2.png" width="90%" alt="Template Editor" /></p>
<p align="center"><img src="./example/anki-制卡2.png" width="90%" alt="3D Preview" /></p>
<p align="center"><img src="./example/anki-制卡3.png" width="90%" alt="Anki Sync" /></p>

</details>

<details>
<summary><strong>🔬 Deep Research</strong> — Multi-step, long-chain deep research Agent</summary>

- **Interactive Guidance**: Before research begins, uses the `ask_user` tool to confirm research depth and output format preferences with the user.
- **Multi-Step Execution**: Automatically decomposes tasks (define objectives → web search → local retrieval → analysis → report generation), with real-time step progress display.
- **Web Search**: Supports configuration and switching between 7 search engines (Google CSE / SerpAPI / Tavily / Brave / SearXNG / Zhipu / Bocha).
- **Structured Output**: Generates structured reports and auto-saves as notes via `note_create`.

<p align="center"><img src="./example/调研-1.png" width="90%" alt="Research Mode" /></p>
<p align="center"><img src="./example/调研-2.png" width="90%" alt="Multi-Step Execution" /></p>
<p align="center"><img src="./example/调研-3.png" width="90%" alt="Execution Progress" /></p>
<p align="center"><img src="./example/调研-5.png" width="90%" alt="Auto-Save Notes" /></p>
<p align="center"><img src="./example/调研-4.png" width="90%" alt="Final Report" /></p>

</details>

<details>
<summary><strong>📄 Academic Paper Search & Management</strong> — One-stop academic paper retrieval, download, and citation</summary>

- **Smart Search**: Search academic papers via arXiv API and OpenAlex API, returning structured metadata including title, authors, abstract, and citation count.
- **Batch Download**: Supports batch PDF download (up to 5 per batch), auto-saved to VFS, with three input methods: arXiv ID, DOI, and direct URL.
- **Multi-Source Auto-Fallback**: Automatically switches to backup sources on download failure (arXiv → Export mirror → Unpaywall), maximizing success rate.
- **Real-Time Progress**: Each paper displays an independent progress bar, with manual retry and source switching support.
- **SHA256 Deduplication**: Existing papers are automatically identified and skipped to avoid duplicate imports.
- **Citation Formatting**: Supports BibTeX, GB/T 7714, and APA citation formats with one-click generation.
- **DOI Resolution**: Automatically resolves DOIs to open-access PDF links via the Unpaywall API.

<p align="center"><img src="./example/论文搜索-1.png" width="90%" alt="Paper Search" /></p>
<p align="center"><img src="./example/论文搜索-2.png" width="90%" alt="Paper Download" /></p>
<p align="center"><img src="./example/论文搜索-3.png" width="90%" alt="Paper Reading" /></p>

</details>

<details>
<summary><strong>📚 Literature Review Assistant</strong> — Systematic academic literature review workflow</summary>

- **Full-Process Coverage**: Topic selection → Search → Screening → Extraction → Writing — a complete five-stage workflow.
- **Multi-Source Retrieval**: Academic search (arXiv + OpenAlex) + local knowledge base + general web search.
- **Automatic Output**: Generates structured review reports following academic conventions and saves as notes.
- **Use Cases**: Graduation theses, academic research, project proposals, opening reports, etc.

</details>

<details>
<summary><strong>🎯 Tutor Mode</strong> — Socratic Learning Tutor</summary>

- **Guided Teaching**: Instead of giving direct answers, uses hints, micro-steps, and follow-up questions to help learners discover solutions themselves.
- **Single Question Rule**: Asks at most one focused sub-question per turn to avoid information overload.
- **Two-Attempt Rule**: During practice, allows learners up to two attempts before providing the correct answer with a brief explanation.
- **Academic Integrity**: Refuses to directly output homework answers; provides parallel examples and guidance instead.
- **Use Cases**: Study tutoring, concept comprehension, homework guidance, exam review.

</details>

<details>
<summary><strong>🧠 Knowledge Mind Map</strong> — AI-powered knowledge structuring tool</summary>

- **Conversational Generation**: Generate a complete subject knowledge structure with a single sentence (e.g., "generate a high school biology mind map").
- **Multi-Round Editing**: Supports continuous refinement and expansion of mind map nodes through conversation.
- **View Toggle**: Supports outline view and mind map view, with rich editing features via right-click context menu.
- **Recitation Mode**: Supports node masking for memorization practice.

<p align="center"><img src="./example/知识导图-1.png" width="90%" alt="Conversational Generation" /></p>
<p align="center"><img src="./example/知识导图-2.png" width="90%" alt="Multi-Round Editing" /></p>
<p align="center"><img src="./example/知识导图-3.png" width="90%" alt="Complete Mind Map" /></p>
<p align="center"><img src="./example/知识导图-4.png" width="90%" alt="Mind Map Editing" /></p>
<p align="center"><img src="./example/知识导图-5.png" width="90%" alt="Outline View" /></p>
<p align="center"><img src="./example/知识导图-6.png" width="90%" alt="Recitation Mode" /></p>

</details>

<details>
<summary><strong>📝 Question Sets & AI Analysis</strong> — Turn textbooks into practice-ready question banks with one click</summary>

- **One-Click Generation**: Upload textbooks/exam papers, and AI automatically extracts or generates question sets.
- **Multiple Practice Modes**: Supports daily practice, timed practice, mock exams, and more, with auto-grading.
- **Mock Exam Configuration**: Supports configuring test paper parameters by question type/difficulty distribution.
- **AI Analysis**: Trigger AI deep analysis on any question, analyzing knowledge points and problem-solving approaches.
- **Knowledge Point View**: Categorizes and tracks question distribution and mastery rate by knowledge point, pinpointing weak areas.

<p align="center"><img src="./example/题目集-1.png" width="90%" alt="One-Click Generation" /></p>
<p align="center"><img src="./example/题目集-2.png" width="90%" alt="Question Bank View" /></p>
<p align="center"><img src="./example/题目集-5.png" width="90%" alt="Knowledge Point Statistics" /></p>
<p align="center"><img src="./example/题目集-3.png" width="90%" alt="Practice Interface" /></p>
<p align="center"><img src="./example/题目集-4.png" width="90%" alt="Deep Analysis" /></p>

</details>

<details>
<summary><strong>💾 Smart Memory</strong> — Give AI long-term memory that understands you better over time</summary>

- **Proactive Memory**: AI automatically identifies and saves high-reuse information during conversations (e.g., learning preferences, knowledge background), automatically recalled in subsequent sessions.
- **Memory Management**: Visual memory management panel supporting editing and organizing memory entries.
- **Context Continuity**: On-demand memory retrieval tool in subsequent conversations maintains context continuity.

<p align="center"><img src="./example/记忆-1.png" width="90%" alt="Memory Extraction" /></p>
<p align="center"><img src="./example/记忆-2.png" width="90%" alt="Memory List" /></p>
<p align="center"><img src="./example/记忆-4.png" width="90%" alt="Memory View" /></p>
<p align="center"><img src="./example/记忆-3.png" width="90%" alt="Memory Editing" /></p>

</details>

### 4. PDF/DOCX Smart Reader

Not just reading — it's a conversation with knowledge.

- **Full Format Support**: Read PDF, Word (DOCX), and other document formats.
- **Split-Screen Interaction**: Chat on the left, read on the right, with real-time linkage.
- **Page References**: Select pages in the PDF reader to auto-inject into chat context; AI responses can include page number references.

<details>
<summary>📸 View Screenshots</summary>
<p align="center"><img src="./example/pdf阅读-1.png" width="90%" alt="PDF Reading" /></p>
<p align="center"><img src="./example/pdf阅读-2.png" width="90%" alt="Page References" /></p>
<p align="center"><img src="./example/pdf阅读-3.png" width="90%" alt="Reference Navigation" /></p>
<p align="center"><img src="./example/docx阅读-1.png" width="90%" alt="DOCX Reading" /></p>
</details>

### 5. Translation Workbench

Smart translation — more than just sentence-by-sentence comparison.

- **Full-Text Translation**: Supports whole-document translation with synchronized left-right split-screen scrolling for clear source-to-translation viewing.
- **Paragraph-Level Bilingual Comparison**: Paragraph-by-paragraph alignment for precise comparison of source and translated text, ideal for intensive reading practice.
- **Domain Presets**: Built-in presets for academic papers, technical documentation, literary works, legal documents, medical literature, and more — switch translation style with one click.
- **Custom Prompts**: Supports custom translation prompts for precise control over translation tone and terminology preferences.

<details>
<summary>📸 View Screenshots</summary>
<p align="center"><img src="./example/翻译-1.png" width="90%" alt="Full-Text Translation" /></p>
<p align="center"><img src="./example/翻译-2.png" width="90%" alt="Bilingual Comparison" /></p>
<p align="center"><img src="./example/翻译-3.png" width="90%" alt="Translation Settings" /></p>
</details>

### 6. AI Essay Grading

Fully automated Chinese and English essay grading and polishing.

- **Multi-Scenario Support**: Covers Gaokao (Chinese college entrance exam), IELTS, TOEFL, Postgraduate entrance exam, CET-4/6, and other exam standards.
- **Smart Scoring**: AI-based multi-dimensional scoring (vocabulary, grammar, coherence, etc.).
- **Revision Suggestions**: Provides specific vocabulary and grammar revision suggestions with highlights.

<details>
<summary>📸 View Screenshots</summary>
<p align="center"><img src="./example/作文批改-1.png" width="90%" alt="Type Selection" /></p>
<p align="center"><img src="./example/作文-1.png" width="90%" alt="Scoring Results" /></p>
<p align="center"><img src="./example/作文-2.png" width="90%" alt="Detailed Suggestions" /></p>
</details>

### 7. MCP Extensions & Model Configuration

Embracing open ecosystems with high customizability.

- **MCP Support**: Compatible with the Model Context Protocol, connecting external tool services like Arxiv, Context7, etc.
- **Multi-Model Management**: Pre-configured with 9 providers (SiliconFlow / DeepSeek / Qwen / Zhipu AI / ByteDance Doubao / MiniMax / Moonshot / OpenAI / Google Gemini), plus support for adding any custom provider compatible with the OpenAI API protocol, with fine-grained model assignment configuration for different functions.

<details>
<summary>📸 View Screenshots</summary>
<p align="center"><img src="./example/mcp-1.png" width="90%" alt="MCP Invocation" /></p>
<p align="center"><img src="./example/mcp-2.png" width="90%" alt="MCP Management" /></p>
<p align="center"><img src="./example/模型分配.png" width="90%" alt="Model Configuration" /></p>
<p align="center"><img src="./example/mcp-3.png" width="90%" alt="Arxiv Search" /></p>
<p align="center"><img src="./example/mcp-4.png" width="90%" alt="Search Details" /></p>
</details>

### 8. Data Governance

Comprehensive data management and security mechanisms:

- **Backup & Recovery**: Supports full backup and recovery, data import/export (incremental backup experimentally supported).
- **Audit Logs**: Records all data operations for traceability.
- **Database Status**: Real-time monitoring of SQLite and LanceDB operational status.

## Getting Started

### Prerequisites

| Tool | Version | Description |
|------|------|------|
| **Node.js** | v20+ | Frontend build |
| **Rust** | Stable | Backend compilation (recommended via [rustup](https://rustup.rs)) |
| **npm** | — | Package manager (do not mix with pnpm / yarn) |

### Development Environment

```bash
# Clone the project
git clone https://github.com/000haoji/deep-student.git
cd deep-student

# Install dependencies
npm ci

# Start frontend dev server (port 1422)
npm run dev

# Start Tauri desktop app (frontend + Rust backend)
npm run dev:tauri
```

> For more build commands (macOS / Windows / iOS / Android packaging), see the [Build Configuration Guide](./BUILD-CONFIG.md).

---

## Architecture Overview

```
DeepStudent
├── src/                    # React Frontend
│   ├── chat-v2/            #   Chat V2 Conversation Engine
│   │   ├── adapters/       #     Backend Adapters (TauriAdapter)
│   │   ├── skills/         #     Skill System (builtin / builtin-tools / loader)
│   │   ├── components/     #     Chat UI Components
│   │   └── plugins/        #     Plugins (event handling, tool rendering)
│   ├── components/         #   UI Components (feature module pages)
│   ├── stores/             #   Zustand State Management
│   ├── mcp/                #   MCP Client & Built-in Tool Definitions
│   ├── essay-grading/      #   Essay Grading Frontend
│   ├── dstu/               #   DSTU Resource Protocol & VFS API
│   ├── api/                #   Frontend API Layer (Tauri invoke wrappers)
│   └── locales/            #   i18n Internationalization (CN / EN)
├── src-tauri/              # Tauri / Rust Backend
│   └── src/
│       ├── chat_v2/        #   Chat Pipeline & Tool Executor
│       ├── llm_manager/    #   Multi-Model Management & Adaptation (9 built-in providers)
│       ├── vfs/            #   Virtual File System & Vectorized Indexing
│       ├── dstu/           #   DSTU Resource Protocol Backend
│       ├── tools/          #   Web Search Engine Adapters (7 engines)
│       ├── memory/         #   Smart Memory Backend
│       ├── mcp/            #   MCP Protocol Implementation
│       ├── data_governance/ #  Backup, Audit, Migration
│       ├── essay_grading/  #   Essay Grading Backend
│       └── ocr_adapters/   #   OCR Adapters (DeepSeek VL / PaddleOCR)
├── docs/                   # User Docs & Design Docs
├── tests/                  # Vitest Unit Tests & Playwright CT
└── .github/workflows/      # CI / Release Automation
```

---

## Tech Stack

| Area | Technology |
|------|----------|
| **Frontend Framework** | React 18 + TypeScript + Vite 6 |
| **UI Components** | Tailwind CSS + Radix UI + Lucide Icons |
| **Desktop / Mobile** | Tauri 2 (Rust) — macOS · Windows · Android · iOS |
| **Data Storage** | SQLite (Rusqlite) + LanceDB (Vector Search) + Local Blob |
| **State Management** | Zustand 5 + Immer |
| **Editors** | Milkdown (Markdown) + CodeMirror (Code) |
| **Document Processing** | PDF.js + Remote OCR Adapters (DeepSeek VL / PaddleOCR API) |
| **Search Engines** | Google CSE · SerpAPI · Tavily · Brave · SearXNG · Zhipu · Bocha |
| **CI / CD** | GitHub Actions — lint · type-check · build · Release Please |

---

## Documentation

| Document | Description |
|------|------|
| [Quick Start](./docs/user-guide/00-快速入门.md) | 5-minute getting started guide |
| [User Guide](./docs/user-guide/README.md) | Complete feature documentation |
| [Build Configuration](./BUILD-CONFIG.md) | Cross-platform build & packaging |
| [Changelog](./CHANGELOG.md) | Version change history |
| [Security Policy](./SECURITY.md) | Vulnerability reporting process |

---

## Contributing

Community contributions are welcome!

1. Read [CONTRIBUTING.md](./CONTRIBUTING.md) for development workflow and submission guidelines.
2. Ensure `npm run lint` and type checks pass before submitting a PR.
3. Submit bug reports and feature requests via [Issues](https://github.com/000haoji/deep-student/issues).

---

## Roadmap

We are on our way to the **v1.0** official release. Here are our near-term focus areas:

1. **User Experience & Stability**: Conducting large-scale user testing, fixing known bugs, and optimizing UX.
2. **UI/UX Upgrade**: Further optimizing frontend design for desktop and mobile, enhancing visual and interaction quality.
3. **Cloud Sync & Backup**: Testing and experimenting with cloud sync features, strengthening backup reliability and stability.
4. **DSTU Sub-App Optimization**: Comprehensive testing and performance optimization for all DSTU sub-applications.
5. **Resource Full Lifecycle Management**: Optimizing the entire lifecycle of learning resource management (Import → Processing → Learning → Review).
6. **Chat V2 Model Adaptation**: Adding support for more new models and optimizing adaptation and migration experience for legacy models.

---

## Project History

DeepStudent originated from a Python demo prototype in March 2025 and has evolved through nearly a year of continuous iteration:

| Date | Milestone |
|------|--------|
| **2025.03** | 🌱 Project Genesis — Python demo prototype, validating the core idea of AI-assisted learning |
| **2025.05** | 🔄 Tech Stack Migration — Under the name `ai-mistake-manager`, began transitioning to **Tauri + React + Rust** architecture |
| **2025.08** | 🎨 Major UI Overhaul — Migrated to shadcn-ui system, introduced Chat architecture and knowledge base vectorization |
| **2025.09** | 📝 Note System & Template Management — Milkdown editor integration, Anki template batch import |
| **2025.10** | 🌐 Internationalization & E2E Testing — Full i18n coverage, Playwright end-to-end testing, Lance vector storage migration |
| **2025.11** | 💬 Chat V2 Architecture — New conversation engine (Variant multi-model comparison, tool event system, snapshot health monitoring) |
| **2025.12** | ⚡ Performance Optimization — Parallel session loading, config caching, input box singleton architecture, DSTU resource protocol |
| **2026.01** | 🧩 Skill System & VFS — File-based skill loading, unified Virtual File System (VFS), legacy module cleanup |
| **2026.02** | 🚀 Open Source Release — Renamed to **DeepStudent**, released **v0.9.2**, configured CI/CD and release-please auto-publishing |

---

## License

DeepStudent is licensed under **[AGPL-3.0](LICENSE)**.
You are free to use, modify, and distribute it, but derivative works must also be open-sourced.

---

## Acknowledgments

DeepStudent would not be possible without these outstanding open-source projects:

**Frameworks & Runtimes**
[Tauri](https://tauri.app) · [React](https://react.dev) · [Vite](https://vite.dev) · [TypeScript](https://www.typescriptlang.org) · [Rust](https://www.rust-lang.org) · [Tokio](https://tokio.rs)

**Editors & Content Rendering**
[Milkdown](https://milkdown.dev) · [ProseMirror](https://prosemirror.net) · [CodeMirror](https://codemirror.net) · [KaTeX](https://katex.org) · [Mermaid](https://mermaid.js.org) · [react-markdown](https://github.com/remarkjs/react-markdown)

**UI & Styling**
[Tailwind CSS](https://tailwindcss.com) · [Radix UI](https://www.radix-ui.com) · [Lucide](https://lucide.dev) · [Framer Motion](https://www.framer.com/motion) · [Recharts](https://recharts.org) · [React Flow](https://reactflow.dev)

**Data & State**
[LanceDB](https://lancedb.com) · [SQLite](https://www.sqlite.org) / [rusqlite](https://github.com/rusqlite/rusqlite) · [Apache Arrow](https://arrow.apache.org) · [Zustand](https://zustand.docs.pmnd.rs) · [Immer](https://immerjs.github.io/immer) · [Serde](https://serde.rs)

**Document Processing**
[PDF.js](https://mozilla.github.io/pdf.js/) · [pdfium-render](https://github.com/nicholasgasior/pdfium-render) · [docx-preview](https://github.com/nicholasgasior/docx-preview) · [Mustache](https://mustache.github.io) · [DOMPurify](https://github.com/cure53/DOMPurify)

**Internationalization & Toolchain**
[i18next](https://www.i18next.com) · [date-fns](https://date-fns.org) · [Vitest](https://vitest.dev) · [Playwright](https://playwright.dev) · [ESLint](https://eslint.org) · [Sentry](https://sentry.io)

---

<p align="center">
  <sub>Made with ❤️ for Lifelong Learners</sub>
</p>
