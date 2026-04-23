# Stack Research: study-ui Mobile Adaptation

## Current Stack

| Layer | Choice | Evidence | Guidance |
|-------|--------|----------|----------|
| UI runtime | React 19.2.4 | `package.json` | Keep current runtime; do not introduce a new app framework. |
| Build | Vite 7.3.1 | `package.json` | Keep Vite; existing scripts already support dev/build/preview. |
| Language | TypeScript 5.9.3 | `package.json` | Add typed responsive and layout policy modules. |
| Styling | Tailwind CSS 4.1.12 + CSS variables | `package.json`, `src/styles/app.css` | Continue token-driven styling; avoid CSS-in-JS. |
| Primitives | Radix UI + shadcn-style components | `package.json`, `src/components/ui` | Reuse `Sheet`, `Dialog`, `Tabs`, `Switch`, `Button`, `Textarea`. |
| Icons | `@phosphor-icons/react` | `package.json`, `AGENTS.md` | Keep Phosphor only. |
| Desktop shell | Tauri 2.7.0 | `package.json`, `src-tauri` | Preserve desktop window behavior while adapting WebView layout. |

## Recommended Additions

- Add `src/lib/responsive-env.ts` for viewport and input facts.
- Add `src/lib/app-layout-policy.ts` for layout decisions derived from environment and mode.
- Add tests near these modules using Node's built-in test runner with `--experimental-strip-types`.
- Add minimal CSS tokens to `src/styles/app.css` rather than introducing a separate responsive design system.

## Do Not Add

- No Next.js migration.
- No Emotion, styled-components, Ant Design, MUI, or additional component libraries.
- No third-party responsive utility package.
- No separate mobile route/app shell.

## Confidence

High. The stack is explicitly locked in `AGENTS.md` and `package.json`, and the requested migration can be implemented within existing dependencies.
