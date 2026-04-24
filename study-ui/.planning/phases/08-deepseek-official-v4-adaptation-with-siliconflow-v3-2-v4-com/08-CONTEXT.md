---
phase: 08-deepseek-versioned-adapter-compatibility
status: captured
created: 2026-04-24
source:
  - User decision: keep one DeepSeek family adapter; version differences belong in model configuration.
  - Official DeepSeek API docs reviewed on 2026-04-24.
  - Existing DeepStudent DeepSeek and SiliconFlow adapter behavior inspected in the parent app.
---

# Phase 8 Context: DeepSeek Versioned Adapter Compatibility

## Goal

Adapt DeepStudent to official DeepSeek V4 while preserving existing SiliconFlow DeepSeek V3.2 users and leaving room for SiliconFlow-hosted DeepSeek V4.

The implementation should keep one shared `DeepSeekAdapter`. DeepSeek model version decides capability/default behavior, while the hosting platform decides the request field format.

## Locked Decisions

- Keep a single DeepSeek family adapter. Do not create separate `OfficialDeepSeekV4Adapter`, `SiliconFlowDeepSeekAdapter`, or per-version UI pipelines.
- Introduce an explicit DeepSeek version/profile layer inside shared adapter and capability code. The expected profile buckets are V3.1 special-case, V3.2, V4, legacy aliases, and unknown future DeepSeek variants.
- Treat hosting platform as a request protocol choice, not a model family choice. Official DeepSeek uses `thinking: { type: "enabled" | "disabled" }` and V4 `reasoning_effort`; SiliconFlow-hosted DeepSeek keeps `enable_thinking` and `thinking_budget`.
- Official DeepSeek defaults should recommend `deepseek-v4-flash` and `deepseek-v4-pro`. `deepseek-chat` and `deepseek-reasoner` remain supported compatibility aliases, not primary recommendations.
- Existing SiliconFlow `deepseek-ai/DeepSeek-V3.2` behavior must not regress.
- If SiliconFlow exposes DeepSeek V4 model IDs, DeepStudent should classify them as V4 for capability/default purposes while still serializing SiliconFlow-compatible fields.
- Settings UI must separate model reasoning capability from the per-request thinking toggle. Turning off thinking for one config must not erase that the model supports reasoning.
- Streaming `reasoning_content`, tool calls, and tool-loop passback remain part of the DeepSeek family contract.
- DeepSeek V4 max output capability is large, but implementation should keep conservative default output settings and represent 384K as a maximum/capability rather than an eager default.

## Agent Discretion

- Decide exact enum/helper names for DeepSeek version and host protocol classification.
- Decide whether DeepSeek version helpers live only in Rust/TS files or are factored into small shared helper functions inside each runtime.
- Decide the smallest settings UI change that fixes semantics without redesigning the modal.
- Decide whether frontend model default tests are added to an existing test file or a new focused `modelCapabilities` test file.
- Decide whether provider streaming/passback code needs code changes or only regression coverage and comments.

## Deferred Ideas

- Full provider registry redesign.
- Anthropic-format DeepSeek API support.
- Live API smoke tests that require user API keys.
- A complete settings modal redesign.
- Automatic model-list fetching from DeepSeek or SiliconFlow.
- New provider-specific adapters for every hosted DeepSeek platform.

## Canonical References

Downstream implementation must read these before editing:

- `study-ui/.planning/ROADMAP.md` - Phase 8 goal, primary files, and success criteria.
- `study-ui/.planning/REQUIREMENTS.md` - DSK-01 through DSK-08 acceptance requirements.
- `src-tauri/src/llm_manager/adapters/deepseek.rs` - Current shared DeepSeek request adaptation and SiliconFlow formatting.
- `src-tauri/src/llm_manager/adapters/mod.rs` - Aggregator routing behavior that lets SiliconFlow-hosted DeepSeek models reuse `DeepSeekAdapter`.
- `src-tauri/src/llm_manager/builtin_vendors.rs` - Built-in official DeepSeek vendor presets.
- `src-tauri/src/reasoning_policy.rs` - Reasoning passback policy.
- `src-tauri/src/providers/mod.rs` - Streaming `reasoning_content` capture.
- `src/utils/apiCapabilityEngine.ts` - Runtime capability inference.
- `src/utils/modelCapabilities.ts` - Adapter detection and default parameter inference.
- `src/components/settings/ShadApiEditModal.tsx` - Settings UI for reasoning/thinking fields.
- `src/components/settings/SiliconFlowSection.tsx` - SiliconFlow model import/default behavior.
- `src/components/settings/modelConverters.ts` - API config/model conversion behavior.
- DeepSeek official docs:
  - `https://api-docs.deepseek.com/`
  - `https://api-docs.deepseek.com/quick_start/pricing`
  - `https://api-docs.deepseek.com/guides/thinking_mode`
- SiliconFlow docs:
  - `https://docs.siliconflow.com/en/userguide/guides/interleaved-thinking`

## Specific Implementation Shape

- Backend adapter should classify:
  - Official V4 model IDs: `deepseek-v4-flash`, `deepseek-v4-pro`.
  - Legacy official aliases: `deepseek-chat`, `deepseek-reasoner`, currently compatibility aliases for V4 Flash non-thinking/thinking modes.
  - SiliconFlow V3.2 IDs: e.g. `deepseek-ai/DeepSeek-V3.2`.
  - SiliconFlow V4-shaped IDs: e.g. `deepseek-ai/DeepSeek-V4`, `deepseek-ai/DeepSeek-V4-Pro`, or provider registry variants.
- Version profile decides reasoning defaults, context heuristics, whether `reasoning_effort` is meaningful, and special V3.1 tool-call handling.
- Host protocol decides serialized request fields:
  - Official DeepSeek: `thinking.type`, optional normalized `reasoning_effort` for V4 thinking mode.
  - SiliconFlow: `enable_thinking`, optional clamped `thinking_budget`; no official `thinking` object.
- UI should preserve `supportsReasoning` when a user toggles `enableThinking` off.
- Tests must prove official V4, SiliconFlow V3.2, and SiliconFlow V4-shaped IDs do not trample each other.

---

*Phase: 08-deepseek-versioned-adapter-compatibility*
*Context gathered: 2026-04-24*
