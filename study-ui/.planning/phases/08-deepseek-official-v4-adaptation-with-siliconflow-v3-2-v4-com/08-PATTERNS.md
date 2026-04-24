---
phase: 08-deepseek-versioned-adapter-compatibility
status: complete
created: 2026-04-24
---

# Phase 8 Patterns: Existing Code to Follow

## Backend Adapter Patterns

- `src-tauri/src/llm_manager/adapters/deepseek.rs`
  - Use this as the primary implementation site.
  - Preserve the existing single-adapter structure.
  - Extend current test style rather than moving tests elsewhere.
  - Keep the existing SiliconFlow detection and budget clamp behavior as the compatibility baseline.

- `src-tauri/src/llm_manager/adapters/mod.rs`
  - Follow the existing aggregator rule: aggregator provider types such as SiliconFlow do not override model-family adapters.
  - Do not introduce a SiliconFlow-only DeepSeek adapter unless this routing architecture changes in a separate phase.

- `src-tauri/src/llm_manager/adapters/generic_openai.rs`
  - Use as a reference for reasoning-effort pass-through and validation patterns if needed.

- `src-tauri/src/llm_manager/adapters/doubao.rs`
  - Use as a reference for provider-specific thinking field normalization if the implementation needs another example of request-shape branching.

## Reasoning and Streaming Patterns

- `src-tauri/src/providers/mod.rs`
  - Existing streaming handling already reads `delta.reasoning_content`.
  - Prefer regression coverage and comments over rewriting provider streaming code unless inspection finds a real gap.

- `src-tauri/src/reasoning_policy.rs`
  - Existing DeepSeek-style passback policy is the right abstraction.
  - Update comments/tests from "DeepSeek V3.x" to the broader DeepSeek family where appropriate.

## Frontend Capability Patterns

- `src/utils/apiCapabilityEngine.ts`
  - Add V4 matching before broad DeepSeek matching, matching the existing pattern where specific families are detected before generic provider regexes.
  - Preserve registry-derived optional parameter support.
  - Keep context-window rules ordered from specific to generic.

- `src/utils/modelCapabilities.ts`
  - Existing defaults map is the closest analog for V3.2/V4 default parameter profiles.
  - Add helper-level tests if new provider-aware defaults are introduced.
  - Keep adapter detection family-based: any DeepSeek model should still return adapter `deepseek`.

## Settings UI Patterns

- `src/components/settings/ShadApiEditModal.tsx`
  - Use existing provider-specific cards/panels rather than creating a new DeepSeek modal.
  - Reuse the existing reasoning-effort select used by other providers where possible.
  - Keep the fix semantic and minimal: capability fields are not the same thing as toggle fields.

- `src/components/settings/SiliconFlowSection.tsx`
  - Preserve existing SiliconFlow import flow and capability merging.
  - If provider-aware defaults are added, pass SiliconFlow provider/platform context from here rather than duplicating DeepSeek model matching in the component.

- `src/components/settings/modelConverters.ts`
  - Follow existing conversion helpers for optional reasoning fields.
  - Ensure new/defaulted fields round-trip without deleting user-saved legacy configs.

## Test Patterns

- Rust adapter tests should live beside `DeepSeekAdapter` in `deepseek.rs`.
- Capability tests should extend `src/utils/__tests__/apiCapabilityEngine.test.ts`.
- If default-parameter behavior becomes provider-aware, add a focused `src/utils/__tests__/modelCapabilities.test.ts` rather than overloading unrelated UI tests.
- Prefer deterministic unit/source tests. Do not require real DeepSeek or SiliconFlow API keys for this phase.

## Anti-Patterns to Avoid

- Do not create separate official and SiliconFlow DeepSeek adapters.
- Do not treat `deepseek-chat` and `deepseek-reasoner` as deleted/invalid; existing users may have saved configs.
- Do not send official DeepSeek V4 `thinking` fields to SiliconFlow by accident.
- Do not set V4 maximum output as the default generated output length.
- Do not let UI "disable thinking" mutate `supportsReasoning` to false.
- Do not remove existing V3.1 tool-call special handling while adding V4.

