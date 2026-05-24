# Visual Regression Tests

Manual visual regression testing for CSS migration.

## Usage

1. Start dev server: `pnpm dev`
2. Capture baseline: `npx playwright test -c tests/visual/playwright.config.ts`
3. Make CSS changes
4. Re-capture: `npx playwright test -c tests/visual/playwright.config.ts`
5. Compare screenshots in `tests/visual/screenshots/`

## Extending

To capture additional views, add tests that navigate via the sidebar or dispatch navigation events.
The app uses custom view switching (not URL routing).
