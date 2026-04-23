# Pitfalls Research: Mobile Adaptation

## Pitfall 1: Treating Tablet As Either Phone Or Desktop

Warning signs:

- `max-width: 767px` remains the only shell split.
- `md:` classes accidentally restore desktop spacing on tablet portrait.
- Tablet landscape and portrait produce the same navigation behavior.

Prevention:

- Use explicit `phone`, `tablet`, and `desktop` form factors.
- Start with compact behavior for all `<1024`, then layer tablet improvements intentionally.

## Pitfall 2: Overloading Sidebar State

Warning signs:

- One boolean controls mobile drawer visibility, desktop dock visibility, and settings forced-open behavior.
- Closing a mobile drawer unexpectedly collapses desktop sidebar after resize.

Prevention:

- Split `mobileSidebarOpen` from `sidebarCollapsed`.
- Derive visible sidebar state from policy and mode.

## Pitfall 3: Token Drift

Warning signs:

- New `px-*`, `max-w-*`, or hard-coded safe-area values appear in multiple components.
- JS and CSS each maintain their own breakpoint constants.

Prevention:

- Define minimal layout tokens in `app.css`.
- Keep breakpoint values in one JS module and assert them with tests.

## Pitfall 4: Mobile Composer Obstruction

Warning signs:

- Composer uses only fixed bottom padding.
- Keyboard open state causes input to disappear or scroll area to collapse.
- Safe-area variables are defined but not consumed by composer layout.

Prevention:

- Use safe-area tokens on composer container.
- Reserve a policy state for keyboard-aware layouts even if initial implementation only creates stable hooks.

## Pitfall 5: Settings Density Overflow

Warning signs:

- Pseudo-table grids remain six columns on phone/tablet.
- Switches are only clickable on the control itself.
- Tabs overflow or compress labels beyond readability.

Prevention:

- Degrade dense regions to cards/definition lists under desktop width.
- Make switch rows fully clickable.
- Use equal-width tabs for fixed small sets or horizontal scroll for variable sets.

## Pitfall 6: Desktop Regression

Warning signs:

- Windows controls move or become touch-sized in desktop titlebar unexpectedly.
- Drag region breaks after mobile topbar changes.
- Frameless resize handles stop rendering in Tauri runtime.

Prevention:

- Keep desktop titlebar/window behavior behind desktop policy.
- Add source tests that desktop code paths remain present.
- Manually validate `980 x 680` desktop minimum window.
