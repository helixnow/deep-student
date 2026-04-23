# Phase 5: Touch Targets And Verification - Patterns

**Mapped:** 2026-04-23
**Purpose:** Identify existing implementation and testing patterns to reuse while planning Phase 5.

## Closest Existing Patterns

| Target | Closest Pattern | How To Reuse |
|--------|-----------------|--------------|
| Touch target source | `src/styles/app.css` `--touch-target-size` and root `data-density` datasets | Reuse the existing token as the phone/tablet hit-area source of truth; avoid `mobile-*` or `tablet-*` token families. |
| Shared button geometry | `src/components/ui/button.tsx` exports `buttonSizeClassNames` and `buttonToneClassNames` | Fix touch sizing in the shared primitive first so composer, shell, and settings actions inherit the same contract. |
| Shell button reuse | `src/components/shell/ShellButton.tsx` imports shared button tokens | Keep tone/geometry reuse; change breakpoint compaction from tablet-breaking `md:` to desktop-safe `lg:` or density-driven sizing. |
| Sidebar nav overrides | `src/components/shell/Sidebar.tsx` passes compact row classes into `ShellButton` | Audit local `md:min-h-8` overrides because they can override shared shell button touch sizing in tablet widths. |
| Composer controls | `src/components/content/ThreadCanvas.tsx` uses shared `Button` and a persistent send icon button | Keep the input/send structure; only move desktop icon compaction to `lg:` or shared density behavior. |
| Settings touch rows | Phase 4 `SettingsSwitchRow` and tab classes | Preserve row-level touch targets, but move desktop shrink classes from `md:` to `lg:` where they affect height. |
| Source contract tests | Existing `*.source.test.ts` files | Use positive token/class assertions plus negative assertions for stale `md:` touch-target compaction. |
| Final acceptance | Phase 4 `04-UAT.md` and GSD verification docs | Create a committed Phase 5 manual acceptance artifact with viewport rows and PASS/FLAG/FAIL/N/A status vocabulary. |

## Files To Audit Carefully

| File | Why |
|------|-----|
| `src/components/ui/button.tsx` | Default, `sm`, and `icon` variants currently allow tablet shrink or compact-only geometry. |
| `src/components/ui/input.tsx` | `md:h-10` shrinks tablets even though tablets remain touch density. |
| `src/components/ui/switch.tsx` | Visual track is smaller than 44px and needs either density-aware root sizing or a tested hit-area contract. |
| `src/components/shell/ShellButton.tsx` | `md:min-h-9` on nav buttons conflicts with Phase 5 tablet touch sizing. |
| `src/components/shell/Sidebar.tsx` | Several local `md:min-h-8` overrides can undo drawer/tablet row height. |
| `src/components/content/ThreadCanvas.tsx` | Send button currently uses `md:h-[var(--button-icon-size)] md:w-[var(--button-icon-size)]`. |
| `src/components/content/SettingsPanel.tsx` | Compact tabs and triggers use `md:h-*` / `md:min-h-*` after Phase 4. |

## Testing Patterns

- Use source tests for class/token contracts where runtime DOM testing is not present.
- For every breakpoint fix, include both:
  - A positive assertion for the new desktop-safe class/token, such as `lg:h-10`.
  - A negative assertion for the old tablet-breaking class, such as `md:h-10`.
- Keep stale test repair in the same phase because false negatives block Phase 5 verification.
- Run targeted source/unit tests before full lint/build to catch class-contract regressions faster.

## Implementation Preference

Prefer the smallest shared fix that preserves desktop compactness:

1. Use `--touch-target-size` for phone/tablet hit boxes.
2. Use `lg:` or compact-density tokens for desktop shrink.
3. Keep visible chrome quiet and compact; enlarge hit area only as much as needed.
4. Avoid page forks, new dependencies, and new visual language.

---
*Phase: 05-touch-targets-and-verification*
*Pattern mapping completed: 2026-04-23*
