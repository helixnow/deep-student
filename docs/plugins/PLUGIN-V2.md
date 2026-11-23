# DeepStudent Plugin System v2 Guide

Plugin System v2 combines DeepSeek Harness's Cordis core extensibility with a **three-tier layered model** so learners can customize DeepStudent from zero-code declarative packs up to deep domain providers, safely and shareably.

## 1. Three-Tier Extension Model

| Tier | Entry in `package.json#deepStudent` | Code Required? | Best For |
|---|---|---|---|
| **Tier 1 · Declarative / Study Pack** | `declarative: { rubrics, skills, cardTemplates, workflows }` | Zero JS/TS | Exam grading rubrics (YAML), Socratic `SKILL.md` methods, flashcard templates, multi-step study workflows, `.dspack` Study Packs |
| **Tier 2 · UI Workshop & Light Tools** | `ui: "./dist/ui.js"` (+ optional `host`) | React/TS (built by Plugin Workshop) | Custom study widgets, selection toolbar actions, flashcard/PDF overlays calling brokered `studyData` / `pluginModel` / `pluginNotify` via `ctx.ui.host` without writing a boilerplate Host half |
| **Tier 3 · Deep Cordis Extension** | `host: "./dist/host.js"` (+ optional `ui`) | Node/TS Cordis Plugin | Custom `chatPipelineHooks`, `gradingRubrics`, `reviewSchedulers`, swappable `memoryProvider`, `agentTools`, and scheduled automation |

## 2. Manifest v2 (`contracts/plugin-manifest/v2.schema.json`)

Backward-compatible with `manifestVersion: 1`. New v2 capabilities:
- `manifestVersion: 2`
- `tier?: "declarative" | "ui-workshop" | "full"` (auto-inferred when omitted)
- `kind?: "plugin" | "study-pack"` (`study-pack` exports as `.dspack`)
- `declarative?: { rubrics?, skills?, cardTemplates?, workflows? }` — pure Tier 1 packages require neither `host` nor `ui`.
- Fine-grained high-risk network permissions (explicitly flagged in user consent cards):
  - `net:<host>` — HTTPS GET read-only
  - `net:write:<host>` — HTTPS write requests (high risk)
  - `net:local:<port>` — Localhost service bridge e.g. AnkiConnect `8765`, Zotero `23119` (high risk)

See the runnable example Study Pack in [`examples/plugins/kaoyan-math-pack/`](../../examples/plugins/kaoyan-math-pack/package.json).

## 3. Native Cordis Core Registries & Study Events

- **`chatPipelineHooks`** (`host/plugins/chat-pipeline/src/pipeline-hooks.ts`): Register priority-ordered `augmentSystemPrompt` and `afterReply` hooks with 3-second timeout isolation and fail-open crash bypass.
- **`gradingRubrics`** (`host/plugins/llm/src/essay_grading/rubric-registry.ts`): Contribute first-class essay/proof grading rubrics dynamically (Tier 1 YAML rubrics auto-register here and auto-clean on unload).
- **`reviewSchedulers`** (`host/plugins/review/src/scheduler-registry.ts`): Register custom spaced-repetition schedulers with automatic fallback to built-in `fsrs6` on error or disposal.
- **`memoryProvider`** (`host/plugins/memory/src/memory-provider.ts`): Pluggable memory kernel contract (`buildSessionSnapshot`, `buildSessionDelta`, `ingestSignal`, `inspect`, `mutateFromUser`, `reflect`).
- **Real `StudyEvents`** (`host/plugins/plugin-services/api.ts`): `study/note-saved`, `study/card-reviewed`, `study/answer-finished`, `study/essay-graded`, `study/question-answered`.

## 4. Brokered UI-Only Domain Calls & Portable Sandbox

- **UI-only Broker** (`host/kernel/runtime.ts`): Consented UI-only plugins declaring `service:studyData`, `service:pluginModel`, or `service:pluginNotify` can call dot-path methods directly over `plugin:host|call` without a Host entry.
- **Portable Sandbox Broker** (`host/kernel/sandbox/portable-sandbox.ts` + `worker-sandbox-host.ts`): Node-free JSON-RPC 2.0 capability broker designed for Electron hidden `sandbox: true` renderers and WebUI/Mobile Web Workers, enforcing manifest allowlists, prototype-pollution blocking, per-call timeouts, concurrency caps, and clean teardown.

## 5. Sharing & `.dspack` Distribution

- **Share-Time Namespace Rewrite** (`host/plugins/plugin-workshop/src/study-pack.ts`): `rewriteManifestForSharing()` converts private `workshop.plugin-<uuid>` or `local.*` works into validated `<publisher>.<slug>` community packages and strips `scripts`.
- **Safe Remote Fetch** (`host/plugins/plugin-workshop/src/remote-pack-fetch.ts`): `fetchRemotePackArchive()` downloads `.dspack` / `.dstuplugin` archives over strict HTTPS with SSRF private-host/redirect blocking, 32 MiB streaming cap, and SHA-256 verification prior to `PluginPackages.install(...)` and K3 user consent.
- **In-Window Iteration**: Every Plugin Workshop view includes a floating **「✦ 让 AI 优化」** trigger that re-opens the bound Workshop refinement conversation directly.
