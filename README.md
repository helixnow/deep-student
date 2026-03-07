<div align="center">

[简体中文](./README_CN.md) | **English**

<img src="./public/logo.svg" alt="DeepStudent" width="120" />

# DeepStudent

### An open-source, local-first AI learning workbench

> It's not that learning is hard — it's that learning tools are too scattered.

Think of DeepStudent as:<br/>
**NotebookLM + Notion + XMind + Quizlet + DeepL + ...**, all in one unified learning workbench.

[![Release](https://img.shields.io/github/v/release/helixnow/deep-student?color=blue&label=release)](https://github.com/helixnow/deep-student/releases/latest)
[![License](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Stars](https://img.shields.io/github/stars/helixnow/deep-student?style=social)](https://github.com/helixnow/deep-student)

[Website](https://deepstudent.cn) ·
[**Download**](#installation) ·
[Quick Start](https://deepstudent.cn/docs/) ·
[User Guide](https://deepstudent.cn/docs/) ·
[Report Issues](https://github.com/helixnow/deep-student/issues) ·
[Contributing](./.github/CONTRIBUTING.md)

</div>

<p align="center">
  <img src="./example/软件主页图.png" width="90%" alt="DeepStudent Main Interface" />
</p>

---

## Why DeepStudent

Learning workflows are spread across too many tools — read here, take notes there, build mind maps elsewhere, review in yet another app.
PDF readers, XMind, translation apps, Notion, LMS platforms, arXiv, Anki, DeepSeek/ChatGPT… every tool is its own silo. Once your learning data is scattered, you spend more energy shuttling between tools than actually learning.

DeepStudent's answer: **give AI native read-write access to all your learning data.** One sentence from you, and it generates a mind map from your textbook, creates questions from your materials, turns key points into flashcards, searches and downloads papers, or researches the web and writes conclusions into your notes — all without leaving the workbench.

---

## Understand It Through Products You Know

| Capability | NotebookLM | Open Notebook | DeepTutor | Notion/Obsidian | **DeepStudent** |
|---|:---:|:---:|:---:|:---:|:---:|
| AI Q&A over materials | ✓ Gemini only | ✓ multi-model | ✓ multi-agent | △ Notion AI | **✓ 9 providers** |
| Local-first storage | ✗ cloud | ✓ Docker | ✓ Docker | △ | **✓** |
| Cloud sync | ✓ native | ✗ | ✗ | ✓ | **△ experimental** |
| Open source / self-host | ✗ | ✓ | ✓ AGPL-3.0 | ✗ | **✓ AGPL-3.0** |
| Cross-platform out-of-box | ✓ all platforms | △ Docker | △ Docker | ✓ all platforms | **✓ Win/Mac/Linux/Android** |
| Auto-index on import | ✓ | ✓ | ✓ | △ | **✓ incl. OCR** |
| Unified data layer (VFS) | ✗ | ✗ | ✗ | ✗ | **✓** |
| Smart memory system | ✗ | ✗ | △ session memory | ✗ | **✓ AI-driven persistent** |
| Note-taking system | △ simple notes | △ AI notes | △ notebook | ✓ core feature | **✓ rich text+tags+AI** |
| AI-generated mind maps | ✓ | ✗ | △ visualization | ✗ | **✓** |
| Mind map ↔ outline mode | ✗ | ✗ | ✗ | △ | **✓** |
| AI quiz + practice modes | ✓ | ✗ | ✓ exam-style | ✗ | **✓** |
| Deep research + papers | △ Discover | ✗ | ✓ | ✗ | **✓ multi-engine+arXiv** |
| Flashcards + SRS | △ no SRS | ✗ | ✗ | ✗ | **✓ Anki ecosystem** |
| Translation + close reading | ✗ | ✗ | ✓ PDF translation | ✗ | **✓ 7 domain presets** |
| AI essay correction | ✗ | ✗ | ✗ | △ Notion AI | **✓ multi-scenario** |
| Cross-module data flow | △ | △ | △ | △ | **✓** |
| MCP ecosystem / skills | ✗ | ✗ | ✓ MCP registry | ✗ | **✓ native+presets** |
| Real-time collaboration | △ sharing | ✗ | ✗ | ✓ | **✗** |
| Community & ecosystem | ✓ | △ new project | △ new project | ✓ rich plugins | **△ new project** |

> **The core architectural difference:** A unified Virtual File System (VFS) makes all learning data AI-readable, AI-searchable, and AI-writable. The chat agent can retrieve your textbooks and notes to answer questions, and directly generate mind maps, questions, flashcards, and research reports back into the system. One material completes the full loop in one workbench — no data shuttling between apps.

---

## Core Capabilities

### 1. Study with AI Chat

Study around your materials, not just general chat.

- Multi-modal input (drag & drop images / PDF / Word) with multi-turn conversation
- Reference panel for injecting knowledge base notes or textbooks into context, with real-time token estimation
- Deep reasoning mode (chain-of-thought), showing the full thinking process
- Multi-tab sessions & session branching — explore different approaches
- Multi-model comparison (experimental): side-by-side answers from multiple models
- Session grouping, group-level System Prompt, default skill configuration
- Sub-agent execution (experimental): automatic task decomposition, background completion

<details>
<summary>📸 View Screenshots</summary>
<p align="center"><img src="./example/会话浏览.png" width="90%" alt="Session Management" /></p>
<p align="center"><img src="./example/分组.png" width="90%" alt="Session Grouping" /></p>
<p align="center"><img src="./example/anki-发送.png" width="90%" alt="References & Sending" /></p>
<p align="center"><img src="./example/并行-1.png" width="90%" alt="Multi-Model Selection" /></p>
<p align="center"><img src="./example/并行-2.png" width="90%" alt="Multi-Model Comparison" /></p>
</details>

### 2. Learning Hub

Organize materials, notes, questions, mind maps, translations, and flashcards in one place.

- Full-format management: notes / textbooks / question banks / mind maps
- Auto-vectorization pipeline on import (OCR → chunking → embedding → indexing), with real-time status
- Built-in PDF / DOCX reader with dual-page view and bookmarks
- Unified data source for downstream Q&A, mind maps, question generation, and flashcards

<details>
<summary>📸 View Screenshots</summary>
<p align="center"><img src="./example/学习资源管理器.png" width="90%" alt="Learning Resource Manager" /></p>
<p align="center"><img src="./example/笔记-1.png" width="90%" alt="Note Editing" /></p>
<p align="center"><img src="./example/向量化状态.png" width="90%" alt="Vectorization Status" /></p>
</details>

### 3. Knowledge Mind Maps

Structure your knowledge, not just get answers.

- Generate a complete knowledge structure from a single sentence (e.g., "generate a high school biology mind map")
- Multi-round conversational editing of nodes
- Toggle between outline view and mind map view, right-click menu editing
- Node masking for recitation practice

<details>
<summary>📸 View Screenshots</summary>
<p align="center"><img src="./example/知识导图-1.png" width="90%" alt="Conversational Generation" /></p>
<p align="center"><img src="./example/知识导图-2.png" width="90%" alt="Multi-Round Editing" /></p>
<p align="center"><img src="./example/知识导图-3.png" width="90%" alt="Complete Mind Map" /></p>
<p align="center"><img src="./example/知识导图-4.png" width="90%" alt="Mind Map Editing" /></p>
<p align="center"><img src="./example/知识导图-5.png" width="90%" alt="Outline View" /></p>
<p align="center"><img src="./example/知识导图-6.png" width="90%" alt="Recitation Mode" /></p>
</details>

### 4. Question Sets & Practice

Turn textbooks and exam papers into practice-ready question banks.

- Upload textbooks / exam papers, AI auto-extracts or generates question sets
- Daily practice, timed practice, mock exams with auto-grading
- AI deep analysis of knowledge points and problem-solving approaches
- Mastery tracking by knowledge point to pinpoint weak areas

<details>
<summary>📸 View Screenshots</summary>
<p align="center"><img src="./example/题目集-1.png" width="90%" alt="One-Click Generation" /></p>
<p align="center"><img src="./example/题目集-2.png" width="90%" alt="Question Bank View" /></p>
<p align="center"><img src="./example/题目集-5.png" width="90%" alt="Knowledge Point Statistics" /></p>
<p align="center"><img src="./example/题目集-3.png" width="90%" alt="Practice Interface" /></p>
<p align="center"><img src="./example/题目集-4.png" width="90%" alt="Deep Analysis" /></p>
</details>

### 5. Anki Smart Flashcards

Push understanding into long-term memory.

- Trigger card creation via natural language in chat (e.g., "turn this document into flashcards"), with batch generation
- Visual template editor (HTML / CSS / Mustache) with real-time preview
- Task board for batch card creation progress tracking with checkpoint resume
- 3D flip preview, one-click sync to Anki

<details>
<summary>📸 View Screenshots</summary>
<p align="center"><img src="./example/anki-制卡1.png" width="90%" alt="Conversational Generation" /></p>
<p align="center"><img src="./example/制卡任务.png" width="90%" alt="Task Board" /></p>
<p align="center"><img src="./example/模板库-1.png" width="90%" alt="Template Library" /></p>
<p align="center"><img src="./example/模板库-2.png" width="90%" alt="Template Editor" /></p>
<p align="center"><img src="./example/anki-制卡2.png" width="90%" alt="3D Preview" /></p>
<p align="center"><img src="./example/anki-制卡3.png" width="90%" alt="Anki Sync" /></p>
</details>

### 6. PDF / DOCX Smart Reader

Study around your documents, not just open them.

- Full format support: PDF, DOCX
- Split-screen: chat on the left, read on the right
- Select pages or passages to auto-inject into chat context
- AI responses can include page number references

<details>
<summary>📸 View Screenshots</summary>
<p align="center"><img src="./example/pdf阅读-1.png" width="90%" alt="PDF Reading" /></p>
<p align="center"><img src="./example/pdf阅读-2.png" width="90%" alt="Page References" /></p>
<p align="center"><img src="./example/pdf阅读-3.png" width="90%" alt="Reference Navigation" /></p>
<p align="center"><img src="./example/docx阅读-1.png" width="90%" alt="DOCX Reading" /></p>
</details>

<details>
<summary><b>📋 More capabilities (Translation · Essay · Research · Papers · Memory · Skills · Data Governance)</b></summary>

### 7. Translation Workbench

Translation as part of your learning chain.

- Full-text translation with synchronized left-right scrolling
- Paragraph-level bilingual comparison, ideal for close reading
- Domain presets: academic / technical / literary / legal / medical
- Custom prompts and terminology preferences

<details>
<summary>📸 View Screenshots</summary>
<p align="center"><img src="./example/翻译-1.png" width="90%" alt="Full-Text Translation" /></p>
<p align="center"><img src="./example/翻译-2.png" width="90%" alt="Bilingual Comparison" /></p>
<p align="center"><img src="./example/翻译-3.png" width="90%" alt="Translation Settings" /></p>
</details>

### 8. AI Essay Grading

Chinese and English essay grading and polishing.

- Multi-scenario: Gaokao / IELTS / TOEFL / CET-4/6 / Postgraduate entrance exam
- Multi-dimensional AI scoring (vocabulary, grammar, coherence, etc.) with iterative grading
- Revision suggestions with highlights
- Sentence-by-sentence polish comparison
- Customizable scoring dimensions and grading settings

<details>
<summary>📸 View Screenshots</summary>
<p align="center"><img src="./example/作文-1.png" width="90%" alt="Type Selection & Annotations" /></p>
<p align="center"><img src="./example/作文-2.png" width="90%" alt="Scoring Results" /></p>
<p align="center"><img src="./example/作文-3.png" width="90%" alt="Polish Improvement" /></p>
<p align="center"><img src="./example/作文-4.png" width="90%" alt="Grading Settings" /></p>
</details>

### 9. Deep Research

Multi-step, long-chain research agent.

- Interactive confirmation of research depth and format preferences before starting
- Automatic task decomposition: define objectives → web search → local retrieval → analysis → report generation
- 7 search engines supported (Google CSE / SerpAPI / Tavily / Brave / SearXNG / Zhipu / Bocha)
- Reports auto-saved as notes

<details>
<summary>📸 View Screenshots</summary>
<p align="center"><img src="./example/调研-1.png" width="90%" alt="Research Mode" /></p>
<p align="center"><img src="./example/调研-2.png" width="90%" alt="Multi-Step Execution" /></p>
<p align="center"><img src="./example/调研-3.png" width="90%" alt="Execution Progress" /></p>
<p align="center"><img src="./example/调研-5.png" width="90%" alt="Auto-Save Notes" /></p>
<p align="center"><img src="./example/调研-4.png" width="90%" alt="Final Report" /></p>
</details>

### 10. Academic Paper Search & Management

One-stop paper retrieval, download, and citation.

- Search via arXiv / OpenAlex with structured metadata
- Batch PDF download, auto-saved to VFS, multi-source fallback (arXiv → Export mirror → Unpaywall)
- SHA256 deduplication
- BibTeX, GB/T 7714, APA citation formats
- DOI auto-resolution to open-access links

<details>
<summary>📸 View Screenshots</summary>
<p align="center"><img src="./example/论文搜索-1.png" width="90%" alt="Paper Search" /></p>
<p align="center"><img src="./example/论文搜索-2.png" width="90%" alt="Paper Download" /></p>
<p align="center"><img src="./example/论文搜索-3.png" width="90%" alt="Paper Reading" /></p>
</details>

### 11. Smart Memory

Gets smarter the more you use it.

Inspired by [mem0](https://github.com/mem0ai/mem0) and [memU](https://github.com/NevaMind-AI/memU), implementing a complete memory lifecycle on desktop.

- Auto-extracts user facts after each conversation (identity / preferences / goals / subject status)
- Vector comparison of new vs. existing memories, LLM decides ADD / UPDATE / APPEND / DELETE / NONE
- Aggregated into user profile, auto-injected into subsequent conversations
- Tag system: 90-day inactivity → downweight; frequent hits → upweight; search hits auto-rehabilitate
- Browse, edit, batch delete, export
- Privacy mode: one-click disable of all external API calls

<details>
<summary>📸 View Screenshots</summary>
<p align="center"><img src="./example/记忆-1.png" width="90%" alt="Memory Extraction" /></p>
<p align="center"><img src="./example/记忆-2.png" width="90%" alt="Memory List" /></p>
<p align="center"><img src="./example/记忆-4.png" width="90%" alt="Memory View" /></p>
<p align="center"><img src="./example/记忆-3.png" width="90%" alt="Memory Editing" /></p>
</details>

### 12. Skill System & MCP Extensions

An extensible workbench, not a closed feature set.

- Skills load AI capabilities on demand — tools only loaded when activated, saving tokens
- 11 built-in skills: Cards · Research · Paper · Mind Map · Q-Bank · Memory · Tutor · Literature Review · Exam Analysis · Session Manager · Office Suite
- Three-tier loading (Built-in → Global → Project-level), custom skills via SKILL.md
- MCP protocol compatible, connecting external tools like Arxiv, Context7
- 9 pre-configured model providers, plus any OpenAI-compatible endpoint
- Adapted for Gemini 3, GPT-5.2 Pro, GLM-5, Seed 2.0, Kimi K2.5, and more

<details>
<summary>📸 View Screenshots</summary>
<p align="center"><img src="./example/技能管理.png" width="90%" alt="Skill Management" /></p>
<p align="center"><img src="./example/mcp-1.png" width="90%" alt="MCP Invocation" /></p>
<p align="center"><img src="./example/mcp-2.png" width="90%" alt="MCP Management" /></p>
<p align="center"><img src="./example/模型分配.png" width="90%" alt="Model Configuration" /></p>
<p align="center"><img src="./example/mcp-3.png" width="90%" alt="Arxiv Search" /></p>
</details>

### 13. Local-First & Data Governance

Your learning data stays under your control.

- All data stored locally (SQLite + LanceDB + Blob)
- Full backup & recovery, data import/export
- AES-256-GCM encryption for sensitive data, dual-slot A/B switching
- Audit logs for full traceability
- Cloud sync (experimental): S3-compatible storage & WebDAV

</details>

## Installation

[![macOS](https://img.shields.io/badge/-macOS-black?style=flat-square&logo=apple&logoColor=white)](#installation)
[![Windows](https://img.shields.io/badge/-Windows-blue?style=flat-square&logo=windows&logoColor=white)](#installation)
[![Android](https://img.shields.io/badge/-Android-green?style=flat-square&logo=android&logoColor=white)](#installation)

Download the latest version from [GitHub Releases](https://github.com/helixnow/deep-student/releases/latest):

| Platform | Package | Architecture |
|:---:|---|---|
| macOS | `.dmg` | Apple Silicon / Intel |
| Windows | `.exe` | x86_64 |
| Android | `.apk` | arm64 |

> iOS can be built locally via Xcode. See [Build Configuration Guide](./docs/BUILD-CONFIG.md).

### Getting Started

After your first launch, try this path:

1. Import a PDF / textbook / paper
2. Start a conversation around the material
3. Generate a mind map
4. Create a question set or flashcards
5. Use translation / close reading to deepen understanding

This path best demonstrates DeepStudent's core value: not isolated features, but a complete learning chain.

---

## What Makes It Different Technically

If you're a developer, this section is for you.

- **Unified learning data layer** — One material can be read, searched, structured, practiced, memorized; upper-layer apps are different views of the same data
- **Local-first** — Metadata (SQLite), vector indices (LanceDB), file content (Blob) all stored locally
- **Skill-driven architecture** — Capabilities load on demand, combined with MCP protocol and multi-search-engine integration
- **End-to-end loop** — Import → understand → research → structure → practice → flashcards → memory

---

## Architecture Overview

```
DeepStudent
├── Learning Materials: PDF / DOCX / textbooks / questions / notes / mind maps / translations
├── Unified Data Layer: VFS + SQLite metadata + LanceDB vector index + Blob file storage
├── Workflow Layer: chat / research / mind map / question sets / translation / essay / memory
├── Extension Layer: Skills / MCP / multi-search engines / custom model providers
└── Interface Layer: Desktop (macOS · Windows) & Mobile (Android · iOS)
```

<details>
<summary>View Code Structure</summary>

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
│   ├── translation/        #   Translation Workbench Frontend
│   ├── command-palette/    #   Command Palette (shortcuts / favorites / pinyin search)
│   ├── dstu/               #   DSTU Resource Protocol & VFS API
│   ├── api/                #   Frontend API Layer (Tauri invoke wrappers)
│   ├── hooks/              #   React Hooks (theme, hotkeys, platform detection, etc.)
│   ├── services/           #   Service Layer (update checker, audit, logging, etc.)
│   ├── engines/            #   Rendering Engines (Markdown, code highlighting, etc.)
│   ├── debug-panel/        #   Debug Panel & Dev Tools
│   └── locales/            #   i18n Internationalization (CN / EN)
├── src-tauri/              # Tauri / Rust Backend
│   └── src/
│       ├── chat_v2/        #   Chat Pipeline & Tool Executor
│       ├── llm_manager/    #   Multi-Model Management & Adaptation (9 built-in providers)
│       ├── vfs/            #   Virtual File System & Vectorized Indexing
│       ├── dstu/           #   DSTU Resource Protocol Backend
│       ├── tools/          #   Web Search Engine Adapters (7 engines)
│       ├── memory/         #   Smart Memory (self-evolving profile / 3-layer arch / LLM decision)
│       ├── mcp/            #   MCP Protocol Implementation
│       ├── translation/    #   Translation Pipeline Backend
│       ├── cloud_storage/  #   Cloud Sync (S3 / WebDAV)
│       ├── data_governance/ #  Backup, Audit, Migration
│       ├── essay_grading/  #   Essay Grading Backend
│       ├── qbank_grading/  #   Question Bank AI Grading
│       ├── crypto/         #   Encryption & Secure Storage (AES-256-GCM)
│       ├── multimodal/     #   Multimodal Processing
│       ├── ocr_adapters/   #   OCR Adapters (6 engines)
│       └── llm_usage/      #   LLM Usage Tracking
├── docs/                   # User Docs & Design Docs
├── tests/                  # Vitest Unit Tests & Playwright CT
└── .github/workflows/      # CI / Release Automation
```

</details>

---

## Tech Stack

| Area | Technology |
|------|----------|
| **Frontend Framework** | React 18 + TypeScript 5.6 + Vite 6 |
| **UI Components** | Tailwind CSS 3 + Radix UI + Lucide Icons |
| **Desktop / Mobile** | Tauri 2 (Rust) — macOS · Windows · Android · iOS |
| **Data Storage** | SQLite (Rusqlite) + LanceDB (Vector Search) + Local Blob |
| **State Management** | Zustand 5 + Immer |
| **Editors** | Milkdown (Markdown) + CodeMirror (Code) |
| **Document Processing** | PDF.js + pdfium-render + Multi-engine OCR |
| **Search Engines** | Google CSE · SerpAPI · Tavily · Brave · SearXNG · Zhipu · Bocha |
| **CI / CD** | GitHub Actions — lint · type-check · build · Release Please |

---

## Development

### Prerequisites

| Tool | Version | Description |
|------|------|------|
| **Node.js** | v20+ | Frontend build |
| **Rust** | Stable | Backend compilation (recommended via [rustup](https://rustup.rs)) |
| **npm** | — | Package manager (do not mix with pnpm / yarn) |

### Local Development

```bash
git clone https://github.com/helixnow/deep-student.git
cd deep-student

npm ci
npm run dev
npm run dev:tauri
```

For more build and packaging info, see [BUILD-CONFIG.md](./docs/BUILD-CONFIG.md)

---

## Documentation

| Document | Description |
|------|------|
| [Quick Start](https://deepstudent.cn/docs/) | 5-minute getting started guide |
| [User Guide](https://deepstudent.cn/docs/) | Complete feature documentation |
| [Build Configuration](./docs/BUILD-CONFIG.md) | Cross-platform build & packaging |
| [Changelog](./CHANGELOG.md) | Version change history |
| [Security Policy](./.github/SECURITY.md) | Vulnerability reporting process |

---

## Roadmap

On the way to **v1.0**. Near-term focus:

- User experience & stability improvements
- Desktop & mobile UI/UX optimization
- Cloud sync & backup enhancements
- Resource full lifecycle management optimization
- Skill & workflow expansion
- More model integrations & adaptations

---

## Project History

DeepStudent started as a Python demo in March 2025 and has evolved through nearly a year of continuous iteration:

| Date | Milestone |
|------|--------|
| **2025.03** | 🌱 Project Genesis — Python demo prototype, validating AI-assisted learning |
| **2025.05** | 🔄 Tech Stack Migration — Transitioned to Tauri + React + Rust architecture |
| **2025.08** | 🎨 Major UI Overhaul — Migrated to shadcn-ui, introduced Chat architecture & knowledge base vectorization |
| **2025.09** | 📝 Note System & Templates — Milkdown editor integration, Anki template batch import |
| **2025.10** | 🌐 i18n & E2E Testing — Full i18n coverage, Playwright testing, Lance vector storage migration |
| **2025.11** | 💬 Chat V2 Architecture — New conversation engine (multi-model comparison, tool event system, snapshot monitoring) |
| **2025.12** | ⚡ Performance — Parallel session loading, config caching, DSTU resource protocol |
| **2026.01** | 🧩 Skill System & VFS — File-based skill loading, unified Virtual File System |
| **2026.02** | 🚀 Open Source Release — Renamed to DeepStudent, released v0.9.23; added Translation Workbench, Cloud Sync, Session Branching, Smart Memory enhancements, and more |

---

## Contributing

Help make DeepStudent better.

1. Read [CONTRIBUTING.md](./.github/CONTRIBUTING.md) for development workflow
2. Ensure `npm run lint` and type checks pass before submitting a PR
3. Bugs & suggestions via [Issues](https://github.com/helixnow/deep-student/issues)

---

## License

[AGPL-3.0](./LICENSE)

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
[PDF.js](https://mozilla.github.io/pdf.js/) · [pdfium-render](https://github.com/nicholasgasior/pdfium-render) · [docx-preview](https://github.com/nicholasgasior/docx-preview) · [docx-rs](https://github.com/cstkingkey/docx-rs) · [umya-spreadsheet](https://github.com/MathNya/umya-spreadsheet) · [Mustache](https://mustache.github.io) · [DOMPurify](https://github.com/cure53/DOMPurify)

**Internationalization & Toolchain**
[i18next](https://www.i18next.com) · [date-fns](https://date-fns.org) · [Vitest](https://vitest.dev) · [Playwright](https://playwright.dev) · [ESLint](https://eslint.org) · [Sentry](https://sentry.io)

---

<p align="center">
  <sub>Made with ❤️ for Lifelong Learners</sub>
</p>
