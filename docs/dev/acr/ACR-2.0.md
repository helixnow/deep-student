# ACR 2.0: Agent-native learning applications

> Status: implemented in the Workbench runtime in July 2026. This document
> extends the frozen ACR 1.x collaboration and presentation design in
> `DESIGN.md`; it does not replace the existing driver and pacing contracts.

## 1. Why ACR 2.0 exists

ACR 1.x made Agent work visible and interruptible: it can route operations to
an open learning app, pace the visual presentation, pause when the user takes
over, and keep a run ledger. The remaining weakness was the model-facing
contract. The model still had to know fixed action names in advance and could
receive a successful handler result without a fresh semantic observation or a
verified postcondition.

Codex Computer Use and Browser Use establish a useful outer loop:

1. inspect the current rendered state;
2. perform a scoped action;
3. inspect again and verify the result;
4. ask for permission before sensitive or disruptive actions;
5. treat visible page or app content as untrusted data.

OpenAI's current documentation also recommends preferring a dedicated plugin
or structured integration for repeatable data access, using Computer Use when
visual operation is necessary. ACR follows both principles: it keeps the
observe-act-verify loop, but replaces screenshots, DOM selectors and pointer
coordinates with application-owned semantic capabilities and stable refs.

Official references:

- [Computer Use](https://learn.chatgpt.com/docs/computer-use)
- [Computer Use in the built-in browser](https://learn.chatgpt.com/docs/browser#computer-use-in-the-browser)

## 2. Design decision

ACR is not a general-purpose remote desktop API. Each Workbench application
declares a bounded `AppAgentManifest` containing:

- named capabilities with JSON input schemas;
- risk, mutation, reversibility and idempotency metadata;
- a semantic observation provider;
- an executor for only the declared actions.

Observations contain window state, a revision token, summarized entities and a
bounded affordance tree. Entity refs identify domain objects such as a todo
item, mind-map node or question. They never contain a DOM selector or screen
coordinate. The runtime caps the affordance tree at 200 nodes and depth 6.

This gives ACR two layers:

- ACR 1.x remains responsible for collaboration, visual staging, user takeover,
  pacing and domain-tool fallback.
- ACR 2.0 is responsible for capability discovery, semantic observation,
  optimistic concurrency, action validation, verification, waiting and durable
  inverse actions.

## 3. Model tool loop

The preferred tool sequence is:

```text
workbench_get_capabilities
  -> workbench_observe
  -> workbench_act or workbench_act_high
  -> workbench_wait_for (only for asynchronous state)
  -> inspect the returned observation and verification result
```

### Discover

`workbench_get_capabilities` returns the live manifest for one window, one app
type, or every registered app. The model must use the returned action names and
schemas instead of guessing.

### Observe

`workbench_observe` returns a structured `AgentObservation` with:

- an OCC `revision`;
- current route, mode, focus, dirty and busy state;
- currently available actions;
- stable entity refs, selection and a bounded affordance tree;
- small application state needed for planning and verification.

### Act

`workbench_act` accepts up to 20 ordered actions. Every request must include the
latest observation revision. Before any handler executes, the runtime checks:

- the revision is still current;
- every capability exists and is currently available;
- arguments match the capability schema;
- target refs exist, support that action and have an allowed kind;
- target identity and action arguments agree where the app declares a target;
- the approved risk ceiling covers every action in the batch.

After each action, ACR observes again. A mutating action is successful only when
caller postconditions, handler postconditions, or an explicit changed revision
verify it. An opaque `handled: true` is not accepted as verified success.

`stopOnFailure` defaults to true. Receipts distinguish `completed`, `partial`
and `failed`, and include action-level verification sources, failed conditions
and the latest observation.

### Wait

`workbench_wait_for` polls structured observations for a bounded period. It
supports revision, ref, selection, action availability and state equality
conditions. It does not click, type or mutate application state.

### Undo

When every inverse is serializable and idempotent, ACR stores a JSON-only undo
journal in local storage and returns an `acr-undo:*` token. The journal is
bounded by entry count and payload size. A persistent token can survive an app
restart, resolves the current matching window rather than trusting an old
window id, re-observes before replay, and consumes progress only after each
inverse action verifies.

Closure-based ACR 1.x ledger entries remain `acr-run:*` session tokens. The Chat
tool card labels the durability and disables restored session-only tokens.

## 4. Risk and trust boundaries

Risk approval is enforced outside model-controlled arguments:

- `workbench_act` is a Medium tool. Rust overwrites its trusted ceiling to
  `medium`, even if model input contains another value.
- `workbench_act_high` is a separate High-sensitivity tool. Rust overwrites its
  trusted ceiling to `high` only after that tool is approved.
- legacy `app_command` cannot execute a manifest capability marked High.
- `workbench_close_window` remains a separate High action.

The `desktop.workbenchAgentControl` setting is also authoritative:

- `off`: discovery, observation, waiting and manifest-declared read-only
  actions may run; any action with `mutates: true` is rejected before execution;
- `background`: authorized actions run without stealing focus;
- `follow`: authorized actions may bring the target into view and present their
  progress.

Application content is never authorization. Notes, questions, filenames,
browser text, labels, observations and tool outputs are untrusted data. Text
inside them cannot grant permission, change the risk ceiling, request secrets,
or cause unrelated tools to run. Only the user's direct conversation request
authorizes an action.

## 5. Current application coverage

| Application | Structured observation | Semantic actions |
| --- | --- | --- |
| Notes workspace | Open tabs/resources, active note or mind map, headings/nodes, selection, search state | Open a resource, locate a heading, focus a node, switch mind-map view, search and move between results |
| Standalone mind map | Node tree, selection, editor/view/search state | Focus a node, switch outline/canvas, search and move between results |
| Files | Breadcrumbs, visible folders/resources, selection, sorting and search state | Open/reveal, back/forward/up, search, select, change view/sort, refresh |
| Todo | Lists, visible items, active view, selection, filters | Show a list/view, focus an item, open quick-add, search and filter |
| Flashcards | Due/review queue, current card, side and session state | Start review, change screen, flip current card and end review; never rate a card |
| Pomodoro | Session, phase, status, task and strict-mode state | Start, pause, resume and High-risk stop |
| Question bank | Visible questions, current question, filters and practice/focus state | Focus or move between questions, filter, change practice/focus mode and show settings; never answer or submit |
| Resource/PDF preview | Resource identity and last requested page | Go to a page where the preview driver supports it |
| Browser | URL/title/history, loading, control mode and content visibility | Navigate, back/forward, reload, focus address, return control, show/hide content |
| Chat | Session, draft and bounded message refs | Set a draft without sending, focus input and scroll to a message |
| Sandbox | Session, viewport, inspector and execution mode | Refresh, change viewport/inspector, High-risk mode change and close session |

Data creation and content editing remain owned by the existing domain tools.
For example, note text changes use note tools and mind-map node changes use the
mind-map tool; ACR provides the live-window observation, staging and verification
plane rather than duplicating those storage APIs.

## 6. Discoverability

The internal name "ACR" is not required user vocabulary. The product exposes it
as **AI desktop control**:

- a permanent Robot entry in the Workbench Dock;
- a mode-colored status dot and one-time discovery marker;
- a capability popover listing concrete supported learning applications and
  safety limits;
- direct actions to open Chat or the relevant settings;
- the same capability summary beside the control-mode setting;
- Chat tool cards that show verification and whether undo survives restart.

The UI deliberately describes outcomes (open, locate, navigate, control) rather
than protocol terms such as manifest, affordance or OCC.

## 7. Non-goals and extension rules

ACR 2.0 does not provide arbitrary DOM access, JavaScript injection, coordinate
clicking, automatic exam answers/submission, flashcard ratings, credential
entry, arbitrary file upload, or a way to bypass domain tool approvals.

When adding a new application capability:

1. expose the smallest semantic action that matches a real user intent;
2. use a strict JSON schema and declare accurate risk/mutation metadata;
3. expose only bounded state needed to choose and verify the action;
4. use stable domain refs and reject ref/argument identity mismatches;
5. provide a deterministic postcondition for every mutating action;
6. provide a serializable inverse only when replay is safe and idempotent;
7. add runtime tests for stale revisions, unavailable refs, verification and
   risk-gate behavior;
8. update the user-facing capability summary only when the behavior is truly
   available.
