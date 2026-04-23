# Architecture Research: Responsive Shell

## Existing Entry Chain

`src/main.tsx` mounts `src/App.tsx`, which composes `AppChrome`. `AppChrome` owns the shell layout, `Sidebar` rendering mode, titlebar/window integration, and the main content region. `ThreadCanvas` and `SettingsPanel` are lazy-loaded content surfaces.

## Proposed Architecture

1. `responsive-env` reads viewport and input facts and returns stable environment state.
2. `app-layout-policy` maps environment, current mode, platform, and sidebar state into layout decisions.
3. `App.tsx` owns semantically distinct sidebar states: mobile drawer open and desktop/sidebar collapsed.
4. `AppChrome` consumes policy and sets root data attributes.
5. `app.css` maps datasets to tokens.
6. `Sidebar`, `ThreadCanvas`, and `SettingsPanel` consume tokens and policy-driven props rather than defining new breakpoints.

## Core Boundaries

| Boundary | Owns | Must Not Own |
|----------|------|--------------|
| `responsive-env` | Raw form factor, compact flag, pointer/input facts | Product mode or sidebar decisions |
| `app-layout-policy` | Sidebar mode, density, shell/titlebar behavior, content sizing hints | DOM rendering details |
| `App.tsx` | Product mode and durable UI state | Viewport math |
| `AppChrome` | Shell composition and root datasets | Scattered breakpoint constants |
| `app.css` | Token values per dataset | Business decisions |
| Content components | Information hierarchy and content-specific layout | Global breakpoint policy |

## Build Order

1. Baseline and tests for existing shell.
2. Responsive environment and layout policy modules.
3. Root datasets and token mapping.
4. App/sidebar state split and AppChrome shell modes.
5. ThreadCanvas and SettingsPanel responsive cleanup.
6. Touch target cleanup and final validation.

## Data Flow

Viewport/input facts -> responsive environment -> layout policy -> AppChrome datasets/props -> CSS tokens -> shell/content presentation.

This keeps mobile adaptation state observable, testable, and reusable without forking pages.
