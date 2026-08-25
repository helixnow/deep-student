# 0824 #160 leftover port

Date: 2026-08-25

- Isolation branch: `cursor/0824-leftover-160-cde6`
- Base: `origin/cursor/0824-rehearse-cloud-latest-cde6` @
  `2630dc95f5ea1bb1422ddedc7cc8eb8adcacd85b`
- Source inspected without merging: `refs/pull/160/head` @
  `7c1a50945`
- Disposition: **INCLUDE 4 / ALREADY 10 / DROP 0**

## Per-commit disposition

| Source SHA | Disposition | File-level evidence |
|---|---|---|
| `7c1a50945` | INCLUDE | Added `src/features/anki-tasks/__tests__/AnkiTasksApp.loadError.test.tsx`. It covers the existing `AnkiTasksApp.tsx` first-load alert/retry path and stale-data banner/retry path with real `zh-CN/anki.json` copy. |
| `89191388b` | INCLUDE | Added `tests/vitest/flashcards/todayScreenEmptyLibrary.test.tsx`. The existing `TodayScreen.emptyLibrary.test.tsx` covered only the empty-library branch; the port also locks non-empty/all-done and non-empty/nothing-due behavior against the current store API and current `today.goLibrary` CTA. |
| `eff6d54c2` | ALREADY | `src/components/practice/PracticeModeSelector.tsx` is absent; `src/components/practice/index.ts` and `PracticeLauncher.tsx` do not export/import it. The deleted component stays deleted. |
| `cf4f69ad5` | ALREADY | `src/stores/questionBankStore.ts` contains `practiceSession`, `ensurePracticeSession`, and `recordPracticeSessionAnswer`; `src/components/QuestionBankEditor.tsx` reads the store-backed streak/correct counts and records answered IDs. |
| `abb415e52` | INCLUDE | Moved `SchedulerSettingsSection` below the successful statistics panels in `src/features/flashcards/screens/StatisticsScreen.tsx`; the independent error branch still exposes settings. Added the ordering assertion to `tests/vitest/flashcards/StatisticsScreen.test.tsx`. |
| `7f9e7c0f3` | ALREADY | `src/features/pomodoro/components/GlobalPomodoroWidget.tsx` derives `hasVisibleWindowHost` from `useWindowStore` for non-minimized `pomodoro`/`todo` hosts and suppresses the pill; current mini-window/workbench arbitration remains intact. |
| `77e8a0fde` | ALREADY | `ReviewQuestionsView.tsx`, `EssayGradingWorkbench.tsx`, `GradingMain.tsx`, and `ResultPanel.tsx` expose missed-question/grading-result card generation; paired `review.json`/`essay_grading.json` locales exist. `src/features/anki/generateCardsFromText.ts` uses the required nonblocking `cardAgent.startGeneration` path and has no production `ChatV2AnkiAdapter`. |
| `514c9f142` | ALREADY | `LibraryScreen.tsx` exposes manual creation and `.apkg` import, while `store/libraryStore.ts` implements `createCard` and `importApkg` through `import_apkg_to_library`; the current library CSS and touch-target adaptations remain untouched. |
| `dc1d6cf09` | ALREADY | `src/features/anki-tasks/AnkiTasksApp.tsx` has `loadError`, `anki-tasks-load-error`, and `anki-tasks-stale-banner`; both `src/locales/{en-US,zh-CN}/anki.json` files contain `loadFailed`, `refreshFailedStale`, and `retry`. |
| `0a355d30d` | ALREADY | `TodayScreen.tsx` computes zero progress when the target is zero and separates `libraryEmpty`, `showDoneState`, and idle states. `flashcards-dashboard.css` retains the 44px coarse-pointer empty-state CTA rules, and both flashcard locale files contain the empty-library copy. |
| `8f08b3c9c` | ALREADY | `src/components/ui/buttonPrimitiveContract.ts` uses `text-ui` in button/shell bases and default/md sizes while retaining tokenized 44px touch geometry. |
| `bc392d54a` | ALREADY | `src/components/ErrorBoundary.tsx` calls `this.resetError` with `error_boundary.retry`; both common locale files define retry copy, and `tests/vitest/errorBoundaryCopy.test.tsx` contains the retry/remount contract. |
| `6fa9382aa` | ALREADY | `src/features/learning-hub/icons/ResourceIcons.tsx` routes palette, paper, fold, and folder colors through `--resource-icon-*` tokens with fallbacks. |
| `416f6fa44` | INCLUDE | The current tree already had failure-surface/resource-icon tokens and stronger variable-driven dark shadows (`failurePathSurfaceTokenContract.test.ts`, `darkShadowElevationContract.test.ts`), but `tailwind.config.js` still referenced undefined `--brand-secondary`/`--brand-accent`. Added light/dark definitions in `src/styles/theme-colors.css` and `tests/vitest/brandColorTokenContract.test.ts`. |

