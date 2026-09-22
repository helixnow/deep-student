# WP08 frontend integration

Implemented files are under `plugins/blockIdentity/`, `blockTransfer/` and the agreed Crepe editor/menu/type files. No NotesCrepeEditor, NoteContentView, fullDocument, aiReview, backend or locale changes are part of this work.

## Host wiring (main agent)

Bind **the live base Crepe API** after attaching the Notes full-document and save lifecycle:

```ts
import { createBlockTransferCodec, createBlockTransferService } from '@/components/crepe/blockTransfer/service';

const service = createBlockTransferService(transferHost, createBlockTransferCodec(api.getCrepe()!.editor.ctx));
api.configureBlockActions?.({
  getFullMarkdown: () => fullApi.getFullDocument().markdown,
  isDocumentWindowed: () => fullApi.isDocumentWindowed?.() ?? false,
  flushPendingSave: () => fullApi.flushPendingSave!(),
  transferService: service,
});
// Needed when an upgraded note is empty (its Markdown has no IDs to infer mode from):
api.setBlockIdentityMode?.(format.content_format === 'markdown-blocks');
```

Use a service tied to the current mounted schema/context; recreate it when that editor is destroyed. `CrepeBlockActionsHost` is exported from `crepe/types.ts` (direct import). Keep the same service instance while a move dialog is open so retries retain the exact prepared request.

`BlockTransferHost` is a required, typed adapter, not an unsafe disk-write fallback:

- `listNotes()` returns `{id,title,path}`; the dialog shows path and ID to distinguish equal titles.
- `withLockedNotes(ids, task)` holds both notes' editing/save lifecycles through flush, reads, backend commit and refresh. It must coordinate **all open drafts** for those note IDs, including inactive tabs/windows represented by the host. `task` runs while the lock is held. Do not implement this as `task()` without draft coordination.
- `flushPendingSaves(ids)` must sample the current live editor (including the debounced onChange window), compose the complete document, persist it, and reject on save failure.
- `readNote(id)` returns the complete `{noteId,content,updatedAt}` saved snapshot, with the backend's exact `updated_at` string.
- `invalidateNotes(ids)` synchronously invalidates pre-commit save tokens. Keep those drafts blocked if refresh fails; unlocking the operation must not re-enable an obsolete autosave.
- `refreshNotes(ids)` reloads every affected open draft, updates canonical/full-document and OCC baselines, clears old local ProseMirror undo history, and unblocks only successfully reconciled drafts. If a base editor is remounted, bind this API again.

The real desktop and mobile block menu has `copy-block-link` and `move-to-note`. Top-level duplicate also uses the bound service to upgrade an old note before assigning copy IDs. Nested duplicate/move retain existing local behavior, without claiming a persistent nested address. Nested link/move entries explain that only root blocks are supported.

For a windowed note the actions currently refuse with an explicit full-document message. The main agent can materialize the entire note before opening/reopening the menu. Never pass a visible prefix as the full authority. Block selection is snapshot-checked, and duplicate re-captures the upgraded selection by ID.

## Explicit upgrade and Markdown authority

`planBlockIdentityUpgrade(markdown, codec)` preflights the complete Markdown with the actual schema and inserts only `<!-- ds:block-id=ID -->` lines before root nodes. Removing those inserted lines recovers the exact original bytes, including CRLF. It never canonicalizes the saved legacy body. Unknown/lossy source, raw root HTML other than an empty `<br>`, and reference-definition roots refuse the upgrade.

`service.ensureIdentities(noteId, expectedMarkdown)` locks/flushes, checks the complete expected draft, obtains format metadata and calls `notes_migrate_blocks` only on explicit user action. It returns the root IDs in order. Opening/rendering a legacy note does not invoke it. The menu preflights both the original editor input and the full live draft before any upgrade (so syntax already lost by an initial parse cannot be silently blessed).

After a note has been explicitly upgraded, user-created root blocks receive IDs; duplicate and paste re-key identified copies, while same-page and cross-page moves preserve IDs. Native clipboard paste into a legacy document strips incoming IDs and leaves the content unaddressed until an explicit whole-note upgrade; it must not bypass backend migration or bless an unknown suffix. The real root Duplicate menu uses the bound service to upgrade first. The editor's synthetic unpersisted final empty paragraph is omitted from the identity envelope. Identified empty paragraphs serialize as `<br />`. Markdown carries all IDs; the PM attrs and runtime format-mode boolean are not another document store.

The low-level `ensureRootBlockIds` command is for a standalone complete editor. Notes hosts use `service.ensureIdentities` so the backend migration/format gate and baseline history are honored.

## Block link routing

