# Notes backend integration V20260923

V20260922 is unchanged. V20260923 adds retention policy, review save-as receipts,
history INSERT change-log entries keyed by `version_id`, format INSERT/UPDATE/
DELETE logs keyed by `note_id`, and pending-upload backfill for retained history
and format rows. History pruning and pin changes do not generate remote deletes
or updates. Backfill is idempotent against existing pending log entries.

## History: exact NotesAPI / NoteHistoryPanel contract

```ts
invoke('notes_history_current', { noteId });
// { content_md: string, updated_at: string, title: string }

invoke('notes_history_restore_selection_copy', {
  noteId, versionId, selection: { start_line: 3, end_line: 5 },
}); // DstuNode; new root-folder copy

invoke('notes_history_restore_current', {
  noteId, versionId, expectedUpdatedAt,
  selection: null, // or { start_line: 3, end_line: 5 }
}); // DstuNode for the original note

invoke('notes_history_get_retention');
invoke('notes_history_set_retention', {
  policy: { edit_bucket_seconds: 300, max_edit_versions: 100 },
});
// Both return { edit_bucket_seconds: number, max_edit_versions: number | null }
```

Selections are one-based inclusive source lines, with exactly the newline
semantics of `split('\n').slice(start-1,end).join('\n')`. Invalid/out-of-range
selections fail. Partial paragraph/list/code/table/columns containers fail; stable
identity markers and their entire root block must be selected together. Partial
extraction from documents with out-of-band Markdown reference definitions fails
instead of producing missing links. No automatic range expansion occurs.

Current restore replaces the **whole current body** with the historical body or
selected historical lines, as shown in the panel's diff. It also restores the
revision's title/tags/props and supported format envelope. The expected token is
the one from the displayed current snapshot; settling a draft that writes a newer
version makes this token stale and requires the user to review a fresh diff.

Source version lookup/pin, live full-state snapshot/pin, metadata/body/resource/
format changes, link/asset refs, provenance history and OCC commit together.
Any failure rolls back all changes, including newly acquired pins. Provenance
gets a new immutable version ID; an already synced version is never rewritten.
Both copy and current restore emit existing DSTU created/updated notifications.

Retention defaults remain 300 seconds / 100 ordinary edit versions. Seconds 0
disables coalescing, `max_edit_versions:null` (also accepted as 0 on input) means
no ordinary-version count limit. Valid bounds: seconds 0..86400; budget 1..100000
or null. Setting policy changes no stored document and deletes no history. It is
persisted in VFS and used by the next edit's actual Repo pruning. Pins, baseline
references and non-edit versions are excluded from the ordinary budget.

## Columns: opt-in and capable writes

The parser implements the exact WP11 standalone root directive grammar. Each
valid `:::ds-columns{version=1 layout=equal|cornell}` has exactly two `:::column`
sections, closed by `:::end-column`, and one `:::end-ds-columns`. The entire
container is one root block for identity, transfer and history selection. Unknown
versions, malformed/nested/extra columns fail validation. Fenced, quoted and
escaped examples remain literal text.

```ts
const format = await invoke('notes_get_format', { noteId });
const enabled = await invoke('notes_enable_columns', { noteId, expectedUpdatedAt });
```

Both return (example for a stable-block page):

```json
{
  "note_id": "note_a",
  "content_format": "markdown-blocks",
  "format_version": 1,
  "serializer_version": "blocks-v1+ds-columns-v1",
  "baseline_version_id": "nrev_before_upgrade",
  "required_capabilities": ["ds-columns-v1"],
  "updated_at": "2026-09-22T00:00:00.002Z"
}
```

For legacy Markdown the serializer is `markdown-v1+ds-columns-v1`. The capability
is encoded in the versioned serializer envelope so older binaries reject it;
the directive's `version=1` is not a new note `format_version`. `NoteFormat`
remains structurally compatible with the sync/export agent's Rust consumers.
Enabling preserves every body byte, pins the current baseline and advances OCC.
Existing `notes_migrate_blocks` preserves the columns capability when subsequently
adding root IDs. The two upgrades can be applied in either order.

```ts
await invoke('notes_update', {
  note: {
    id: noteId,
    content_md: completeMarkdown,
    expected_updated_at: enabled.updated_at,
    capabilities: ['ds-columns-v1'],
  },
}); // Existing NoteItem return shape
```

Supplying a capability does not opt in a page. The page must first be explicitly
enabled. Once enabled, every body write requires the capability, even when its
body currently contains no columns. Capability-aware saves require a nonempty
OCC token. Older generic note/DSTU/canvas writers without capability fail before
writing. Backend transfer is itself a container-aware writer, but still requires
the target page to have opted in before receiving a columns block.

Host follow-up: derive `columnsPlugin.canWrite` from the current page's returned
capabilities and opt-in, carry the new token into autosave, and recognize the two
new serializer strings in `NoteHistoryPanel`'s supported-format predicate.

## Review save-as: one copy per operation, one receipt per CAS step

```ts
const first = await invoke('notes_review_save_as', {
  operationId: 'review-persistence-uuid',
  sourceNoteId: 'note_source',
  markdown: 'First accepted result',
  expectedUpdatedAt: null,
  capabilities: [], // ['ds-columns-v1'] for a columns result
});

const next = await invoke('notes_review_save_as', {
  operationId: 'review-persistence-uuid',
  sourceNoteId: 'note_source',
  markdown: 'Next accepted result',
  expectedUpdatedAt: first.updatedAt,
  capabilities: [],
});
```

Exact result shape:

```json
{
  "noteId": "note_copy",
  "revision": 1,
  "markdown": "First accepted result",
  "updatedAt": "2026-09-22T00:00:00.003Z"
}
```

Revision is a numeric counter for this review copy's accepted writes; updatedAt
is the note's actual SQLite CAS token. Preserve **both** in the host's persisted
`savedAs` snapshot. First call creates a root-folder copy with source tags and a
unique source-derived title. Later calls update that same note. Other WebView
edits invalidate the expected token and cannot be overwritten by a stale review.

Retry the identical operation ID, expected token, Markdown and capabilities:
the exact receipt is returned, even if newer steps have since completed. Changed
arguments at a previously consumed token conflict. A lost first response never
creates a second copy; deleting a copy/source does not erase operation identity.
Source notes are never edited. Note creation/update, history, folder registration,
operation identity and retry receipt are in one VFS transaction. Event to all
WebViews: `notes:review-saved`, payload = this result.

No editor lease service was added: new capable writes, restore, transfers and
review updates use the stored note OCC token; per-entry draft/review state keeps
its existing revision CAS. Hosts must retain and submit these tokens, rather
than assume a renderer-local mutex protects other WebViews.

## Sync agent handoff

New local-persistent/BackupOnly tables to classify:

- `note_history_retention` — primary key `id` (singleton local policy).
- `note_review_save_operations` — primary key `operation_id` (local copy identity).
- `note_review_save_receipts` — composite key `(operation_id,expected_updated_at)`.

History INSERT logs and format logs now arrive independently of a note-body
change. History rows retain immutable identity and payload; source pins and edit
buckets remain local. Local pruning intentionally has no DELETE trigger. Empty
stable documents and capability-enabled documents without a current columns
container must retain their declared envelope during sync, not be downgraded by
body-only inference. Integration changes in `sync/*` remain with the sync agent.
