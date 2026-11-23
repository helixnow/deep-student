# DeepStudent Memory System v2 Architecture

Memory System v2 refactors learner memory into a **bounded, session-frozen, transparent, and self-evolving** learning kernel inspired by Hermes Agent's bounded frozen-memory architecture and Honcho's dialectic learner representation, deeply integrated with DeepStudent's FSRS, QBank, Essay Grading, and VFS Notes.

## 1. Core Architectural Layers

1. **L1 · HardRules (`__memory_hard_rules__`)** — `host/plugins/memory/src/hard-rules.ts`
   - User-explicit or chat-corrected standing rules (e.g., *"Always include a real-world engineering analogy and end with 1 self-test question"*).
   - Bounded by a configurable character budget (default `1500` chars, range `800–3000`) with Hermes-style `limitPolicy: 'reject'` distillation pressure to prevent prompt bloat.
   - Scope-aware (`global`, `subject:*`, `mode:*`) with pin priority.
   - Agent tools: `builtin-memory_rule_list` (PTC-allowed), `builtin-memory_rule_upsert`, `builtin-memory_rule_remove`.
2. **L1/L2 · LearnerProfile & Mastery Lifecycle** — `host/plugins/memory/src/learner-profile.ts`, `host/plugins/review/repository/mastery.ts`
   - Tracks active weak points (real subject extracted from tags, evidence count, relapse count, `active | mastered` lifecycle), learning preferences, and goals.
   - Retains **10 historical profile snapshots** (`PROFILE_HISTORY_KEEP = 10`) with 1-click rollback (`rollbackProfileToVersion`).
   - Receives deterministic domain signals via `MemoryProvider.ingestSignal(...)`: FSRS mastery lapses/graduation, low-scoring essay rubric dimensions (`< 65%`), and study artifact friction.
3. **L2 · Session-Frozen `<memory_kernel>` + Mid-Session `<memory_delta>`** — `host/plugins/memory/src/memory-provider.ts`, `host/plugins/chat-pipeline/src/prompt-builder.ts`
   - Frozen once per session on Turn 1 (first-write-wins in `session_metadata`) and placed in `stableSystem`, guaranteeing **100% Turn-1 adherence** while preserving LLM KV Prompt Cache prefix stability across all subsequent turns.
   - When the user edits rules or profile mid-session, `buildSessionDelta()` appends only a compact `<memory_delta>` in `turnVolatile` so updates take effect on the very next turn without invalidating the cached prefix.
   - Automatically honors `privacy_mode` and `auto_extract_frequency === 'off'`.
4. **L3 · Compaction Flush Drain & Dialectic Reflection**
   - `host/plugins/chat-pipeline/src/execution-runtime.ts`: Real compaction flush drain worker claims and extracts pending ledger rows safely.
   - `host/plugins/memory/src/dialectic-reflection.ts`: Deterministic `reflect()` engine detects high-evidence recurring weak points, stale retirement candidates, preference-to-rule promotions, and >80% budget pressure — surfaced via `memoryProvider.reflect` with 1-click learner actions (zero silent mutation).
   - `host/plugins/agent-skills/src/tools/skill-workshop-package.ts`: `isPureMarkdownStudySkill()` bridges L3 procedural skills with Plugin v2 Tier 1 declarative study skills.

## 2. Transparent Learner UI

- **Dual-Zone Memory Workbench** (`src/features/learning-hub/views/MemoryKernelPanel.tsx` + `MemoryView.tsx`):
  - Top kernel panel: inline L1 HardRules add/remove with **5-second inline Undo**, live character budget bars, active weak points & goals management, **always-visible `历史 (N)`** 10-version rollback drawer, **「梳理建议」** dialectic reflection drawer, and raw injected prompt preview.
  - Bottom VFS memory archive: in-page subfolder creation (**「+ 新建分组」**), target folder selection on create/batch-import, single & batch **move-to-folder**, list/tree toggle, and audit log.
- **Chat Bubble Attribution Pill** (`src/features/chat/components/message/MemoryKernelAttributionPill.tsx`):
  - Subtle pill on completed assistant messages (`记忆内核 · N 规则 / M 薄弱点`) backed by a shared TTL cache (zero per-message RPC spam), allowing learners to inspect active memory and click **「忘掉」** directly in chat.
