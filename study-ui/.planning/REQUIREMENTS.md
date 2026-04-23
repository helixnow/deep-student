# Requirements: study-ui Mobile Adaptation

**Defined:** 2026-04-23
**Core Value:** One shared UI architecture must feel usable on phone, tablet, and desktop while preserving the existing desktop Tauri shell behavior.

## v1 Requirements

### Responsive Policy

- [x] **RESP-01**: The app exposes a single responsive environment model that classifies `phone < 640`, `tablet 640-1023`, and `desktop >= 1024`.
- [x] **RESP-02**: The app exposes `isCompact` for widths below `1024` and uses it for the initial compact-vs-desktop interaction split.
- [x] **RESP-03**: Breakpoint boundary behavior is covered by tests for `639`, `640`, `767`, `768`, `1023`, and `1024` viewport widths.
- [x] **RESP-04**: App layout decisions are centralized in a layout policy that outputs at least `formFactor`, `isCompact`, `sidebarMode`, and `density`.

### Shell And Sidebar

- [x] **SHELL-01**: The shell root exposes stable datasets for form factor, sidebar mode, density, and related responsive state.
- [x] **SHELL-02**: Mobile drawer visibility and desktop/sidebar collapsed state are separate state concepts.
- [x] **SHELL-03**: Phone and compact tablet navigation uses the existing `Sheet`/Drawer sidebar rather than a docked desktop sidebar.
- [x] **SHELL-04**: Desktop navigation remains docked and preserves existing Tauri titlebar/window behavior.
- [x] **SHELL-05**: Compact navigation closes after a user selects a navigation item when appropriate.
- [x] **SHELL-06**: Mobile/tablet topbar avoids desktop-only status noise while keeping the core navigation and title actions available.

### Layout Tokens

- [x] **TOKN-01**: `src/styles/app.css` defines reusable layout tokens for page gutter, workspace width, composer width, sidebar width/mode, safe-area offsets, and touch target size.
- [x] **TOKN-02**: Root datasets override the same token names per form factor instead of introducing duplicate mobile/tablet token families.
- [x] **TOKN-03**: Components consume layout tokens for content width, gutters, composer placement, and safe-area spacing instead of repeating hard-coded responsive classes.

### Thread Canvas

- [x] **THRD-01**: `ThreadCanvas` uses `--workspace-max-width` and `--composer-max-width` rather than hard-coded `max-w-[44rem]`.
- [x] **THRD-02**: `ThreadCanvas` replaces desktop-first `px-4 md:px-8` spacing with token-driven inline and block spacing.
- [x] **THRD-03**: The composer consumes safe-area tokens so it remains visible and usable on mobile and tablet WebView surfaces.
- [x] **THRD-04**: The mobile composer prioritizes text input and send action while moving secondary actions into a touch-friendly layout.
- [x] **THRD-05**: Thread canvas source tests assert safe-area/token usage and prevent reintroducing desktop-only width hard-coding.

### Settings Panel

- [x] **SETT-01**: `SettingsPanel` remains one shared page and does not fork into a separate mobile settings page.
- [x] **SETT-02**: Dense settings grids and pseudo-tables degrade under desktop width into card or definition-list style layouts.
- [x] **SETT-03**: Tabs use equal-width or scrollable mobile-safe layouts depending on item count.
- [x] **SETT-04**: Switch settings are wrapped in rows or labels that make the full setting row touch-friendly.
- [x] **SETT-05**: Settings scroll padding and page gutters follow shell/layout tokens and safe-area values.
- [x] **SETT-06**: Settings tests assert small-screen single-column behavior and dense-region degradation.

### Controls And Verification

- [x] **CTRL-01**: Button, shell button, input, textarea, switch, and composer controls maintain at least `44px` touch targets on phone/tablet.
- [x] **CTRL-02**: Desktop controls can remain compact where appropriate without reducing phone/tablet hit targets.
- [x] **VERF-01**: `npm run lint` passes after implementation.
- [x] **VERF-02**: `npm run build` passes after implementation.
- [x] **VERF-03**: Targeted source/unit tests pass for responsive policy, shell, thread canvas, settings panel, and existing app-shell behavior.
- [x] **VERF-04**: Manual viewport checks cover `390x844`, `768x1024`, `834x1194`, `1024x768`, and `1280x800`.
- [x] **VERF-05**: Manual desktop checks confirm Windows/macOS titlebar, drag region, window controls, resize handles, and minimum window behavior are not regressed.

