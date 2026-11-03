# Task 3 report — geometry, input, and renderer

Status: **NEEDS_RED_VERIFICATION**. Main reports 25 focused ink unit tests passed and the exact renderer CT had 4 passed / 1 failed before the region pixel expectation was corrected. This pass adds focused renderer edge-case expectations and makes the noted compile/expectation corrections. New/changed tests have not been run; main should rerun the focused ink unit suite and exactly `tests/ct/ink/renderer.spec.tsx` (not a regex that also matches ink-office tests). No tests, builds, or installs were run here; no commits or pushes were made.

## Implementation files

- `src/features/ink/geometry.ts` — viewport conversion, crop-to-page mapping/validation, and stroke/shape hit-testing.
- `src/features/ink/input.ts` — DOM-independent pointer-like sample conversion, coalesced sample filtering, pressure fallback, terminal sample retention, optional page bounds.
- `src/features/ink/renderer.ts` — synchronous Canvas page renderer with crop, scale and pixel budgets, background/ruling, text and all object variants, pressure-sized pen/highlighter strokes, and single-layer multiply compositing for highlighters.

## Tests and harness

- `src/features/ink/__tests__/geometry.test.ts`
- `src/features/ink/__tests__/input.test.ts`
- `src/features/ink/__tests__/renderer.test.ts` — max-pixel budget (`0.5`, `NaN`), mismatched page ID, and invalid scale expectations.
- `tests/ct/ink/InkRendererHarness.tsx`
- `tests/ct/ink/renderer.spec.tsx` — real-canvas background/pen/highlighter/shape/bottom-of-page pixels, deterministic rerender, crop mapping, pixel-budget bounds, markup-looking plain text, retraced-highlighter same-alpha expectations, and pressure endpoint/dot expectations.

The text CT reference uses an explicitly specified `system-ui, sans-serif` font and independently listed wrapped lines; it does not call production wrapping helpers. The region-highlight pixel expectation is `[0, 0, 238, 255]`: full-blue source under multiply on the fixture's gray `[238, 238, 238, 255]` paper. This preserves the requested multiply ruling rather than changing renderer compositing to satisfy an incorrect source-over expectation.

The renderer type correction removes the unused crop argument from `drawObject` and its call. Color alpha detection now recognizes the v1 `#RRGGBBAA` form only. The new tests await main's red verification before further implementation changes. No modifications were made to shared `types.ts`, Rust, storage, Office, or global test configuration.
