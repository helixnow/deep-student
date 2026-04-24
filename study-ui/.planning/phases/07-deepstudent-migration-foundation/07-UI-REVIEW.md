# Phase 7 — UI Review

**Audited:** 2026-04-24
**Baseline:** `07-UI-SPEC.md` + `07-01-PLAN.md` + `07-01-SUMMARY.md`
**Screenshots:** not captured; browser-only runtime still stalls without Tauri/database APIs, as noted in the phase summary.

---

## Pillar Scores

| Pillar | Score | Key Finding |
|--------|-------|-------------|
| 1. Copywriting | 3/4 | Core labels remain clear, but the database-init warning previously duplicated a technical failure phrase across a persistent chrome banner. |
| 2. Visuals | 3/4 | Phase 7 primitive/token convergence is strong; the database-init banner was a visual outlier and has been moved into the unified notification pattern. |
| 3. Color | 4/4 | The notification now consumes existing unified toast variant styling instead of one-off yellow banner classes. |
| 4. Typography | 4/4 | The unified notification keeps the message/title on the existing compact 13px rhythm. |
| 5. Spacing | 4/4 | Removing the full-width banner avoids pushing workspace content and reuses the existing toast container spacing. |
| 6. Experience Design | 3/4 | Toast is the better fit for post-retry initialization failure; the remaining risk is that broader notification action patterns still rely on ad hoc global events. |

**Overall: 21/24**

---

## Top 3 Priority Fixes

1. **Prefer toast over persistent banner for database-init failure** — the failure is already delayed until background retries finish, so it behaves like an actionable system notification rather than a durable app-wide mode.
2. **Reuse the existing notification primitive** — adding an optional action slot to `UnifiedNotification` keeps the visual language, mobile placement, animation, close affordance, and accessibility semantics in one place.
3. **Keep persistent banners for persistent system states only** — maintenance mode and migration repair states may justify a banner/status component; a single startup failure should not add another shell row.

---

## Focused Finding

The previous `App.tsx` database warning duplicated the same yellow full-width banner markup and introduced a bespoke action button style:

- It competed with `MigrationStatusBanner` and `NotificationContainer`.
- It shifted the workspace vertically even though the event is not a layout state.
- It repeated warning color decisions outside the tokenized notification component.
- It had a real duplication symptom in the rendered DOM supplied for review.

The updated approach routes the final post-retry database failure through `showGlobalNotification('warning', ...)` with a reusable action:

- `src/components/UnifiedNotification.tsx` now supports an optional `action`.
- `src/hooks/useUnifiedNotification.ts` carries that action through the notification queue.
- `src/hooks/useAppInitialization.ts` attaches `去设置` and routes to Settings/Data Governance.
- `src/App.tsx` no longer renders the one-off database warning banner.

---

## Recommendation

Use toast here, but not a throwaway toast style. The right model is:

- transient or recoverable startup failure: unified toast with action;
- durable mode or global restriction: persistent banner/status surface;
- destructive/blocking flow: dialog or dedicated repair screen.

For this case, the unified toast is the best fit because the app already retries for roughly 19 seconds before notifying the user, and the notification only needs one clear recovery action.

---

## Verification

| Command | Result | Notes |
|---------|--------|-------|
| `npm run test -- src/components/ui/__tests__/migrationFoundation.source.test.ts` | Passed | 5/5 tests passed. |
| `npx eslint src/App.tsx src/components/UnifiedNotification.tsx src/hooks/useUnifiedNotification.ts src/hooks/useAppInitialization.ts` | Passed with warnings | No errors. Existing warnings remain for legacy raw buttons and direct event listeners. |
| `git diff --check` | Passed | No whitespace/conflict-marker issues. |
| `npx tsc --noEmit` | Blocked by existing unrelated errors | Failures are in chat-v2, notes, debug-panel, question-bank files, not this notification change. |

---

## Files Audited

- `study-ui/.planning/phases/07-deepstudent-migration-foundation/07-UI-SPEC.md`
- `study-ui/.planning/phases/07-deepstudent-migration-foundation/07-01-PLAN.md`
- `study-ui/.planning/phases/07-deepstudent-migration-foundation/07-01-SUMMARY.md`
- `src/App.tsx`
- `src/components/UnifiedNotification.tsx`
- `src/components/UnifiedNotification.css`
- `src/components/NotificationContainer.tsx`
- `src/hooks/useUnifiedNotification.ts`
- `src/hooks/useAppInitialization.ts`
- `src/components/system-status/MigrationStatusBanner.tsx`
