# Phase 1: Responsive Policy Foundation - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md - this log preserves the alternatives considered.

**Date:** 2026-04-23
**Phase:** 1 - Responsive Policy Foundation
**Areas discussed:** Breakpoint model, Module boundaries, Policy shape, AppChrome consumption, Test strategy

---

## Breakpoint Model

| Option | Description | Selected |
|--------|-------------|----------|
| User-provided three-tier model | `phone < 640`, `tablet 640-1023`, `desktop >= 1024`; compact behavior below `1024`. | yes |
| Keep existing `<768` compact split | Minimal change, but preserves the current tablet ambiguity. | |
| Add many device/orientation branches now | More expressive, but too broad for Phase 1 and likely overfits. | |

**User's choice:** Use the user-provided three-tier model.
**Notes:** This was already supplied in the user's research conclusion and is treated as locked context.

---

## Module Boundaries

| Option | Description | Selected |
|--------|-------------|----------|
| Separate `responsive-env` and `app-layout-policy` | Cleanly separates viewport facts from app decisions and matches the roadmap. | yes |
| Put everything into `app-shell.ts` | Fewer files, but mixes desktop window geometry with responsive policy. | |
| Keep policy inside `AppChrome` | Fastest local change, but repeats the current maintainability problem. | |

**User's choice:** Separate `responsive-env` and `app-layout-policy`.
**Notes:** Current `app-shell.ts` already has desktop shell responsibilities; keeping it focused reduces regression risk.

---

## Policy Shape

| Option | Description | Selected |
|--------|-------------|----------|
| Minimal stable policy | Return `formFactor`, `isCompact`, `sidebarMode`, and `density`; leave room for later fields. | yes |
| Large all-in-one layout policy | Include every future token and shell detail now; risks doing Phase 2/3 prematurely. | |
| Boolean-heavy policy | Simpler at first, but harder to extend to future rail/tablet states. | |

**User's choice:** Minimal stable policy with string-union outputs.
**Notes:** Tablet rail remains a future extension seam, not a Phase 1 behavior.

---

## AppChrome Consumption

| Option | Description | Selected |
|--------|-------------|----------|
| Move compact viewport logic behind the new policy | Removes `matchMedia("(max-width: 767px)")` from `AppChrome` while preserving shell behavior. | yes |
| Rewrite AppChrome shell now | Would blend Phase 1 with Phase 3 and increase regression risk. | |
| Leave AppChrome unchanged | Would fail Phase 1 success criteria. | |

**User's choice:** Move compact viewport logic behind the new policy only.
**Notes:** Visible shell/sidebar behavior should not change in Phase 1 beyond the decision source.

---

## Test Strategy

| Option | Description | Selected |
|--------|-------------|----------|
| Unit tests plus source contract tests | Covers pure breakpoint/policy logic and prevents local matchMedia regression in `AppChrome`. | yes |
| Source tests only | Can catch strings but does not prove boundary math. | |
| Manual validation only | Insufficient for a policy foundation phase. | |

**User's choice:** Unit tests plus source contract tests.
**Notes:** Existing `src/lib/app-shell.test.ts` should remain green.

---

## the agent's Discretion

- Exact function names and hook naming.
- Whether policy exposes `contentMaxWidth`/`pageGutter` in Phase 1 or waits until Phase 2, as long as the required fields are stable.
- Exact density labels, provided they clearly separate compact/touch-oriented behavior from desktop behavior.

## Deferred Ideas

- Tablet landscape rail mode.
- Mobile keyboard/composer safe-area behavior.
- SettingsPanel dense-region degradation.
- Global touch target normalization.
