# Closure: format selector full-width regression

## Fix
- File: `src/features/ink/LazyInkEditor.tsx`
- Format toolbar (PNG/PDF) selected variant: `nav` → `outline`; unselected stays `ghost`.
- Size (`sm`), labels, handlers, `aria-pressed`, and container layout unchanged.

## Cause
`DsButton` variant `nav` applies the shell navigation tone, which includes `w-full` plus `min-h-[2.75rem]` and `justify-start`. The selected format button therefore stretched across the editor pane (measured ~1096px at a 1112px window) and pushed PDF offscreen.

## Verification
- RED first: new test in `src/features/ink/__tests__/LazyInkEditor.actions.test.tsx` asserts neither format button carries `w-full`, before and after selecting PDF, while keeping `aria-pressed` transitions.
- Main reports LazyInkEditor actions suite 4 and menu 12 GREEN (exit 0, run r1). Tests were not re-run in this change.

## Known limitation
`buttonPrimitiveContract.ts` maps both `outline` and `ghost` to `GHOST_TONE`. The selected button is now compact, but `outline` does not produce a visually distinct selected state versus `ghost`; selection remains conveyed by `aria-pressed` only. A real visual selected treatment would require a contract/theme change and was out of scope.

## Frozen
No further changes; no docs beyond this report.
