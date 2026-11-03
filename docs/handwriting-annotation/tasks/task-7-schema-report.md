# Task 7 frontend schema slice report

Status: `IMPLEMENTED_UNVERIFIED`

## Scope delivered

- Implemented the six frontend `builtin-ink_prepare`, `builtin-ink_create`, `builtin-ink_get`, `builtin-ink_render`, `builtin-ink_apply_ops`, and `builtin-ink_export` schemas in `src/features/chat/skills/builtin-tools/ink-tools.ts`, and registered/exported the skill via `src/features/chat/skills/builtin-tools/index.ts`.
- Added localized `ink-tools` display name and description entries only in `src/locales/en-US/skills.json` and `src/locales/zh-CN/skills.json`.
- Schemas bound revision-sensitive render/apply/export requests, limited get responses by an object count, use zero-based page indexes, and define explicit normalized page/crop geometry and operation variants. `apply_ops` accepts only the eight designed operations and at most 100 per batch; unknown fields are rejected. No SVG/HTML/script/path field or dense stroke sample-array payload is exposed. Each normalized rectangle component is schema-bounded; the backend must enforce the cross-field rule that `x + width` and `y + height` remain within 1.
- Skill guidance distinguishes read-only recognition from write intent, requires precise confirmation for existing-object update/removal, documents local fixed-page conversion and quality-warning limits, and prohibits claiming image recognition absent actual visual input.
- Strengthened `inkTools.test.ts` with exact forbidden-property checks and representative accepted/rejected payloads across the create, prepare, get, render, export, and apply operation schemas using the existing CSP-safe JSON Schema validator.

## Validation status

The main agent's recorded run in `verification/task-5-7-schema-green.log` reports 5 of 6 `inkTools.test.ts` assertions passing, with the remaining failure caused by the export-description test requiring `不覆盖` when the description says `不会覆盖`. The test now accepts both equivalent wordings. The same recorded run exposed the missing locale entries; both were added. Neither fix has been rerun. This worker did not run tests, typecheck, or build after the schema/test updates, so the final diff remains unverified.

No tests/build/install were run here. No execution, Rust, or UI changes were made; no agents were launched and no commits were created.