### Mobile Home Polish

- [x] **HOME-01**: Phone empty state uses a mobile landing composition with a full-bleed prompt strip, concise title/description, and one primary suggestion CTA.
- [x] **HOME-02**: Phone composer uses a single-line floating pill while preserving at least `44px` add/input/send touch targets and omitting recording controls.
- [x] **HOME-03**: Tablet and desktop keep the previously verified ThreadCanvas empty state and composer from `640px` upward.
- [x] **HOME-04**: Mobile home polish does not add upgrade, user-plus, account-growth, or other new product entry points.
- [x] **HOME-05**: Phone top-left chrome starts from the mobile edge, uses a single 44px menu affordance, and hides desktop title/update clutter.

## v2 Requirements

### Tablet Enhancements

- **TABL-01**: Tablet landscape can use a narrow rail/sidebar mode once compact drawer behavior is stable.
- **TABL-02**: Tablet orientation changes can preserve navigation state intelligently across portrait/landscape transitions.

### Keyboard And Device Signals

- **KEYB-01**: Mobile keyboard visibility can become an explicit environment signal when real-device validation requires finer composer behavior.
- **KEYB-02**: Pointer and hover capability can refine density beyond viewport width where beneficial.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Separate mobile app shell | Increases maintenance cost and conflicts with the chosen single-architecture strategy. |
| New UI component library | Existing Radix/shadcn primitives cover the required patterns. |
| CSS-in-JS migration | Project styling is token-driven Tailwind/CSS variables. |
| Product feature changes outside UI adaptation | Current milestone is responsive shell/content usability only. |
| Complex motion system | Structural layout and touch usability are the goal; animation must remain restrained. |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| RESP-01 | Phase 1 | Complete |
| RESP-02 | Phase 1 | Complete |
| RESP-03 | Phase 1 | Complete |
| RESP-04 | Phase 1 | Complete |
| SHELL-01 | Phase 2 | Complete |
| SHELL-02 | Phase 2 | Complete |
| SHELL-03 | Phase 3 | Complete |
| SHELL-04 | Phase 3 | Complete |
| SHELL-05 | Phase 3 | Complete |
| SHELL-06 | Phase 3 | Complete |
| TOKN-01 | Phase 2 | Complete |
| TOKN-02 | Phase 2 | Complete |
| TOKN-03 | Phase 4 | Complete |
| THRD-01 | Phase 4 | Complete |
| THRD-02 | Phase 4 | Complete |
| THRD-03 | Phase 4 | Complete |
| THRD-04 | Phase 4 | Complete |
| THRD-05 | Phase 4 | Complete |
| SETT-01 | Phase 4 | Complete |
| SETT-02 | Phase 4 | Complete |
| SETT-03 | Phase 4 | Complete |
| SETT-04 | Phase 4 | Complete |
| SETT-05 | Phase 4 | Complete |
| SETT-06 | Phase 4 | Complete |
| CTRL-01 | Phase 5 | Complete |
| CTRL-02 | Phase 5 | Complete |
| VERF-01 | Phase 5 | Complete |
| VERF-02 | Phase 5 | Complete |
| VERF-03 | Phase 5 | Complete |
| VERF-04 | Phase 5 | Complete |
| VERF-05 | Phase 5 | Complete (macOS observed; Windows N/A on local macOS host) |
| HOME-01 | Phase 6 | Complete |
| HOME-02 | Phase 6 | Complete |
| HOME-03 | Phase 6 | Complete |
| HOME-04 | Phase 6 | Complete |
| HOME-05 | Phase 6 | Complete |

**Coverage:**
- v1 requirements: 36 total
- Mapped to phases: 36
- Unmapped: 0

---
*Requirements defined: 2026-04-23*
*Last updated: 2026-04-23 after Phase 6 mobile top-left polish*
