# DeepStudent User Guide (English)

> A practical, jargon-free handbook for learners using **DeepStudent v0.20.9** across Desktop (Windows / macOS / Linux), Android, and self-hosted WebUI / PWA.
>
> Looking for the full 21-chapter Chinese edition? See the [Chinese User Guide (`docs/user-guide/README.md`)](../README.md).

---

## Start Here in 3 Minutes

If you just opened DeepStudent for the first time, jump straight into **[01 · Quickstart & Three-Minute Workflows](./01-quickstart.md)**:

- **[First-Run 3-Step Setup](./01-quickstart.md#first-run-in-3-steps)** — connect an AI provider, import your first file, and send your first grounded question.
- **[3-Minute Exam Cram Sprint](./01-quickstart.md#quick-scenario-1-3-minute-exam-cram-sprint)** — turn past exams and notes into a timed daily countdown queue before test day.
- **[3-Minute 40-Page Paper Deep Read](./01-quickstart.md#quick-scenario-2-3-minute-40-page-paper-deep-read)** — get a paper overview, 5-color highlights, side-by-side citations, and an annotated PDF export.
- **[1-Minute Safe Mode Self-Rescue](./01-quickstart.md#quick-scenario-3-1-minute-safe-mode-self-rescue)** — recover immediately if a community plugin crashes the app or corrupts plugin settings, without losing a single note or card.

---

## Guide Directory

| Guide | What You Will Learn |
|---|---|
| **[01 · Quickstart & Three-Minute Workflows](./01-quickstart.md)** | Zero-jargon 3-step welcome flow, inline missing-API-key banner, Study Desktop basics, keyboard shortcuts, and all three 3-minute scenario quickstarts |
| **[02 · AI Chat, Study Spaces & Memory v2](./02-chat-and-memory-v2.md)** | Grounded chat, Study Spaces, Long-Term Memory Kernel, Interaction Hard Rules, per-message Memory Attribution pills, 10-version rollback, and Dialectic Reflection |
| **[03 · PDF Reading, Notes, Lectures & Translation](./03-pdf-notes-media-study-loop.md)** | 5-color PDF highlights, rotated & encrypted annotated PDF export, 460px split-pane PDF-to-Notes jump-back, smart shared-prefix tab disambiguation, Media Studio Companion Q&A with clickable `mm:ss` timestamps, and Translation tone/version rollback |
| **[04 · Flashcards, FSRS-6, Exam Sprint & Question Sets](./04-flashcards-exams-fsrs.md)** | FSRS-6 local-midnight scheduling, Unified Daily Sprint, 5,000-card library session memory, `⌘/Ctrl+K` deep jump into cards & notes, `.apkg` WebUI media parity, AnkiConnect v6, and Question Sets with draft-first confirmation |
| **[05 · Plugins v2, Study Packs & Safe Mode Rescue](./05-plugins-v2-and-safe-mode.md)** | Zero-code `.dspack` Study Packs, AI Plugin Workshop & `✦ Refine with AI`, plain-English permissions, Safe Mode self-rescue, corrupted `user.profile.json` recovery, and automatic MCP pause |
| **[06 · Backups, Cloud Sync, Mobile & WebUI / PWA](./06-sync-backup-mobile-webui.md)** | Tiered local backups with automatic `pre_restore` safety snapshots, WebDAV & S3 end-to-end encrypted sync, credential masking, weak-network lock recovery, full-screenshot QR pairing + 3-way fallback, 360px mobile dock ergonomics, and self-hosted WebUI / PWA |

### Deep-Dive Reference

- **[Question Import and Shared Materials (v2)](../question-authoring-v2-en.md)** — detailed reference on multi-page exam parsing, shared passages, group management, conversation drafts, and lossless Question Set JSON/ZIP export.

---

## Platform Overview at a Glance

| Surface | Windowed Study Desktop | Cloud Sync Protocols | Best For |
|---|---|---|---|
| **Desktop App** (Windows / macOS / Linux) | Default (classic single-pane layout optional in Settings) | WebDAV, S3, experimental FTP | Deep multi-window reading, PDF export, Plugin Workshop, AnkiConnect |
| **Desktop WebUI / PWA** (wide browser window) | Default (same windowed Study Desktop) | WebDAV, S3, experimental FTP | Accessing your self-hosted study library from any computer |
| **Mobile WebUI / PWA** (phone / narrow viewport) | Touch-optimized mobile shell | WebDAV, S3 | Reviewing flashcards, reading notes, and chatting from a phone browser |
| **Android Native App** | Touch-optimized mobile shell | WebDAV | Offline-first phone & tablet review with native share-sheet capture |

---

## Conventions Used in This Guide

- **Exact UI labels**: Button, tab, and menu labels match DeepStudent's `en-US` interface verbatim (for example, **Open AI Settings**, **Long-Term Memory Kernel**, **Export annotated PDF**, **Restart in Safe Mode**).
- **Cross-platform shortcuts**: When a shortcut is written `⌘/Ctrl+K`, press `⌘K` on macOS and `Ctrl+K` on Windows or Linux. Study Desktop window-tiling shortcuts use `⌘⌥` on macOS and `Ctrl+Alt` on Windows/Linux.
- **No engineering jargon required**: Primary walkthroughs focus on what you want to accomplish in plain language. Optional technical details are tucked into collapsible notes when helpful.

---

## Feedback & Community

Spotted an outdated label or want a workflow added to the English guide? Open an issue on [GitHub Issues](https://github.com/helixnow/deep-student/issues).

<!-- Baseline: DeepStudent v0.20.9 -->
