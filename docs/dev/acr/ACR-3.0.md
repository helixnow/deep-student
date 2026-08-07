# ACR 3.0 - Transactional Agent Collaborator Runtime

> Status: implementation contract. ACR 3.0 replaces the split ACR 1.x
> `apply_ops` and ACR 2.0 `act` lifecycle with one transactional runtime.

## 1. Non-negotiable invariants

1. Every mutating request is a transaction identified by an opaque operation id
   and bound to one Chat session, one tool call and, when applicable, one window.
2. A window lease is acquired before focus changes, resource selection, observe,
   action execution, suggestion dispatch or inverse replay.
3. `act`, `apply_ops` and `undo` use the same lease, cancellation and terminal
   receipt machinery. `wait_for` is cancellable but does not acquire a write lease.
4. A request has exactly one authoritative terminal result. Rust must not invent
   `done`, `undone` or `applied` after frontend execution has started.
5. `completed` means both the application state and its persistence boundary have
   acknowledged the requested change. A DOM dispatch, timer, synthetic sequence or
   swallowed exception is not completion.
6. Undo never overwrites a diverged user state. Every inverse is protected by the
   forward action's post-state revision, state predicate or domain content fingerprint.
7. Undo authorization is at least as sensitive as the highest-risk inverse action.
   A Medium undo path cannot replay a High capability.
8. Probe and bridge failures fail closed for dirty or destructive writes. Backend
   fallback is allowed only when the runtime can prove that no editable frontend
   state can be overwritten.

## 2. Transaction identity and isolation

The transport continues to expose `sessionId` and the model-provided `runId` for
compatibility, but runtime maps and journals use a collision-resistant internal
operation id. No map may use a bare tool-call id as a cross-session key.

A transaction records:

- protocol version and operation id;
- session id, tool-call id and correlation id;
- command, target window/resource and approved risk ceiling;
- lifecycle state and cancellation signal;
- lease acquisition time and bounded drain deadline;
- authoritative terminal receipt and undo metadata.

Lifecycle:

```text
preparing -> active -> cancelling -> terminal
                  \---------------> terminal
```

Cancellation is idempotent. Once cancellation starts, no new action may begin. The
currently executing domain step may settle, after which the frontend returns the
real applied prefix. If it misses the drain deadline, the response is `partial` with
`resultUnknown: true`; it is never represented as `applied: 0` unless that fact is
known.

## 3. Receipt contract

For operation receipts:

- `completed`: `applied === totalOps`, `undone` is empty and persistence succeeded;
- `partial`: `0 <= applied < totalOps`, and `done`/`undone` describe the same prefix;
- `cancelled`: cancellation was observed and the applied prefix is known;
- `failed`: no requested mutation was accepted, unless `resultUnknown` is true;
- `suggestionPending`: requires an acknowledgement from the owning UI surface;
- `resultUnknown`: forbids backend fallback and verbatim retry.

Bridge responses must match the expected correlation id and authenticated request
nonce. Successful command responses must contain data valid for that command; `{}`
is not a successful mutating result.

## 4. Undo contract

Undo tokens are opaque, session-bound and single-flight. Journal entries include:

- inverse descriptors or closure ledger entries;
- target identity and forward post-state guard;
- maximum inverse risk;
- durability and per-inverse progress;
- `available | reverting | consumed` state.

Concurrent replay of one token returns `UNDO_IN_PROGRESS`. A failed inverse restores
the token to `available` without losing progress. The token is consumed only after
all inverses and their persistence checks succeed. Diverged state returns
`UNDO_CONFLICT` and preserves the token for an explicit conflict-resolution flow.

## 5. Domain requirements

### Notes

- Agent operations use full-document semantics even when the editor renders a line
  window. If a full-document transaction API is unavailable, unsafe delegation is
  rejected and must not silently target the visible prefix.
- Insert undo uses a mapped anchor plus inserted-content fingerprint, not a frozen
  ProseMirror range.
- Editor mutation and save APIs return explicit success/failure and never swallow a
  failure that the runtime needs to classify.
- Suggestion dispatch is request/acknowledgement based; an occupied diff surface
  returns a rejection before the tool receipt is finalized.

### Mind maps

- All mutations, including `update_node`, participate in document-version and active
  editor conflict checks.
- Frontend and backend patch semantics are identical. Nested style fields merge in
  the same way on both planes.
- Store/editor lookup is scoped by the leased window and resource, never by a global
  "most recently mounted" resource lookup.

## 6. Risk and control modes

- Risk is derived from the effective operation, not only the broad tool name.
- Browser navigation through `open_app` has the same minimum sensitivity as
  manifest `navigate`.
- Mind-map delete/move and destructive note set/replace follow destructive-write
  approval policy regardless of whether the frontend or backend plane executes them.
- `background` cannot be overridden by model-supplied focus flags.
- Explicit pause remains paused until explicit resume, stop or the bounded abort
  deadline; subsequent user input cannot turn it into an automatic resume.

## 7. Compatibility and rollout

ACR 2.0 tool names remain accepted during migration. Responses add protocol and
operation metadata without removing existing fields. Legacy `acr-run:*` tokens may
be consumed only when their session identity can be resolved unambiguously; otherwise
they expire safely.

ACR 3.0 is ready for default mutating use only after:

1. TypeScript and Rust contract tests cover the same receipt fixtures.
2. Cross-session duplicate tool-call ids, concurrent act/apply/undo, cancel races,
   long-note windowing and user-edit-after-action undo all pass.
3. Real `npm run tauri dev` E2E verifies Chat -> Rust -> bridge -> UI -> persistence ->
   reopen for Notes and Mindmap, including cancellation and undo.
4. DevPanel sampling confirms bounded leases, no orphan presence and acceptable
   long-document observation cost.