## Guard-rail audit

- No changes were made to the D flashcard write/read ownership paths.
- `src/features/anki/generateCardsFromText.ts` still calls
  `cardAgent.startGeneration`; no production `ChatV2AnkiAdapter` was added.
- No G safe-area or 44px rules were replaced. The scheduler change only moves
  an existing section, and the Today production/CSS files were not edited.
- `PracticeModeSelector` remains deleted.
- `cursor/0824-cde6` was not checked out or pushed.

## Verification

| Gate | Result |
|---|---|
| `npm ci` | PASS — 1,192 lockfile packages installed. |
| `npx vitest run src/features/anki-tasks/__tests__/AnkiTasksApp.loadError.test.tsx tests/vitest/flashcards/todayScreenEmptyLibrary.test.tsx tests/vitest/flashcards/StatisticsScreen.test.tsx tests/vitest/brandColorTokenContract.test.ts` | PASS — 4 files, 11 tests. |
| `npm run version:generate && npm run typecheck` | PASS — zero TypeScript errors. (`typecheck` alone initially reported the expected missing generated `src/version.ts`.) |
| `npx vite build` | PASS — 19,809 modules transformed; only existing circular/dynamic-import and chunk-size warnings. |
| `rustup run stable cargo check --manifest-path src-tauri/Cargo.toml --lib` | PASS with Rust/Cargo 1.98.0 after installing the CI Linux libraries and PDFium resource; 28 existing warnings. |

The VM default Cargo 1.83.0 cannot parse edition-2024 dependencies, so the
successful Rust gate used the repository/CI-compatible stable 1.98.0
toolchain. The PDFium downloader's tracked license-file rewrite was reverted;
no verification artifact remains in the Git diff.

## Absorption record (2026-08-25)

Official `cursor/0824-cde6` @ `188500e0` ("docs: record latest step 13 cloud
increment") already contains every INCLUDE item from this isolation branch.
The absorbing commits — both ancestors of `188500e0` — are:

- `f38d0041` "test(0824): port #160 load-error and today-progress regression
  tests"
- `41587d48` "feat(flashcards): move scheduler settings below statistics +
  brand token aliases (from #303 / #160 leftovers)"

Per-file status against official `188500e0`:

| Item | Absorbed | Evidence |
|---|---|---|
| `src/features/anki-tasks/__tests__/AnkiTasksApp.loadError.test.tsx` | Yes (`f38d0041`) | Present in official; identical assertions and coverage. Only cosmetic variance vs this branch (zh-CN vs English comments, line wrapping, test-name phrasing). Official's version supersedes. |
| `tests/vitest/flashcards/todayScreenEmptyLibrary.test.tsx` | Yes (`f38d0041`) | Present in official; identical assertions and coverage. Same cosmetic-only variance as above. |
| `StatisticsScreen` scheduler-below-stats | Yes (`41587d48`) | `src/features/flashcards/screens/StatisticsScreen.tsx` and the ordering assertion in `tests/vitest/flashcards/StatisticsScreen.test.tsx` ("places scheduler settings after the statistics panels") are byte-identical between official and this branch. |
| `brandColorTokenContract` / `theme-colors` brand aliases | Yes (`41587d48`) | `tests/vitest/brandColorTokenContract.test.ts` and the `--brand-secondary` / `--brand-accent` light+dark definitions in `src/styles/theme-colors.css` are byte-identical between official and this branch. |

Remaining unique content on this isolation branch vs official `0824`:

- The only file `0824` lacks is this document, `docs/dev/0824-leftover-160.md`
  — docs only. The two ported test files carry cosmetic comment/format
  differences that official's absorbed versions supersede; there is no
  product (`src/`, `src-tauri/`) diff that this branch would add.

Recommendation for the parent: close PR #303 as absorbed, or leave it open
purely as an absorbed-record — merging it would add no product or test
coverage beyond what `188500e0` already carries.
