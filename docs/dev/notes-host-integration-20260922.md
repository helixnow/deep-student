# Notes host integration

The shared `NotesCrepeEditor` now registers every mounted instance with
`noteHostCoordinator`, including Learning Hub and Workbench instances. Its base
Crepe API receives the block service; consumers receive the full-document API.
`NoteContentView.refreshDocumentFromDisk` installs both content and the OCC
baseline. Failed refresh keeps the instance read-only and prevents stale saves,
with a user-visible retry action. Successful refresh resets local undo.

Operations freeze interaction, cancel queued/debounced saves, drain in-flight
saves and compare complete drafts before writing. Divergent drafts for one note
stop the operation. Identical drafts save once and refresh sibling instances.
History uses `withOverwrite` to hold the same lock through `beforeOverwrite`,
backend CAS and awaited `onRestoredCurrent`, including dialog closure during IPC.

Block links use authoritative Markdown root IDs, route through `DSTU_OPEN_NOTE`
with `source: 'notes-editor'`, then materialize and focus the destination. The
page menu provides full-document loading for windowed block operations, plus
plain Markdown and layout-preserving export. Columns require explicit consent,
`notes_enable_columns`, a confirmed format grant and capability-aware saves.

AI review receives official diff props, full Markdown UTF-16 scope resolution,
the editor's review/upload lease and `notes_review_save_as`. Save-as uses top-level
camelCase arguments and preserves the returned `updatedAt` token on the savedAs
snapshot in review persistence. Recovery never substitutes a newer disk token.
Failed drafts use independent `note_state` rows with `type: 'draft'` and CAS.
Hydration offers recovery candidates without replacing live edits; candidates can
be copied, restored, saved as another note or discarded with CAS.

Accepted AI groups now call the host's `applyDocument`: freeze/flush all source
participants, validate the complete baseline, persist via leased `notes_update`,
then refresh before returning the applied editor snapshot. Save-as freezes both
source and an existing review copy; its original saved-copy CAS token remains
the precondition. Ordinary autosave never borrows the operation token.

## Cross-WebView lease integration

Tauri editors register participants bound to their actual WebView label, renew
them every 15 seconds, and unregister on unmount. Registration is deduplicated;
an IPC response arriving after unmount is immediately unregistered.

`notes_editor_begin` fences the complete note set. Each editor freezes and ACKs
its complete Markdown plus `getStorageUpdatedAt()` from its installed baseline.
It must not substitute a newly read disk token for a stale editor baseline.
The owner waits for `ready`, then `notes_editor_flush` persists agreed drafts,
including drafts visible only in another WebView. Unopened scoped notes are a
no-op. Repeated flushes do not advance the revision token.

Transfer, history and format writes carry the owner token. Normal autosaves do
not inherit that token and remain fenced. Authorized multi-step writes advance
the backend's agreed baseline in the same transaction. `notes_editor_finish`
explicitly switches to `refreshing` after the operation's writes, rather than
after its first format migration. All mounted participants install the new
baseline before refresh ACK; the owner waits for every ACK before release.
Events are broadcast through the application handle. Failed refresh retains
invalidation after temporary interaction locks are released.

Verification: seven Rust lease tests pass; five frontend protocol tests cover
two independent coordinators, remote-only drafts, stale baseline rejection,
unmount during registration, refresh failure and late registration. These use
mocked IPC/event delivery; real multi-WebView desktop acceptance is still due.

The real Crepe host integration tests also cover template insertion after focus
leaves the editor. Selection boundaries are explicitly extracted from
ProseMirror getters before passing a plain range to the Markdown scope mapper.

## Verification checkpoint

- Notes/Crepe regression: 900 tests passed; the separate stylesheet suite passed
  its 3 tests after fixing file resolution under Vitest's HTTP `import.meta.url`.
- Standard `tsc` required an explicit schema tuple return type that native `tsgo`
  had inferred differently. Both typecheck paths now pass at this checkpoint.
