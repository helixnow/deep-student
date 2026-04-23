# Phase 4: Content Surface Adaptation - Patterns

**Mapped:** 2026-04-23
**Purpose:** Identify existing code patterns to follow during implementation.

## Closest Existing Patterns

| Target | Closest Pattern | How To Reuse |
|--------|-----------------|--------------|
| `ThreadCanvas` layout | Phase 2 `app.css` layout tokens and AppChrome root datasets | Consume existing CSS variables directly; do not create component-local breakpoints. |
| Thread composer | Current `ThreadCanvas` textarea + secondary controls + circular send button | Preserve component structure and state; only adapt outer geometry and compact action rhythm. |
| Settings shared page | `SettingsSection`, `SettingBlock`, `SettingsRow` | Add responsive behavior to shared helpers and small local helpers instead of page forks. |
| Settings controls | `settings-control-styles.ts`, `settings-actions.ts`, `settings-input-styles.ts` | Reuse existing radius, height, and surface classes; add row-level touch affordance locally. |
| Settings dense cards | `DataFlowCard`, `ModelAssignmentCard`, `OcrEngineCard` | Use labeled compact cards/definition lists with existing quiet surfaces. |
| Source contracts | Existing `*.source.test.ts` files | Lock structure by asserting token names, data slots, and absence of old hard-coded classes. |
| AppChrome settings scroll | Existing safe-area top/bottom calculations | Keep top/bottom values and add tokenized inline safe-area gutters only. |

## Files To Avoid Unless Strictly Necessary

| File | Reason |
|------|--------|
| `src/components/ui/tabs.tsx` | Local `TabsList`/`TabsTrigger` classes in `SettingsPanel` can satisfy short-tab behavior. |
| `src/components/ui/switch.tsx` | Global switch primitive works; Phase 4 only needs SettingsPanel row-level target behavior. |
| `src/styles/app.css` | Existing tokens are sufficient; adding new shared tokens increases scope and test surface. |
| `src/components/shell/Sidebar.tsx` | Phase 3 already stabilized compact drawer behavior. |
| `src/components/shell/Titlebar.tsx` | Phase 4 content work should not affect titlebar/window controls. |

## Testing Patterns

- Use source tests to assert exact token names such as `--workspace-max-width` and `--layout-safe-area-bottom`.
- Use negative assertions for old desktop-only classes such as `max-w-[44rem]`, `max-w-[46rem]`, and `px-4 md:px-8`.
- Add stable `data-slot` names for new structural fallbacks:
  - `thread-content-shell`
  - `thread-composer-shell`
  - `settings-switch-row`
  - `embedding-dimensions-cards`
  - `embedding-dimensions-table`
- Keep automated validation targeted:
  - `ThreadCanvas.source.test.ts`
  - `SettingsPanel.source.test.ts`
  - `AppChrome.source.test.ts`
  - existing responsive policy and app style tests

## Implementation Preference

Use existing CSS variables through inline style objects where safe-area calc strings are clearer than Tailwind arbitrary classes. This keeps the implementation simple, source-testable, and independent from Tailwind parser edge cases.

---
*Phase: 04-content-surface-adaptation*
*Pattern mapping completed: 2026-04-23*
