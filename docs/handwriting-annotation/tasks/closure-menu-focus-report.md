# Closure menu focus flake report (shard 1)

Scope: `src/components/ui/app-menu/AppMenu.keyboard.test.tsx` plus the one authorized guard predicate in `src/components/ui/app-menu/AppMenu.tsx`. No commits; main owns the final full-shard rerun.

## 1. Failure

`verification/closure-vitest-shard-1-r1.log:61`:

- Test: `AppMenu submenu keyboard contract > does not reset submenu focus when its parent rerenders`
- Expected focus: `menuitem "Beta"`; received focus: the root `role="menu"` shell.
- Isolated run (`verification/closure-appmenu-isolated-r1.log`) was 11/11 green, so it was a scheduling race rather than a broken contract.

Main later reproduced it deterministically: `verification/closure-appmenu-new-red-r2.log`, exit 1, expected Beta vs focus root (actual behavior RED).

## 2. Root cause (real defect)

`AppMenuContent`'s open-focus handoff waits for `useMotionPresence` to flip `shown` (two rAFs for `enter: 'transition'`) and then runs on a 0 ms timer:

- `src/components/ui/app-menu/AppMenu.tsx:542-559` (base): the handoff unconditionally focuses the root shell (pointer open) or first item (keyboard open).
- `src/components/ui/app-menu/AppMenu.tsx:1013-1029`: the submenu has its own, much earlier 0 ms keyboard-focus handoff (`enter: 'animation'`).

If the submenu opens before the root rAF chain settles, the root handoff fires afterwards and pulls focus out of an already-focused submenu item. This is reachable UI behavior (fast key repeat / automation), so the fix belongs in production code, not only in the fixture.

Submenu content is portaled to `document.body` but carries `data-app-menu-id={rootMenuCtx?.menuId}` (`AppMenu.tsx:1144`), which is the hook the guard uses.

## 3. Production change (authorized after RED)

Single guard predicate inside the existing root handoff timer, after `if (!isOpen) return;`:

```ts
if (
  ctx?.menuId
  && document.activeElement instanceof HTMLElement
  && document.activeElement.closest('[data-app-menu-id]')?.getAttribute('data-app-menu-id') === ctx.menuId
) return;
```

If focus is already inside the root menu or any of its portaled submenus for the same menu id, the delayed handoff is a no-op. The guard's `ctx.menuId` read was added to the effect dependency array as required by the exhaustive-deps ratchet (`components` 37→38, 172 vs 171); no suppress/baseline edits.

## 4. Test changes

- Existing rerender test: added `await waitFor(() => expect(screen.getByRole('menu')).toHaveFocus())` before `ArrowRight`, matching the sibling root-rerender test. This keeps the original Beta-after-rerender assertion but removes the unrelated root-handoff race from it.
- New regression `keeps submenu focus when the parent open-focus handoff fires afterwards`:
  - `vi.useFakeTimers` faking `setTimeout` + `requestAnimationFrame`.
  - Opens the submenu with `ArrowRight`, `await act(advanceTimersByTime(0))` to land Alpha focus.
  - Focuses Beta.
  - Steps the root handoff frame by frame with a flush between each: `await act(advance 16)`, `await act(advance 16)`, `await act(advance 1)`.
  - Asserts Beta still has focus.

## 5. Verification evidence

- On base source (guard absent): the new regression fails at `expect(beta).toHaveFocus()` with the root menu shell receiving focus, confirming behavior-RED locally.
- With the guard applied: the new regression passes (isolated 12/12, and the whole `src/components/ui/app-menu/` set was 30/30 before the final predicate rewrite).
- Main's `closure-appmenu-new-red-r2.log` is the authoritative behavior-RED gate that authorized the guard.
- Per instruction, no further tests were run by this hand after freezing the one-line guard; main runs the final full shard.

## 6. Residual risk

The guard deliberately skips the delayed handoff whenever focus is already inside the same menu id, so a future caller that expects to re-focus the root shell/first item after focus moved inside the menu would become a no-op. No current caller or test relies on that.
