---
phase: 03-integration-testing-edge-cases
plan: 02
subsystem: testing
tags: [vitest, tool_pack, tool_call, eventBridge, blockId]

requires:
  - phase: 02-frontend-skill-definition
    provides: "tool_pack SkillDefinition registration and schema contract"
provides:
  - "Regression coverage for real tool_call plugin interleaving with explicit tool_pack backend block ids"
  - "Regression coverage for eventBridge routing of tool_call end/error events by explicit backend blockId"
affects: [frontend-event-routing, tool-pack-ui-safety, SAF-01]

tech-stack:
  added: []
  patterns:
    - "Stateful Vitest ChatStore helper for MessageBlock map and message.blockIds assertions"
    - "Actual tool_call handler registration in eventBridge tests after eventRegistry.clear()"

key-files:
  created:
    - ".planning/phases/03-integration-testing-edge-cases/03-02-SUMMARY.md"
  modified:
    - "tests/vitest/chat-v2/plugins/events/toolCall.test.ts"
    - "tests/vitest/chat-v2/middleware/eventBridge.test.ts"

key-decisions:
  - "Kept Phase 03 Plan 02 test-only; production tool_call/eventBridge behavior already satisfied the regression expectations."
  - "Registered the exported actual toolCallEventHandler in eventBridge tests instead of using a synthetic mcp_tool handler."

patterns-established:
  - "tool_pack frontend interleaving tests should assert explicit backend block ids parent-tool_pack-0 and parent-tool_pack-1 through start/end/error flows."
  - "Preparing block replacement tests should inspect message.blockIds order after replaceBlockId."

requirements-completed: [SAF-01]

duration: 8 min
completed: 2026-06-28
---

# Phase 03 Plan 02: Frontend Tool Call Event Interleaving Summary

**Vitest regression coverage for explicit tool_pack blockId routing through the real tool_call plugin and eventBridge path**

## Performance

- **Duration:** 8 min
- **Started:** 2026-06-28T07:44:08Z
- **Completed:** 2026-06-28T07:50:37Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments

- Added stateful `tool_call` plugin tests proving out-of-order tool_pack success and error events stay attached to `parent-tool_pack-0` and `parent-tool_pack-1`.
- Added preparing block replacement coverage proving `message.blockIds` remains `['parent-tool_pack-0', 'parent-tool_pack-1']`.
- Added eventBridge tests using `type: 'tool_call'` and the actual exported handler, not the older synthetic `mcp_tool` handler.

## Task Commits

Each task was committed atomically:

1. **Task 1: Test actual tool_call plugin out-of-order interleaving** - `cfb9b952` (test)
2. **Task 2: Test eventBridge routes explicit tool_call block ids** - `f8f87537` (test)

## Files Created/Modified

- `tests/vitest/chat-v2/plugins/events/toolCall.test.ts` - Adds a stateful ChatStore helper and three `tool_pack interleaving` tests for result routing, preparing replacement order, and explicit error placement.
- `tests/vitest/chat-v2/middleware/eventBridge.test.ts` - Adds actual `tool_call` handler registration and two bridge tests for reversed end events and explicit error block routing.
- `.planning/phases/03-integration-testing-edge-cases/03-02-SUMMARY.md` - Documents plan execution and verification.

## Verification

- `npm run test:unit -- --run tests/vitest/chat-v2/plugins/events/toolCall.test.ts` - PASS, 16 tests.
- `npm run test:unit -- --run tests/vitest/chat-v2/middleware/eventBridge.test.ts` - PASS, 18 tests.
- `npm run test:unit -- --run tests/vitest/chat-v2/plugins/events/toolCall.test.ts tests/vitest/chat-v2/middleware/eventBridge.test.ts` - PASS, 2 files, 34 tests.
- `rg -n "describe\\('tool_pack interleaving'|parent-tool_pack-0|parent-tool_pack-1|parent-tp-0|parent-tp-1|tool_pack interleaving keeps out-of-order results" tests/vitest/chat-v2/plugins/events/toolCall.test.ts` - PASS.
- `rg -n "replaceBlockId|createBlockWithId|setBlockResult|setBlockError|message\\.blockIds" tests/vitest/chat-v2/plugins/events/toolCall.test.ts` - PASS.
- `rg -n "tool_pack tool_call bridge interleaving|routes tool_pack tool_call events by explicit backend blockId|routes tool_pack tool_call error by explicit backend blockId|parent-tool_pack-0|parent-tool_pack-1|phase 3 bridge failure" tests/vitest/chat-v2/middleware/eventBridge.test.ts` - PASS.
- `rg -n "type: 'tool_call'|phase: 'start'|phase: 'end'|phase: 'error'" tests/vitest/chat-v2/middleware/eventBridge.test.ts` - PASS.
- `git diff --name-only -- "*.ts" "*.tsx" ":!tests/**"` - PASS, no production TypeScript files modified by this plan.

## Decisions Made

- Used a separate stateful helper for new plugin tests so existing lightweight mock-store assertions remained unchanged.
- Used `toolCallEventHandler` exported by the production plugin in eventBridge tests after clearing the registry, preserving actual handler behavior without relying on module reset/re-import timing.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- `.planning/PROJECT.md` and `.planning/phases/02-frontend-skill-definition/02-01-SUMMARY.md` were absent in this workspace when context files were loaded. The required task `read_first` files were present and read, and execution used the plan, STATE/ROADMAP/REQUIREMENTS, research, patterns, and source files.
- The PowerShell `Get-Date -AsUTC` flag was unavailable; UTC timestamps were captured with `(Get-Date).ToUniversalTime()` instead.

## Known Stubs

None. Stub-pattern scanning found only the existing `createMockStore(overrides: Partial<ChatStore> = {})` test-helper default parameter, not UI-rendered placeholder data.

## Threat Flags

None. This plan added frontend regression tests only and introduced no new endpoints, auth paths, file access patterns, or schema changes.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Frontend SAF-01 coverage is ready for the remaining Phase 03 backend and database integration plans. The working tree contains unrelated Rust changes from another executor, but this plan touched only its allowed test files and summary.

## Self-Check: PASSED

- Summary file exists at `.planning/phases/03-integration-testing-edge-cases/03-02-SUMMARY.md`.
- Task commit `cfb9b952` exists.
- Task commit `f8f87537` exists.
- `.planning/STATE.md`, `.planning/ROADMAP.md`, `.planning/REQUIREMENTS.md`, and `.planning/PROJECT.md` were not modified.

---
*Phase: 03-integration-testing-edge-cases*
*Completed: 2026-06-28*
