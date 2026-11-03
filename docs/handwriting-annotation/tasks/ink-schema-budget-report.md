# Ink schema budget regression

## Finding

The recorded frontend shard-4 run failed only the aggregate schema-token ceiling: 55,398 tokens versus 51,500 (`docs/handwriting-annotation/verification/vitest-final-shard-4.log:425-431`). The repeated nested property bodies in Ink operation `oneOf` branches and repeated common `get` selector properties were the avoidable schema expansion.

## Change applied

`src/features/chat/skills/builtin-tools/ink-tools.ts` now declares shared strict property maps for apply operations and updated-object content. Variant branches only specify their `op`/`kind`, required fields, forbidden fields, and variant-specific numeric constraint. The enclosing objects keep `additionalProperties: false`; required variant fields and existing enum/range/coordinate schemas remain. Apply batches remain ordered arrays bounded to 1–100 operations. The get schema shares its property map and rejects simultaneous `page_id` and `page_index`. No `$ref` or cross-file type changes were used; all six tools remain registered.

`src/features/chat/skills/__tests__/inkTools.test.ts` now reads shared plus branch-specific operation properties and adds rejection cases for fractional blank-page width and a model-provided `page_id` on a blank-page op. Existing behavior cases continue to cover strict unknown-property rejection, render provenance, geometry ranges, operation limits, selector exclusivity, and update/remove object requirements.

## Validator compatibility and verification

The existing MCP validator is `CfWorkerJsonSchemaValidator` (`src/mcp/cspSafeJsonSchemaValidator.ts`). Its installed schema types (`node_modules/@cfworker/json-schema/src/types.d.ts`) include `not`, `anyOf`, `oneOf`, `required`, `properties`, `additionalProperties`, and `$defs`/`$ref`; this change uses only standard composition keywords and no references. Provider adapters pass skill `inputSchema` through without schema rewriting in the inspected paths.

The worker did not run tests or builds. Main verification `schema-and-pdf-final-r2.log` passed 21/21, including six strict-schema tests, eight PDF asset guards, and seven token-budget checks; TypeScript checks also passed. Full frontend shards are recorded separately.

## Explicit additive feature budget (main ruling)

`schema-token-report-final.md` measures legacy groups at 51,299 schema tokens and the compact Ink group at 2,851; all groups are 54,150. The original legacy ceiling 51,500 has only 201 tokens of headroom, insufficient for six strict tools. Rather than dropping validation or changing unrelated tools, the test preserves the original 51,500 legacy schema ceiling and 76,600 legacy schema+prompt ceiling, adds Ink-specific limits of 3,000 schema / 3,200 schema+prompt tokens, and checks additive totals of 54,500 / 79,800. Measured combined schema+prompt is 79,688. This is an explicit new-feature token cost, not a claim that aggregate size stayed at its old ceiling. Runtime dependencies, tool count, schema validation, and lint baselines were not relaxed.
