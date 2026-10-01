# Notes storage IPC contract (V20260922)

All commands are registered in `lib.rs` and `application-commands.toml`. Top-level
Tauri arguments use camelCase; fields inside `request` and all new response
structs use snake_case. Exceptions: `notes_migrate_blocks` returns the existing
`VfsNote` shape (camelCase). Errors use AppError; CAS conflicts have type Conflict
and a stable message prefix (`notes.conflict`, `notes.state_conflict`,
`notes.operation_id_reused`, `notes.undo_conflict`, `notes.relation_conflict`).

## Atomic transfer

```ts
invoke('notes_transfer_blocks', { request: {
  operation_id: 'uuid-unique-per-intent',
  source_note_id: 'note_source', target_note_id: 'note_target',
  expected_source_updated_at: '2026-09-22T00:00:00.001Z',
  expected_target_updated_at: '2026-09-22T00:00:00.002Z',
  source_content: '',
  target_content: '<!-- ds:block-id=blk_a -->\n\nMoved paragraph\n',
  block_ids: ['blk_a'],
}});
```

`source_content`/`target_content` are **complete proposed documents**, not patches.
Both pages must use `markdown-blocks`. Each selected ID must exist exactly once
in the source and not occur anywhere in the target. Every root block needs a
valid marker. Root Markdown bodies, IDs and relative order must be preserved:
source = original minus selection; target = original plus selection. Leading,
trailing and inter-block whitespace may differ; body text may not. Arbitrary
edits disguised as transfers are rejected. Code/list/blockquote nested comments
are not root markers. Reference definitions unsupported by this envelope are
rejected rather than silently omitted.

Example result:

```json
{
  "operation_id": "uuid-unique-per-intent",
  "source_note_id": "note_source",
  "target_note_id": "note_target",
  "source_updated_at": "2026-09-22T00:00:01.001Z",
  "target_updated_at": "2026-09-22T00:00:01.002Z",
  "source_version_id": "nrev_source",
  "target_version_id": "nrev_target",
  "undone": false
}
```

Retry **the exact same request**, including original OCC tokens and operation ID.
The receipt is returned without reapplying the move. Reusing an ID with changed
arguments conflicts. A retry after undo returns the undo receipt (`undone:true`).
Receipts report the original commit tokens, not the present note head: reload
both complete documents after a successful response or event.

```ts
invoke('notes_undo_transfer', {
  operationId: 'uuid-unique-per-intent',
  expectedSourceUpdatedAt: moveResult.source_updated_at,
  expectedTargetUpdatedAt: moveResult.target_updated_at,
});
```

Undo uses the **move result** tokens, never fresh tokens from subsequent edits.
It restores exact pre-move document bytes, with new monotonic OCC tokens and
history versions. Later edits to either page reject the entire undo. Duplicate
undo requests with the original move tokens return the same undo receipt.
Notes, resources, link graph, history, asset refs and receipt commit in one SQLite
transaction. A failure in the second page or receipt rolls everything back.
Before/after versions receive local retention pins; their immutable payload and
source are preserved for history synchronization. Users may release pins through
the existing history API; the receipt independently retains undo bodies/assets.
Event to all WebViews: `notes:transfer-completed`, payload = TransferResult.

## Per-entry CAS review/draft state

Persist one record per candidate/window identity. There is no shared JSON index.
The exact **`type`** field is `"review" | "draft"` (not `kind:"ai-review"`).

```ts
invoke('notes_state_get', { request: {
  note_id: 'note_a', type: 'review', key: 'review_uuid',
}}); // NoteState | null
invoke('notes_state_list', { request: {
  note_id: 'note_a', type: 'review', include_deleted: false,
}}); // NoteState[], key order; include_deleted defaults to false
invoke('notes_state_put', { request: {
  note_id: 'note_a', type: 'review', key: 'review_uuid',
  expected_revision: null,
  value: { candidate: 'Markdown', window_id: 'notes-1' },
}});
invoke('notes_state_delete', { request: {
  note_id: 'note_a', type: 'review', key: 'review_uuid', expected_revision: 1,
}});
```

```json
{
  "note_id": "note_a", "type": "review", "key": "review_uuid",
  "value": { "candidate": "Markdown", "window_id": "notes-1" },
  "revision": 1, "deleted": false, "updated_at": "2026-09-22T00:00:00.001Z"
}
```

`value` is any JSON value, including a JSON string if the frontend keeps its own
serialization. `expected_revision:null` means create-only. Update requires the
latest integer revision. Delete writes a tombstone with `value:null`,
`deleted:true` and incremented revision, returning the same NoteState shape.
Get includes tombstones; list excludes them by default. A tombstoned key can be
recreated only using its current revision, preventing stale create/ABA races.
Normal note autosave does not change these revisions.
Event to all WebViews: `notes:state-changed`, payload = NoteState.

## Format gate and explicit migration

