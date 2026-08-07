# ACR 2.0 Tauri interactive test record

## Run metadata

- App: Deep Student 0.9.42
- Repo: `/Volumes/cipan/deep-student`
- Branch / commit: `dstu/from-nightly` / `2b8f31f339`
- Date: 2026-07-12 19:29-22:06 CST
- Tester: Codex (Tauri visual inspection + macOS accessibility state)
- Launch command: `npm run tauri dev`
- OS: macOS 26.0.1 (25A362)
- Pre-launch worktree: dirty, 94 status entries; includes existing user work and ACR changes
- Notes: no `tauri-lab`; the development process must remain running after verification

## Surface notes

- The current-repo debug executable was verified under `src-tauri/target/debug/deep-student` and launched only with `npm run tauri dev`.
- Codex Computer Use could not bind to the bare debug executable reliably: the shared `com.deepstudent.app` bundle id was ambiguous with an installed release, and the temporary distinct wrapper was redirected by the app's single-instance lock.
- The in-app Browser fallback reached `http://localhost:1422`, but the standalone page remained at `Loading...` because it has no Tauri `invoke` or event bridge. Browser-only rendering is therefore not a valid substitute for this desktop UI.
- Read-only macOS accessibility state and screenshots of the current debug process were used for the safe visual checks below. No prompt was sent and no destructive, paid, credential, upload or external action was performed.

## Feature map

| Area | Entry point | Visible capabilities | Gated or risky actions | Notes |
| --- | --- | --- | --- | --- |
| Startup | Tauri dev window | Workbench desktop and Dock | None | Verify current repo debug build |
| Discovery | Permanent Robot Dock item | Mode status, capability list, Chat/settings actions | None | One-time marker uses local storage |
| Control mode | Discovery popover segmented control | Off, background, follow | Persists a local setting | Harmless configuration change |
| Chat | Open Chat button | Opens/focuses Chat input | Sending a prompt is out of scope | Navigation only |
| Settings | Control settings button | Control mode and capability summary | Other settings are out of scope | Navigation only |
| Layout | Discovery popover | Scrollable bounded content | None | Check clipping and overlap |

## Checklist

| ID | Area | Scenario | Steps | Expected | Status | Evidence / notes |
| --- | --- | --- | --- | --- | --- | --- |
| START-01 | Startup | Launch current dev build | Run configured command and inspect app identity | Deep Student opens with meaningful content and no blocking error | Pass | Debug binary launched, migrations completed with no pending migration, and Workbench content rendered. |
| DISC-01 | Discovery | Find ACR without knowing its internal name | Inspect Workbench Dock | Permanent AI desktop control entry is visible and labeled | Pass | Robot entry remained at the right end of the floating Dock; accessibility label reported `AI 桌面操控，当前：跟随`. |
| DISC-02 | Discovery | Understand supported capabilities | Open Robot popover | Concrete app/action summary and safety boundary are readable | Pass | The redesigned default view shows three scannable capability groups and the safety boundary; `全部能力` expands to all eight app-level details. |
| MODE-01 | Control mode | Change mode | Select a different segment and inspect status | Segment, badge and Dock dot update without closing popover | Pass | Selecting `后台` changed the selected segment, badge, description and Dock status dot to the background state. |
| MODE-02 | Control mode | Restore original mode | Select the original segment | Setting returns to its initial value | Pass | Accessibility state after restoration: `关闭=0`, `后台=0`, `跟随=1`; trigger label returned to `当前：跟随`. |
| NAV-01 | Chat | Open Chat from capability center | Click Open Chat | Chat window opens/focuses; no message is sent | Pass | `新对话` opened with the empty input focused; no text was entered or submitted. |
| NAV-02 | Settings | Open control settings | Reopen popover, click Control settings | Settings opens on the control section with capability summary | Blocked | Accessibility press succeeded, but the prior dev session exited before a safe visual assertion. Component routing is covered by the passing unit test; desktop visual confirmation remains outstanding. |
| PANEL-01 | Layout | Close and reopen popover | Open, close, reopen using trigger | Panel state is stable and focus remains usable | Blocked | Open and post-HMR reopen passed; a complete close/focus-return cycle was not asserted before the prior dev session exited. |
| LAYOUT-01 | Layout | Inspect fit and overlap | Review compact and expanded popover at current window size | Text fits, actions remain reachable, no incoherent overlap | Pass after fix | Compact view fits in one scan. Expanded details re-anchor upward, scroll only inside the panel, and keep `打开 Chat` plus settings visible above the Dock. |

## Issues

| Issue ID | Severity | Area | Title | Repro steps | Expected | Actual | Evidence | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ACR-UI-001 | Medium | Discovery popover | Action row overlapped the floating Dock | Open Robot popover in a 1200 x 750 window | Action buttons remain fully visible and reachable | The Dock covered the lower part of `打开 Chat` / `操控设置` | Tauri visual inspection at 1200 x 750 | Fixed and retested |
| ACR-UI-002 | Medium | Discovery popover | Long settings-style table did not match Workbench | Open the original Robot popover | A lightweight Dock control center with clear hierarchy | Eight dense rows made the flyout read like a full settings page | User screenshot and Tauri visual inspection | Redesigned and retested |
| ACR-UI-003 | Medium | Shared Popover | Expanded content kept the collapsed anchor position | Expand `全部能力` | Flyout repositions when its content size changes | The list grew downward behind the Dock | Tauri visual inspection plus ResizeObserver regression test | Fixed and retested |

## Confirmation-required items

| ID | Action | Why confirmation is required | Last safe step reached | Status |
| --- | --- | --- | --- | --- |
| None | No destructive, external, paid, upload, delete, credential or message-send actions are in this run | Not applicable | Not applicable | Not applicable |

## Focused regression

- ACR control center, settings integration, and shared Popover positioning: 17/17 focused tests passed.
- `src/features/workbench/components/__tests__/AgentControlCenter.test.tsx`: compact summary, eight-item expansion, mode switching, and navigation actions covered.
- `src/components/ui/shad/Popover.overlayCoordinator.test.tsx`: content resize now recomputes the top anchor.
- The original `follow` mode was restored before the safe interaction run ended.
- Development app remains running through `npm run tauri dev`; Vite is available at `http://localhost:1422`, but the URL alone is not a functional non-Tauri build.
