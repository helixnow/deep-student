---
phase: 08-deepseek-versioned-adapter-compatibility
status: complete
created: 2026-04-24
sources:
  - https://api-docs.deepseek.com/
  - https://api-docs.deepseek.com/quick_start/pricing
  - https://api-docs.deepseek.com/guides/thinking_mode
  - https://docs.siliconflow.com/en/userguide/guides/interleaved-thinking
---

# Phase 8 Research: DeepSeek V4 and SiliconFlow Compatibility

## Official DeepSeek V4 API Findings

- The official OpenAI-compatible base URL remains `https://api.deepseek.com`.
- Current official model IDs are `deepseek-v4-flash` and `deepseek-v4-pro`.
- `deepseek-chat` and `deepseek-reasoner` are compatibility aliases that map to non-thinking and thinking modes of `deepseek-v4-flash`; the docs state they are scheduled for deprecation on 2026-07-24.
- V4 supports both thinking and non-thinking modes; thinking is enabled by default.
- OpenAI-format thinking toggle is `thinking: { type: "enabled" | "disabled" }`.
- OpenAI-format effort control is `reasoning_effort: "high" | "max"`.
- For compatibility, `low` and `medium` map to `high`; `xhigh` maps to `max`.
- Thinking mode returns `reasoning_content` alongside normal `content`.
- Tool-call flows must pass back `reasoning_content` with the assistant message when tools are involved, otherwise DeepSeek may reject the request.
- V4 model details list 1M context and 384K maximum output. This is a capability ceiling; app defaults should remain conservative.

## SiliconFlow Findings

- SiliconFlow currently documents DeepSeek V3.2 interleaved thinking behavior in tool-calling flows.
- SiliconFlow's guidance emphasizes preserving `reasoning_content` exactly, including reasoning emitted after tool results.
- The existing DeepStudent code already treats SiliconFlow as an aggregator platform and routes model-family logic through `model_adapter`, allowing SiliconFlow DeepSeek models to reuse `DeepSeekAdapter`.
- Existing DeepStudent tests and adapter behavior use SiliconFlow request fields: `enable_thinking` plus `thinking_budget`.
- No assumption should be made that SiliconFlow V4 will accept official DeepSeek `thinking` or `reasoning_effort` fields. Hosted DeepSeek V4 should initially use SiliconFlow request formatting until SiliconFlow documents otherwise.

## Current DeepStudent Implementation

### Backend

- `DeepSeekAdapter` already exists as one shared family adapter.
- It detects SiliconFlow by `base_url` containing `siliconflow` or `provider_type == "siliconflow"`.
- For official DeepSeek, it currently emits `thinking: { type: ... }`.
- For SiliconFlow, it currently emits `enable_thinking` and clamps `thinking_budget` to `128..=32768`.
- It already preserves a V3.1 + tools special case by stripping thinking fields.
- It removes sampling parameters when reasoning/thinking is enabled.
- Tests already cover official `deepseek-chat`, SiliconFlow V3.2, provider_type detection, V3.1 tool handling, sampling removal, and budget clamping.

### Frontend

- `apiCapabilityEngine.ts` flattens much of DeepSeek into V3.x-era hybrid reasoning rules and currently lacks first-class V4 recognition.
- `modelCapabilities.ts` has explicit V3.1/V3/V3.2 defaults, but the generic DeepSeek fallback gives all DeepSeek IDs the same defaults.
- `ShadApiEditModal.tsx` couples DeepSeek thinking toggles to `supportsReasoning`, so disabling thinking can erase capability metadata.
- `SiliconFlowSection.tsx` merges imported model capability signals and must keep V3.2 defaults while accepting future V4-shaped IDs.
- `modelConverters.ts` is part of the config persistence path and should be checked so new reasoning-effort defaults round-trip without accidental loss.

## Recommended Architecture

### Rust

- Add small internal helpers in `deepseek.rs`:
  - `DeepSeekModelVersion`: `V31`, `V32`, `V4`, `LegacyAlias`, `Unknown`.
  - `DeepSeekHostProtocol`: `Official`, `SiliconFlow`, `OtherHosted`.
  - `DeepSeekProfile`: version, host protocol, effort support, thinking default behavior.
- Let version profile answer model facts, and host protocol answer serialization facts.
- Normalize official V4 effort:
  - `none` or thinking disabled: omit `reasoning_effort`.
  - `low` / `medium`: send `high`.
  - `high`: send `high`.
  - `xhigh` / `max`: send `max`.
  - unknown values: omit or clamp to `high` only if existing code already tolerates that pattern.
- Keep SiliconFlow `thinking_budget` clamp unchanged for V3.2 and apply it to SiliconFlow-hosted DeepSeek V4 until SiliconFlow documents a different field.

### TypeScript

- Add V4-specific DeepSeek model matching before generic DeepSeek fallbacks.
- Add legacy alias handling that maps `deepseek-chat` and `deepseek-reasoner` to V4 Flash compatibility behavior without deleting existing saved configs.
- Add context heuristic ordering so V4 gets 1M before generic DeepSeek gets 128K.
- Keep conservative default output tokens while exposing larger capability limits if the app has a max-output field.
- Allow optional provider/platform input where needed so a SiliconFlow V4 model gets V4 capability/defaults but SiliconFlow request semantics.

### UI

- `supportsReasoning` is model capability.
- `enableThinking` is per-request default behavior.
- `reasoningEffort` should show for official V4-capable DeepSeek configs and round-trip cleanly.
- SiliconFlow V3.2 should not be mislabeled as official V4 just because it has reasoning/interleaved-thinking support.

## Risks and Mitigations

- Risk: Official aliases change again. Mitigation: keep alias handling explicit and covered by tests, and preserve old saved model IDs.
- Risk: SiliconFlow later publishes V4 with different request fields. Mitigation: keep host protocol isolated so the formatting branch can be changed without splitting adapters.
- Risk: 384K output maximum causes cost surprises if used as default. Mitigation: model it as a limit/capability, not an eager default.
- Risk: Tool-loop passback breaks if `reasoning_content` is dropped. Mitigation: add or preserve regression coverage around streaming reasoning and tool calls.
- Risk: UI toggle mutates capability metadata. Mitigation: separate `supportsReasoning` from `enableThinking` in save/update paths.

## Research Conclusion

The correct adaptation is not a new adapter per platform or version. It is a shared DeepSeek adapter with explicit model-version profiles and host-protocol serialization. This matches the user's direction and the current DeepStudent architecture.

## RESEARCH COMPLETE

