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