- Migration static gate: all 127 migrations pass.
- Production build passed with `NODE_OPTIONS=--max-old-space-size=8192`; the
  default 4 GB Node heap ran out of memory. Third-party notices regenerated for
  the changed Cargo dependency lock (2011 components).
- The development desktop was subsequently opened successfully via
  `npm run tauri dev`; Computer Use must target `deep-student`, not the installed
  application's bundle identifier. The real Notes workspace was displayed.
  Cross-WebView acceptance and the full desktop workflow remain incomplete.

## Chrome cleanup and latest verification boundary

- Files: back/forward, one labelled New menu (note / learning note / folder /
  mind map), and a More menu for library actions at every window size. The Files
  heading is no longer hidden to make room for a clipped strip of icons.
- Document chrome: four frequent formatting buttons plus a labelled Format
  menu; Read/Edit and Page are labelled controls. Page groups note tools, view
  actions and plain/layout-preserving export. Cards move out of the formatting
  toolbar; touch editing retains its existing bottom-toolbar entrance.
- Selection bubble: inline text actions only. The six layout commands remain
  available in labelled format/slash/block menus rather than identical icons in
  the selection bubble. Both locale files include the new chrome labels.
- Code review covered focus entry/return, disabled-item keyboard navigation,
  closing-state focusability, touch target allocation and shell-width-based
  suppression of the duplicate desktop formatting toolbar.
- Before the user requested code-only work, the native typecheck passed and a
  focused run reported 98/101 passing: three host cases still searched for the
  old directly visible template entrance / mismatched mocked translation label.
  Their selectors were updated to enter through Page with the same translation
  fallback as production. **No rerun, build or UI verification followed the
  user's instruction to stop testing.** Later chrome changes are code-reviewed
  only; earlier build/test results are not final acceptance for this revision.

## Follow-up frontend code review

Code-only review covered shared Workbench sidebars and titlebar consumers
(Notes, Chat, Files and Todo), Popover/DsDialog/focus-trap behavior, note creation
and relation forms, mobile editor chrome and the PDF/question preview route.

- Notes tabs now subtract the titlebar slot's existing traffic-light inset from
  the shared sidebar width. The overflow list focuses its selected item, supports
  arrow/Home/End navigation and restores focus on Escape; its touch slot reserves
  real horizontal space instead of overlapping the last tab with negative margins.
- Collapsed sidebars and closing drawers/popovers are inert. Drawer Escape runs
  after inner handlers, ignores IME cancellation, and only responds to its own
  DOM subtree. Portal buttons are not treated as drawer navigation clicks.
- Focus traps exclude negative-tabindex controls, disabled fieldset descendants
  and inert/hidden subtrees. Shared Popover Escape respects consumed events and
  preserves editor focus; dialog-owned popovers remain within the overlay focus
  scope and above the dialog content.
- Finder breadcrumbs occupy the space between controls instead of an overlapping
  absolute layer. Search can shrink, and the collapsed-ancestor button labels the
  ancestor it actually opens.
- Learning-note creation and relation previews use DsDialog for focus, Escape,
  Android back, overlay layering and mobile keyboard handling. Creation remains
  non-dismissible while its existing save operation is busy.
- Relation editing clears stale labels/drafts when switching, cancelling or
  deleting the edited relation. Failed picker loads clear pagination availability.
  Preview loading resets previous content and has an explicit loading state.
- Relation PDF/question navigation carries a reader-instance scope through
  UnifiedAppPanel to the actual listeners, preventing a second reader of the same
  resource from consuming the preview's request.
- Collapsed mobile toolbar controls are inert; menu Escape respects IME state.
  Unsupported-format source-view controls now have Chinese and English strings.

No tests, typechecks, builds or UI interactions were run for this follow-up, per
the user's code-only instruction. Layout, focus and multi-reader behavior have
been reviewed statically, not accepted through a runtime exercise.

## Notes UI/UX follow-up: forms, search and narrow panes

The next code-only pass confirmed and addressed these reachable UI issues:

