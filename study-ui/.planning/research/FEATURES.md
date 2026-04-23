# Feature Research: Responsive UI Adaptation

## Table Stakes

- Unified breakpoint model: `phone < 640`, `tablet 640-1023`, `desktop >= 1024`.
- Compact behavior model: `compact < 1024`, `desktop >= 1024`.
- Root layout datasets for form factor, sidebar mode, density, shell mode, and input mode.
- Mobile/touch navigation through Sheet/Drawer with focus-safe open/close behavior.
- Desktop navigation remains docked and preserves titlebar/window behavior.
- Token-driven page gutters, content widths, composer widths, safe-area offsets, and touch target sizes.
- Mobile-safe thread canvas with visible composer, safe-area padding, and reduced desktop header noise.
- Mobile-safe settings panel with dense tables/cards degraded to single-column touch-friendly layouts.
- Automated tests for breakpoint boundaries, policy scenarios, and source-level structural contracts.
- Manual viewport checks for mobile, tablet portrait/landscape, and desktop minimum window.

## Differentiators

- Tablet can become a first-class middle state instead of being treated as either phone or desktop.
- Layout policy can eventually support tablet landscape rail mode without rewriting the shell.
- CSS token/state approach makes future pages inherit responsive behavior by default.

## Anti-Features

- Separate mobile UI files that duplicate shell/content components.
- Component-local `matchMedia` checks scattered across pages.
- Hard-coded per-page width and safe-area values.
- Desktop status/action chrome copied directly into mobile topbars.
- Complex animation used to mask layout problems.

## Dependencies

- Responsive environment module must exist before AppChrome and page content can consume policy.
- CSS token/dataset work should land before ThreadCanvas and SettingsPanel spacing changes.
- Shell behavior should be stable before final touch target and manual viewport validation.
