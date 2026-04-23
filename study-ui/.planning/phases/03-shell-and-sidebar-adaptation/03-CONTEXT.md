# Phase 3: Shell And Sidebar Adaptation - Context

**Gathered:** 2026-04-23
**Status:** Ready for execution fallback planning

<domain>
## Phase Boundary

Phase 3 adapts the shell navigation experience after Phase 1 and Phase 2 established responsive policy, split sidebar state, and root datasets. It should make compact phone/tablet navigation use the existing Sheet sidebar, keep desktop docked sidebar and native titlebar/window behavior intact, close compact drawer navigation after meaningful selections, and reduce app topbar desktop-only status noise on compact widths.

This phase does not migrate `ThreadCanvas` or `SettingsPanel` content surfaces to layout tokens, does not create a tablet rail mode, and does not globally audit every control target size. Those remain Phase 4 and Phase 5 work.
</domain>

<decisions>
## Implementation Decisions

- **D-01:** Keep `AppChrome` as the policy-aware router for drawer vs docked sidebar presentation.
- **D-02:** Compact navigation continues to use the existing `Sheet` and `Sidebar` component rather than forking a mobile sidebar.
- **D-03:** Add a small `closeOnSelect` contract to `Sidebar`; AppChrome passes it only for drawer mode.
- **D-04:** Folder disclosure rows do not close the drawer because they only expand/collapse navigation groups.
- **D-05:** Compact app topbar keeps the title and core new-conversation action while hiding desktop-only environment/mode/status/diff affordances.
- **D-06:** Desktop titlebar, traffic-light accessory, resize handles, and Windows custom controls should remain source-identical except where tests need stronger protection.
</decisions>

<canonical_refs>
## Canonical References

- `.planning/ROADMAP.md` - Phase 3 goal and success criteria.
- `.planning/REQUIREMENTS.md` - `SHELL-03`, `SHELL-04`, `SHELL-05`, `SHELL-06`.
- `.planning/phases/02-root-state-and-layout-tokens/02-01-SUMMARY.md` - Phase 2 state/dataset contracts.
- `src/components/shell/AppChrome.tsx` - Responsive shell router and topbar.
- `src/components/shell/AppChrome.source.test.ts` - Shell contract tests.
- `src/components/shell/Sidebar.tsx` - Shared drawer/docked navigation content.
- `src/components/shell/Sidebar.source.test.ts` - Sidebar source contract tests.
- `src/components/shell/Titlebar.tsx` - Desktop titlebar surface and window controls integration.
- `src/components/shell/Titlebar.source.test.ts` - Titlebar source contract tests.
- `src/lib/app-shell.ts` and `src/lib/app-shell.test.ts` - Platform/titlebar behavior contracts.
</canonical_refs>

<code_context>
## Existing Code Insights

- `AppChrome` already derives `shouldRenderDrawerSidebar` and `shouldRenderDockedSidebar` from `layoutPolicy.sidebarMode`.
- Compact drawer already uses `Sheet` with `SheetContent side="left"`, but the Sidebar does not yet know whether selecting an item should close the drawer.
- Desktop docked sidebar already uses `isDockedSidebarExpanded` and a width transition; this should not be replaced by overlay behavior.
- The app topbar always renders `本地环境`, `提交模式`, a status icon, and diff summary. These are useful desktop signals but too noisy for compact topbar space.
- `Titlebar`, `WindowControls`, and `FramelessResizeHandles` already encapsulate platform window behavior; Phase 3 should preserve those contracts.
</code_context>

<deferred>
## Deferred Ideas

- Tablet landscape rail mode remains a v2 enhancement.
- `ThreadCanvas` and composer safe-area/token consumption remains Phase 4.
- `SettingsPanel` responsive table/card degradation remains Phase 4.
- Whole-control 44px touch target audit remains Phase 5.
</deferred>

---
*Phase: 03-shell-and-sidebar-adaptation*
*Context gathered: 2026-04-23*