- The Properties/Links/Graph conditional unmounted the learning-property and
  relation forms on every tab switch. The property panel now stays mounted while
  another tab is selected, with native `hidden` removing it from layout and the
  focus order. Tab buttons use roving tabindex, ArrowLeft/ArrowRight/Home/End and
  explicit tab/panel IDs. Escape respects consumed events, IME input, native
  selects and portalled previews.
- The full-height context panel and its relation-form sibling lived inside an
  overflow-hidden property page. The property page now scrolls as a whole;
  context content uses natural height and the outline keeps a bounded inner
  scroll area. Touch property actions use real 44px targets, with stacked rows
  and a two-row add form to preserve input space.
- Learning properties show unsaved/saving/saved feedback. Custom-property inputs
  are disabled during their pending save, so a successful earlier submission
  cannot clear text typed while it was in flight. Their keyboard handlers also
  ignore IME confirmation/cancellation.
- Find/Replace uses an editor-pane container query rather than viewport width.
  Narrow panes separate the query/close controls, options/navigation and status;
  replacement controls wrap below the input. Escape works throughout the panel,
  and its exit-animation controls are inert.
- A failed search-result open no longer replaces the result list: the inline
  error leaves rows available for retry. Opening has an explicit status. Outside
  clicks and successful opens do not restore focus to an obsolete origin, and
  clearing the query returns focus to the search input. Exit controls are inert.
- Template-panel Escape respects IME/consumed events, and closing controls are
  inert. Learning-view empty states distinguish an empty mastery group from no
  upcoming reviews. Course/chapter labels wrap in narrow rows. Mobile toolbar
  height is observed across reflow so the editor's bottom inset follows resizing.
- Added matching Chinese/English strings for property-save feedback, learning
  empty states and search-result opening.

Review boundaries and remaining design questions:

- Draft retention above covers information-tab switches. Closing the whole panel
  or changing the note still unmounts its property form; draft persistence across
  those transitions needs a separate lifecycle decision.
- Search is intentionally non-modal (no backdrop); allowing Tab to reach the
  workspace is consistent with that contract. No modal focus trap was added.
- Document statistics already expose all values through the focusable trigger's
  accessible label and show their visual details on focus-within.
- Quick template application and personal-template editing still share a panel.
  Separating these entry points remains an information-architecture improvement.
- Actual narrow/touch geometry, keyboard-visible toolbar height and WebView focus
  behavior remain unverified: the review pass itself was source/diff only, and the
  focused checks added below do not exercise layout or focus at runtime.

### Pre-publish checks (run before committing this revision)

The code-only rule was lifted when the user asked for a commit and a new release
build. These focused checks were then run locally against the working revision:

- `tsc --noEmit -p tsconfig.json` and `tsgo --noEmit -p tsconfig.json`: pass.
- `eslint` over every changed TS/TSX file: 0 errors (remaining warnings are the
  pre-existing `no-native-button` advisories).
- Vitest on the directly affected suites: `NoteLearningPropsFields`,
  `NoteCustomPropsEditor`, `NotesBacklinksPanel`, `NotesSearchOverlay`,
  `NotesWorkspaceApp`, `FindReplacePanel`, `MobileEditorToolbar` — 143 passed;
  plus `NotesMetadata.keyboard`, `noteAppearance`, `fullDocument.host`,
  `NoteLearningPersistence` — 39 passed.
- The first run failed one existing `FindReplacePanel` case because the closing
  panel had been marked `aria-hidden`, which removed the search landmark from
  role queries during the exit animation. Exit is now `inert` only: focus entry is
  still blocked while the panel animates out, and the landmark stays queryable.
- Chinese and English locale files are key-identical for the `notes` and
  `workbench` namespaces, and every key added here exists in both languages.
- Still unverified: real CI (tsgo/tsc, full Vitest shards, Rust gates, production
  build) has not run on this revision, and no runtime UI or multi-WebView exercise
  was performed. Full-suite and desktop acceptance remain due.
