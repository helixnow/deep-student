# Roadmap: Deep Student - tool_pack

## Overview

This milestone adds `tool_pack`, a built-in tool that lets an agent submit a list of existing built-in tool calls and execute them in parallel. The work is split into a backend execution core, frontend/skill schema discoverability, and integration testing for the concurrent behavior.

## Phases

- [x] **Phase 1: Backend ToolPackExecutor** - Implement the Rust backend parallel execution engine and register it before the general executor.
- [x] **Phase 2: Frontend Skill Definition** - Register `tool_pack` as a built-in SkillDefinition so the LLM can discover and call it with the correct schema.
- [x] **Phase 3: Integration Testing & Edge Cases** - Validate end-to-end behavior, cancellation, mixed success/failure, and concurrent UI/database safety under realistic tool mixes.
- [x] **Phase 4: Implement windowed loading for markdown editor** - Mount configurable markdown line windows in Learning Hub notes and load more content on scroll while preserving save/conflict semantics.

## Phase Details

### Phase 1: Backend ToolPackExecutor
**Goal**: Implement the Rust backend ToolPackExecutor that receives `builtin-tool_pack` calls, validates sub-tools, executes them in parallel with isolation, and returns aggregated structured results.
**Depends on**: Nothing (first phase)
**Requirements**: [EXEC-01, EXEC-02, EXEC-03, EXEC-04, RES-01, RES-02, REG-02, REG-03, SAF-01, SAF-02, SAF-03, CAN-01, CAN-02]
**Success Criteria** (what must be TRUE):
  1. `builtin-tool_pack` dispatches multiple built-in sub-tools in parallel from the backend.
  2. Invalid inputs are rejected before execution: empty list, too many tools, unknown tools, blocking tools, and recursive tool_pack calls.
  3. A single sub-tool failure, timeout, or panic is captured in that sub-tool result without preventing other sub-tools from completing.
  4. Pack cancellation stops running sub-tools while preserving completed sub-tool results.
  5. The aggregated response contains per-tool status, output/error, duration, and summary totals.
**Plans**: 1 plan

Plans:
- [x] 01-01: Implement ToolPackExecutor core, timeout/cancellation handling, result aggregation, and registry integration.

### Phase 2: Frontend Skill Definition
**Goal**: Register `tool_pack` as a built-in SkillDefinition in the frontend Skills progressive-disclosure system so the agent can discover the tool, understand the `tools[]` input format, and call the backend executor.
**Depends on**: Phase 1
**Requirements**: [REG-01]
**Success Criteria** (what must be TRUE):
  1. A new frontend built-in tool skill file defines `builtin-tool_pack` with a clear name, description, and input schema.
  2. The schema requires a non-empty `tools` array of `{ name, args }` entries and includes optional `timeout` in seconds.
  3. Schema constraints mirror backend validation: minimum 1 tool, maximum 20 tools, required sub-tool `name`, and required sub-tool `args`.
  4. The new skill is exported through the existing `builtinToolSkills` aggregation path without changing execution orchestration in the frontend.
  5. Frontend type/test coverage proves the skill definition is registered and exposes the expected embedded tool schema.
**Plans**: 1 plan

Plans:
- [x] 02-01-PLAN.md - Harden the existing tool_pack SkillDefinition schema and add registration/schema contract tests.

### Phase 3: Integration Testing & Edge Cases
**Goal**: Validate `tool_pack` end-to-end with real built-in tools under parallel load, including mixed success/failure, cancellation, database writes, and frontend event interleaving.
**Depends on**: Phase 2
**Requirements**: [EXEC-01, EXEC-02, EXEC-03, EXEC-04, RES-01, RES-02, REG-01, REG-02, REG-03, SAF-01, SAF-02, SAF-03, CAN-01, CAN-02]
**Success Criteria** (what must be TRUE):
  1. End-to-end tests show an agent can call `builtin-tool_pack` and receive one aggregated result from multiple real sub-tools.
  2. Mixed success/failure runs preserve successful results and report failed sub-tools clearly.
  3. Cancellation during a running pack stops remaining work and preserves completed results.
  4. Concurrent tool events do not corrupt `MessageBlock` UI state.
  5. Write-heavy tool combinations are tested for SQLite/WAL contention and do not produce database lock failures under representative load.
**Plans**: 4 plans

Plans:
- [x] 03-01-PLAN.md - Backend harness, validation edge cases, and cancellation partial-result behavior.
- [x] 03-02-PLAN.md - Frontend tool_call event interleaving and explicit blockId routing tests.
- [x] 03-03-PLAN.md - Real built-in tool_pack aggregate and mixed success/failure integration tests.
- [x] 03-04-PLAN.md - SQLite/WAL write contention tests under representative tool_pack load.

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Backend ToolPackExecutor | 1/1 | Complete | 2026-06-27 |
| 2. Frontend Skill Definition | 1/1 | Complete | 2026-06-27 |
| 3. Integration Testing & Edge Cases | 4/4 | Complete | 2026-06-28 |
| 4. Implement windowed loading for markdown editor | 5/5 | Complete | 2026-06-29 |

### Phase 4: Implement windowed loading for markdown editor

**Goal:** Large Learning Hub markdown notes open without freezing by mounting only a configurable initial line window in the existing Crepe editor, loading more content as the user scrolls, and preserving save/conflict behavior across window expansion.
**Requirements**: TBD
**Depends on:** Phase 3
**Plans:** 5 plans

Plans:
- [x] 04-01-PLAN.md - Markdown window contracts and settings loader.
- [x] 04-02-PLAN.md - Initial line window settings UI.
- [x] 04-03-PLAN.md - Editor expansion, sentinel, and in-place Crepe updates.
- [x] 04-04-PLAN.md - Learning Hub window ownership and safe saves.
- [x] 04-05-PLAN.md - Final source contracts and performance verification.