```ts
invoke('notes_get_format', { noteId: 'note_a' });
// { note_id, content_format, format_version, serializer_version, baseline_version_id }
invoke('notes_migrate_blocks', {
  noteId: 'note_a', expectedUpdatedAt: saved.updated_at,
  content: '<!-- ds:block-id=blk_a -->\n# Heading\n',
}); // existing VfsNote (camelCase metadata, no body)
```

Legacy format = `markdown-legacy / 1 / markdown-v1`; stable format =
`markdown-blocks / 1 / blocks-v1`. The marker is a Markdown root-level HTML
comment `<!-- ds:block-id=blk_a -->`. IDs are 1–128 ASCII alphanumeric/underscore/
hyphen characters. Markers precede one root Markdown node; blank lines are allowed.
Empty stable documents remain stable through the persisted format row.

Migration must only insert marker lines: deleting those root marker lines must
reproduce the stored legacy Markdown **byte-for-byte**. Preserve its whitespace;
do not reserialize/normalize existing content during migration. The pre-migration
revision is stored as `baseline_version_id` and exempted from ordinary pruning.
Migration is per page, requires OCC, and is never triggered implicitly by save.
New notes containing complete valid markers are created as stable format.

Repo create/update gates cover notes/DSTU/canvas/AI writes through VfsNoteRepo.
A stable page rejects marker-stripping writes. Unknown content format, format
version, serializer version or reserved root `<!-- ds:... -->` schema headers
reject body writes. Unknown history formats cannot be restored through the old
serializer. Metadata-only edits do not reinterpret the stored body.
Event: `notes:format-changed`, payload = existing VfsNote.

## Learning relationships and reference validity

`type` = `"source" | "card" | "mistake"`. No title is stored as an identity.
`resource_id` is VFS `resources.id`, except `locator.type:"card"`, where it is
the stable Anki `document_tasks.document_id`. Card existence is read from the
real Anki database, including task/card deletion state. A mistake uses an exam
resource ID plus its question ID.

Locator is a discriminated union:

```json
{"type":"whole"}
{"type":"page","value":12}
{"type":"block","value":"blk_a"}
{"type":"card","value":"card_a"}
{"type":"question","value":"q_a"}
```

Page numbers are 1-based and checked against `files.page_count`. Blocks are
checked against root stable IDs. Questions must belong to the referenced live
exam. Cards must belong to the referenced live Anki document. A `card` relation
requires a card locator; a `mistake` relation requires a question locator.

```ts
invoke('notes_relation_put', { request: {
  id: 'relation_uuid', note_id: 'note_a', block_id: null,
  type: 'source', resource_id: 'res_pdf', locator: { type: 'page', value: 12 },
  expected_revision: null,
}});
invoke('notes_relation_get', { id: 'relation_uuid' }); // NoteRelation | null
invoke('notes_relation_list', { noteId: 'note_a' }); // NoteRelation[]
invoke('notes_relation_delete', { id: 'relation_uuid', expectedRevision: 1 }); // true
invoke('notes_reference_status', {
  resourceId: 'res_pdf', locator: { type: 'page', value: 12 },
}); // { resource_exists: true, locator_exists: true }
invoke('notes_invalidate_resource_refs', { resourceId: 'res_pdf' }); // affected count
```

```json
{
  "id": "relation_uuid", "note_id": "note_a", "block_id": null,
  "type": "source", "resource_id": "res_pdf", "locator": { "type": "page", "value": 12 },
  "revision": 1, "invalidated_at": null,
  "created_at": "2026-09-22T00:00:00.001Z", "updated_at": "2026-09-22T00:00:00.001Z",
  "reference": { "resource_exists": true, "locator_exists": true }
}
```

Put is create/update with CAS; `id` is client-generated, `null` expected revision
creates only. Update revalidates the target and clears invalidation. Delete is
physical and requires CAS; relation IDs should be unique per creation.
`block_id` optionally anchors the relationship to an existing root block in its
owner note. Deleting an owner/target block invalidates the relationship.
Note edits that replace a VFS resource retarget valid references atomically.
Resource deletion and note/file/exam/question trash operations invalidate rows
via SQLite triggers; invalid rows remain visible. List/get always also return
live target existence, so deletion in the independent Anki DB is visible without
relying on an event. External deletion callers can use the invalidation API.
A usable reference has no `invalidated_at` and both existence booleans true.

## Integration and sync ownership

New tables: `note_document_formats`, `note_transfer_operations`, `note_state`,
`note_learning_relations`. This migration adds no change-log triggers. The sync
agent now transports `note_document_formats` together with the note/history
envelope (RowSync). The other three tables need local-persistent/BackupOnly
classification: CAS revisions and undo receipts are scoped to this database.
The format table is a write gate, not a disposable cache. Full DB backup includes
format baselines, CAS state, relations and receipts. Resource-only/note-only
exports require separate handling by the export/sync agent.

The parallel frontend's provisional `kind/id/payload` state API must adapt to
`request.type/key/value`. Its provisional `notes_relation_upsert({input})` must
adapt to `notes_relation_put({request})`, use typed locators and snake_case
responses; relation display titles should be resolved by resource ID. Transfer
request and undo argument names already match the frontend service.