Links are `[label](ds-block://note/ENCODED_NOTE_ID#BLOCK_ID)`. The plugin intercepts actual anchor clicks and emits `notes:block-link-open` with `{noteId,blockId}`. Install the provided bridge once in the owning note/navigation host:

```ts
import { installBlockLinkBridge, resolveBlockLinkOwner } from '@/components/crepe/plugins/blockIdentity/links';

const dispose = installBlockLinkBridge({
  resolveTarget: target => resolveBlockLinkOwner(target, {
    readMarkdown: readCompleteNoteMarkdownOrNull,
    listNoteIds: listNonDeletedNoteIds,
    parse: markdown => currentRemark.parse(markdown), // raw root AST, not runSync
  }),
  openNote: async noteId => {
    const api = await openAndMaterializeNoteAndWaitForEditor(noteId);
    return { focusBlock: id => api.focusBlock!(id) };
  },
  onMissing: target => showMissingBlock(target),
  onError: error => showNavigationError(error),
});
```

The source note in a link is a hint. After a cross-page move, `resolveBlockLinkOwner` can find the current owner from complete Markdown; a backend authoritative index can replace this scan. It excludes fenced/nested lookalike markers by reading root AST nodes, rejects ambiguous fallback matches and reports deleted blocks. No fallback to similarly titled notes or headings. Bridge cleanup cancels pending focus work and removes the listener. The host's open routine must coordinate navigation itself if concurrent open calls are possible.

## Backend IPC (verified against current Rust declarations)

- `notes_get_format({noteId})` → `{content_format,format_version,serializer_version,...}`.
- `notes_migrate_blocks({noteId,expectedUpdatedAt,content})` → VfsNote. v1 is `markdown-blocks` / `blocks-v1`; legacy is `markdown-legacy` / `markdown-v1`.
- `notes_transfer_blocks({request})`, where **nested request fields are snake_case**: `operation_id`, `source_note_id`, `target_note_id`, `expected_source_updated_at`, `expected_target_updated_at`, `source_content`, `target_content`, `block_ids`.
- `notes_undo_transfer({operationId,expectedSourceUpdatedAt,expectedTargetUpdatedAt})` uses **camelCase outer Tauri args**.
- Both transfer commands return snake_case `operation_id`, `source_note_id`, `target_note_id`, `source_updated_at`, `target_updated_at`, `source_version_id`, `target_version_id`, `undone`.

The service upgrades a legacy target under the same draft lock before transfer. It preserves all unselected original bytes and appends selected blocks in source order. Failures never optimistically remove blocks. Transport retries reuse the exact prepared request/operation ID, including after an ambiguous commit. Undo always submits the move's committed revisions, so later edits cause an OCC conflict rather than being overwritten. Successful persistence plus failed refresh is shown as committed-with-refresh-error; invalidated drafts must remain blocked until reloaded.

Backend owns format version gating, import collision rejection, transaction atomicity, operation logs and undo conflicts. Frontend rejects duplicate root IDs and source/target collisions before transfer; it does not implement a second backend database/index.

## Validation

New real Crepe tests cover root attrs/remark roundtrip (including list, table, code, toggle, callout), explicit upgrade, no legacy ID generation on open, unknown/full-document preflight, copy/move/reopen/delete IDs and clipboard metadata. Service tests cover exact byte-preserving migration, request contract, open-draft flush ordering, failures, retry, and Undo. UI tests cover same-name target paths, move/error/retry and Undo; link tests cover actual clicks, moved routing and deletion.

The main agent still needs to bind the Notes lifecycle/navigation adapter above and perform the desktop end-to-end check using `npm run tauri dev`. No demo page is used for validation.

## Editor integration API (toggle, columns, commands and review)

The live API in `crepe/types.ts` additionally exposes:

```ts
interface CrepeDocumentCapabilities {
  noteId: string;
  writable: boolean;
  capabilities: readonly string[];
}

api.setDocumentCapabilities?.(grantOrNull);
api.getPlainMarkdown?.();
const releaseReview = api.acquireReviewLease?.();
const uploads = api.getUploadState?.(); // { pending, running, failed, reviewLeases }
const unsubscribe = api.subscribeCommandState?.(refreshControls);
const available = api.canExecuteCommand?.('convert-columns');
const changed = await api.executeCommand?.('convert-columns');
api.insertImageFromDevice?.();
```

### Per-page columns grant

Columns are always registered for reading. Writing is closed until the current
note has a backend-confirmed `writable: true` grant containing `ds-columns-v1`.
Pass the backend's result to `setDocumentCapabilities` after loading the page;
clear it when the page becomes unwritable. Grants for another `noteId` are ignored,
and editor initialization clears any previous grant. Do not infer this capability
from Markdown or set it to a constant `true`.

Add the optional callback to the existing `configureBlockActions` host:

