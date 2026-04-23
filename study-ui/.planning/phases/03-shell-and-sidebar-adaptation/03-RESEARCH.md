# Phase 3: Shell And Sidebar Adaptation - Research

**Researched:** 2026-04-23
**Mode:** Manual fallback, codebase-local research

## Findings

### Shell Routing

`AppChrome.tsx` already consumes `getAppLayoutPolicy` and derives:

- `isCompactViewport`
- `shouldRenderDrawerSidebar`
- `shouldRenderDockedSidebar`
- `isSidebarVisible`
- `isDockedSidebarExpanded`

This means Phase 3 can improve behavior without adding another responsive source of truth.

### Compact Drawer

The compact branch already renders:

- `Sheet`
- `SheetContent side="left"`
- Shared `Sidebar`

The missing piece is a compact-only close-after-selection contract. Adding this to `Sidebar` keeps one component tree and avoids a separate mobile UI.

### Desktop Shell Preservation

Desktop behavior is guarded by existing source contracts:

- `FramelessResizeHandles enabled={showResizeHandles}`
- `WindowControls visible={shouldShowCustomWindowControls(...)}`
- macOS traffic-lights accessory gated by `!isCompactViewport`
- docked sidebar width transition with `isDockedSidebarExpanded`

Phase 3 should strengthen AppChrome tests rather than rework titlebar internals.

### Sidebar Selection Behavior

`Sidebar.tsx` has three navigation categories:

- Primary app entries
- Pinned/recent thread entries
- Settings back/settings tab entries

Folder disclosure rows are not final navigation targets, so they should expand/collapse without closing the drawer.

### Compact Topbar

The app topbar currently renders desktop utility/status items on all widths. On phone/tablet this consumes the right side of the titlebar and competes with the core navigation affordance. A policy-derived branch should keep desktop status on desktop and expose a compact core action on compact widths.

## Recommended Implementation

1. Add `showDesktopHeaderStatus = !isCompactViewport` and `showCompactHeaderActions = isCompactViewport` in `AppChrome`.
2. Render desktop-only `本地环境`, `提交模式`, status icon, and diff summary only when `showDesktopHeaderStatus` is true.
3. Render a compact `新建对话` icon action when `showCompactHeaderActions` is true.
4. Pass `closeOnSelect={shouldRenderDrawerSidebar}` from AppChrome to Sidebar.
5. Add `closeSidebarAfterSelection` helper inside Sidebar and wire it to primary rows, thread rows, return-to-app, and inactive settings tabs.
6. Keep folder disclosure rows as disclosure-only actions.
7. Update source tests to lock drawer/docked behavior, compact topbar gating, and close-on-select semantics.

## Risks

- Closing the drawer on folder disclosure would feel broken because users may be expanding a group, not navigating.
- Closing the drawer on active settings tab would create unnecessary motion without changing destination.
- Moving desktop titlebar/window logic during this phase would increase regression risk and is not needed for the requirement.

---
*Phase: 03-shell-and-sidebar-adaptation*
*Research completed: 2026-04-23*
