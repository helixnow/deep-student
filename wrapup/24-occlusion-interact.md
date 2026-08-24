# Occlusion preview interaction

## Scope

- Kept the existing percentage-positioned preview overlay and added only the
  minimum reveal interaction needed for review.
- Added explicit Enter/Space activation without adding drag, resize, or
  occlusion editing behavior.
- No Rust files were changed.

## Behavior

- Clicking, pressing Enter, or pressing Space on a mask reveals every box with
  the same `clozeIndex`.
- Overlay activation stops at the mask, so nested card expand, flip, and edit
  actions are not triggered.
- Controlled `revealedIndices`, `revealAll`, and the existing uncontrolled
  reveal mode remain supported.
- Invalid roots, invalid geometry, non-finite values, invalid cloze indices,
  and exceptional property access degrade to an empty or partially filtered
  overlay instead of crashing.
- Generated cloze indices wrap to an unused safe positive integer after
  `Number.MAX_SAFE_INTEGER`.

## Verification

- Focused Vitest coverage includes click, Enter, Space, grouped reveal,
  controlled reveal, event isolation, spec switching, invalid specs, VFS/local
  image preview wiring, and collapsed/expanded block behavior.