```ts
requestLayoutCapability: async (): Promise<CrepeDocumentCapabilities | null> => {
  // Host: materialize the complete live document, opt in through the backend,
  // reconcile format/OCC/draft state, then return its current-page capabilities.
  return confirmedGrant; // null means declined/unavailable
}
```

The callback is invoked only for an explicit layout action. `canExecuteCommand`
preflights the actual layout command in a disposable state with a prospective
grant; it does not call the host or enable writes. Execution checks the resulting
grant and current editor again. Rebinding/destroying the editor, starting review,
editing the document, or changing the cursor while authorization is pending
prevents the delayed action. An identity-only migration may preserve the intended
target after recapture. Errors propagate to the command caller; supplied menu
bridges display them. Binding/unbinding the host also notifies subscribed controls.

`getPlainMarkdown()` serializes the **currently loaded editor document** with
columns flattened in reading order and block IDs removed. A windowed Notes host
must materialize the full document before invoking it. The persisted Markdown
retains both columns envelopes and IDs; plain export is never an autosave source.

### Shared command entry points

`commandRegistry.ts` exports `CrepeCommandId`, `CrepeCommandRequest`,
`canExecuteCrepeCommand(view,id,request)`, `runCrepeCommand(view,id,request)`
(synchronous, requires an established grant), and
`executeCrepeCommand(view,id,request)` (awaits explicit layout authorization).
`crepeExecuteCommand` registers the synchronous entry as Milkdown `DsCrepeExecute`.
Top toolbar, bubble, block menu, mobile and slash entries share this registry and
the same readonly/review/schema/target checks. UI code should use the async API
for actions that may request a layout capability. Use `subscribeCommandState`
to refresh availability after selection, document, capability or review changes.

`CrepeCommandRequest` accepts `target?: BlockTarget`, `toggle?: boolean`,
`slash?: boolean`, `href?: string`, `text?: string`, `src?: string`, and
`alt?: string`. Slash removal and insertion form one undo operation. The registry
uses native Milkdown commands for marks/table/math rather than reproducing their
business logic. Block math is a `code_block` with language `LaTeX`.

Layout actions are `insert-columns`, `insert-cornell`, `convert-columns`,
`convert-cornell`, `convert-cornell-template`, and `unwrap-columns`. Replacing root
blocks preserves the first root ID on the first replacement root. Other resulting
roots receive new IDs in an upgraded document; merged-away roots lose their old
addresses. A columns envelope has one outer stable ID and one complete transfer
source span. Nested blocks do not acquire persistent addresses.

### Formal toggle targets and cross-container moves

The editor constructs `toggle(toggleTitle, toggleBody)` through `createToggleNode`;
it never writes a title attribute. Title/structural-wrapper targets resolve to the
outer toggle; ordinary blocks inside the body retain their nested targets.
Converting a toggle to paragraphs calls the toggle plugin's official unwrap
command, retaining the first outer identity.

`prepareCrepeBlockMove(view,target,insertPos)` returns a validated transaction or
`null`; `moveCrepeBlocks` dispatches that same operation. Moves use exact source
ranges, refill required empty containers, and reject self-containment or nested
columns. `resolveCrepeBlockDrop(view,target,{x,y})` returns
`{kind,pos,containerPos,rect,valid,reason?}` with `kind` equal to `before`, `after`
or `inside`. Both axes participate so adjacent columns are distinct destinations.
The drag hook displays that result and does not dispatch invalid drops.

### Review leases, uploads and canonical image parsing

Call `acquireReviewLease` for the duration of review and release in `finally`.
Leases are nested and their release functions are idempotent. They close the block
menu, cancel an active block drag, make the editable DOM inert, and block new user
commands/uploads. They do **not** set the editor readonly or cancel an upload
already in flight, so its mapped completion can still commit. `getUploadState`
provides counts for the host's review/save coordination. Explicit document
replacement still follows the existing upload cancellation lifecycle.

`canonicalDocumentPlugin` wraps `parserCtx` after `ParserReady`, before initial
editor state creation. Both the real parser and `normalizeMarkdown` reuse
`normalizeOfficialDiffDoc` to repair `image-block.caption` from null to an empty
string. Initial load, replacement, normalization and save/reparse therefore share
the same valid PM representation. Unknown/lossy Markdown still fails preflight;
in particular, upstream Crepe stores image ratio in Markdown's alt slot, so this
caption repair does not silently approve loss of meaningful textual alt content.

`editorIntegration.fullStack.test.ts` mounts real Crepe with toggle, block IDs,
columns, command menus and upload lifecycle together. It exercises capability
approval/denial and pending-action invalidation, structural targeting, block math,
slash undo, cross-container drops, image save/reparse and nested review leases.
