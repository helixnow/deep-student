# Chat V2 Subagent Runtime

## Goal

Subagents are backend-managed agent threads. The frontend observes runtime state but does not
start, retry, or complete agent runs.

The design follows these invariants:

1. Dispatching a subagent creates a durable thread and starts its first run in the backend.
2. Execution capacity is acquired before inbox messages are claimed and before a run becomes
   `running`.
3. A terminal pipeline result always produces one typed completion envelope for the parent
   (runtime-owned completion). The model is never required to call a tool to deliver its result.
4. Model-authored workspace messages are collaboration messages (progress, questions, shared
   data), not lifecycle acknowledgements.
5. Agent configuration is resolved from a profile, with explicit inheritance and permission rules.
6. UI events mirror committed runtime state and are never required for progress.

## Single Task Tool: `builtin-subagent_call`

`builtin-subagent_call` is the single delegation entry point, aligned with the Cursor Task /
some providers task shape. One call dispatches one subagent run.

### Parameters

| Parameter | Required | Description |
| --- | --- | --- |
| `task` | yes | The task to execute (max 20000 chars). |
| `workspace_id` | no | Existing workspace ID. When omitted, the backend auto-creates a workspace and registers the calling session as coordinator (`auto_created_workspace: true` in the result). Required when `resume_agent_session_id` is set. |
| `profile` | no | Free-form string: `"worker"` (default), `"explorer"`, `"default"`, or the `name` of a custom agent definition. Unknown values fail with an error that lists every available profile. See Profiles and Custom agent definitions below. |
| `resume_agent_session_id` | no | Resume an existing subagent session instead of creating a new one. See Resume below. |
| `skill_id` | no | Legacy alias; mapped to a profile when possible, otherwise falls back to `worker`. |
| `model` | no | Model override for the subagent. |
| `context` | no | Arbitrary JSON handed to the subagent. |
| `wait` | no | Defaults to `true`. See wait modes below. |

### Wait modes

- **`wait: true` (default)** — the tool blocks until the subagent run terminates, with an internal
  wait budget of **750s**. The result carries the final output directly (contract C4 key names):

  ```json
  {
    "workspace_id": "ws_...",
    "agent_session_id": "agent_...",
    "run_id": "run_...",
    "task_message_id": "msg_...",
    "status": "completed",
    "output": "... (<= 4000 chars)",
    "output_truncated": false,
    "auto_created_workspace": true,
    "profile_id": "worker",
    "skill_id": null,
    "resumed": false,
    "token_usage": null
  }
  ```

  `status` is one of `"completed" | "failed" | "cancelled" | "running"`. On `failed`, a top-level
  `error` field is attached. If the 750s budget is exceeded, the tool returns
  `status: "running"` plus the ids; the coordinator can then wait via `coordinator_sleep`.

- **`wait: false`** — the tool returns the ids immediately. This is the parallel fan-out path:
  dispatch several subagents with `wait: false`, then call `builtin-coordinator_sleep` once to
  wait for all of them. The 120s watchdog bug in sleep has been fixed; sleep remains a fully
  supported advanced path.

A single delegated task therefore needs neither a prior `workspace_create` nor a follow-up
`coordinator_sleep`.

## Runtime Model

An agent is a reusable thread. A run is one execution on that thread.

Agent states:

- `idle`
- `queued`
- `running`
- `interrupted`
- `closed`

Run terminal states:

- `completed`
- `failed`
- `cancelled`
- `interrupted`

Every run has a stable `run_id`, an optional `parent_run_id`, a task correlation id, timestamps,
attempt information, and a terminal output or error.

### Concurrency and limits

- Global subagent concurrency: **4** concurrent runs.
- Per-run pipeline timeout: **600s**.
- Maximum agent tree depth: **3**. Depth and parent linkage (`parent`/`depth`) are written by the
  backend on every creation path.
- `subagent_call` blocking wait budget: **750s** (pipeline timeout plus scheduling headroom).

## Profiles

An agent profile (`AgentProfile`) resolves the following fields before a thread is created:

- developer instructions
- model and reasoning effort
- allowed tools
- permission or sandbox policy
- enabled skills
- context inheritance policy

Built-in profiles are wired for real:

| Profile | Purpose | Tool surface |
| --- | --- | --- |
| `worker` (default) | Pure execution of a delegated task | Worker toolset (workspace collaboration tools) |
| `explorer` | Research tasks that need retrieval / reading material | Read-only retrieval surface: `unified_search`, `rag_search`, `web_search`, `web_fetch`, `resource_list`, `resource_read`, `resource_search`, `folder_list`, `memory_read`, `memory_list` |
| `default` | Full default tool surface | Standard session toolset |

Legacy `skill_id` values are mapped to a profile when possible and otherwise fall back to
`worker`; they are not trusted as arbitrary tool or permission grants.

Context inheritance is explicit: `none`, `summary`, `last_n_turns`, or `full`. The default is a
bounded summary plus explicitly attached artifacts.

## Custom Agent Definitions

Users can define additional profiles as markdown files in `{appData}/workspaces/agents/*.md`.
Each file has a YAML frontmatter block; the markdown body becomes the agent's instructions.

| Field | Required | Description |
| --- | --- | --- |
| `name` | yes | Profile identifier used as the `profile` argument. Lowercase letters, digits, and hyphens only. Built-in names (`default`, `worker`, `explorer`) are reserved and rejected. |
| `description` | no | Human-readable summary of the agent. |
| `base` | no | Built-in profile to inherit from. Defaults to `worker`. |
| `model` | no | Model override for the agent. |
| `tools` | no | Allowed tool list. Must be a subset of the headless read-only whitelist plus the workspace collaboration tools; out-of-scope entries are silently dropped. |
| `skills` | no | Recorded for provenance only; skills are **not** loaded for custom agents. |

Parsing and safety rules:

- Tool grants can only narrow, never widen: entries outside the headless read-only whitelist +
  workspace collaboration tools are removed during resolution.
- Built-in profile names are reserved; a definition that reuses them is rejected.
- Limits: at most **64 files**, each at most **64 KiB**.
- Passing an unknown `profile` value to `subagent_call` fails with an error that lists all
  available profiles (built-in and custom).

The Settings page lists all profiles (built-in and custom) and offers a shortcut to open the
definitions directory (Settings → Automations tab, "Subagent Profiles" section, backed by the
`workspace_list_agent_profiles` command).

## Resume

`subagent_call` accepts an optional `resume_agent_session_id`:

- Pass the `agent_session_id` returned by the first call; `workspace_id` is then **required**
  and must be the value returned by that first call.
- The backend skips thread creation and delivers the new `task` as a follow-up message to the
  same subagent session, preserving its full history and context.
- The call blocks (or returns ids with `wait: false`) exactly like a fresh dispatch.
- The result carries `resumed: true` on the resume path and `resumed: false` otherwise.

Use resume to iterate with or ask follow-up questions of an existing subagent instead of
spawning a new one.

## Creation Paths

- `builtin-subagent_call` — the single Task tool described above.
- `builtin-workspace_create_agent` (path C) — registers an agent in an existing workspace. When
  `initial_task` is provided, the backend runtime dispatches it natively and the tool returns
  `status: "dispatched"`; the frontend is not involved in starting the run.

Depth and concurrency limits are enforced by the runtime for every creation path.

> **Removed:** the previously documented AgentControl control plane
> (`spawn` / `list` / `send_message` / `followup` / `interrupt` / `wait` / `close` / `resume`)
> was never wired and has been deleted. Delegation goes through `subagent_call` /
> `workspace_create_agent`; waiting goes through the blocking `wait: true` mode or
> `coordinator_sleep`. Follow-up questions to an existing subagent go through
> `subagent_call` with `resume_agent_session_id` (see Resume above), not a control plane.

## Parent→child Messaging Visibility

Messages sent by the coordinator via `workspace_send` reach a subagent through one of three
channels, each with distinct semantics:

- **Live injection** — if the target subagent is currently `running`, the backend injects the
  formatted message into its active turn and persists a `workspace_injection` block on the
  subagent's current assistant message (event family `workspace_injection_start` →
  `workspace_injection_chunk` → `workspace_injection_end`, with the injection metadata
  `{workspace_id, message_count, senders, message_types, injected_at}` as `toolOutput`).
- **Inbox queue** — if the subagent is idle or has terminated, the message is only enqueued in
  its inbox and does **not** trigger execution.
- **Resume consumption** — a follow-up `subagent_call` with `resume_agent_session_id` starts a
  new run on the same thread and drains the queued inbox messages as part of that run.

Frontend surfaces:

- The `workspace_injection` block renders inside the subagent's embedded `ChatContainer` as a
  muted "message from coordinator/workspace" card with message-type chips and collapsible text.
- `workspace_send` tool calls render as a dedicated delivery card (`workspace_send` block) that
  shows the target (last 8 chars of `target_session_id`, or "broadcast"), the message type, and
  a content summary.
- `AgentInfo` from `workspace_list_agents` carries `pending_inbox_count`; the subagent embed
  header and the workspace status agent rows show an amber "N pending" badge when a
  non-running agent has unconsumed inbox messages, hinting that a resume is needed to process
  them.

## Completion Contract (runtime-owned)

When a run reaches a terminal state, the runtime persists a typed result and sends a result
envelope to its direct parent. This never depends on the model calling `workspace_send`; the
subagent's final answer is delivered by the runtime itself. `workspace_send` is reserved for
intermediate progress, questions to the parent, and shared data.

The UI mirror event is `workspace_agent_completion` (envelope unchanged):

```json
{
  "workspace_id": "ws_...",
  "agent_session_id": "agent_...",
  "run_id": "run_...",
  "status": "completed",
  "final_output": "...",
  "error": null,
  "completed_at": "2026-07-11T12:00:00Z",
  "token_usage": null
}
```

`workspace_worker_ready` may still be emitted for compatibility and display, but backend-managed
workers set `runtime_managed: true`. The frontend must not call `runAgent` for those events.

## Token Accounting

Both the terminal `subagent_call` result and the `workspace_agent_completion` envelope carry a
`token_usage` key. The value is either `null` (no usage could be collected) or a camelCase
`TokenUsage` object:

```json
{
  "promptTokens": 10240,
  "completionTokens": 2048,
  "totalTokens": 12288,
  "source": "api",
  "reasoningTokens": 512,
  "cachedTokens": 4096
}
```

`promptTokens`, `completionTokens`, and `totalTokens` are always present on a non-null object;
`source`, `reasoningTokens`, and `cachedTokens` are optional. Note the asymmetry: the outer key
is snake_case (`token_usage`) while the object fields are camelCase. The frontend mirrors the
envelope value as `AgentCompletionEnvelope.tokenUsage` and the subagent embed card renders the
total as a compact `⋯ tokens` counter in terminal states.

## Coordinator Sleep

`builtin-coordinator_sleep` waits for subagents that were dispatched with `wait: false`. While
sleeping, the coordinator pipeline is suspended and is woken automatically when subagent results
arrive (or on timeout). It is no longer a mandatory step after creating a worker: the default
blocking `subagent_call` returns the result directly, so sleep is only needed for parallel
fan-out and for runs that outlived the 750s blocking budget.

## Migration

Legacy sessions and workspace messages remain readable. During the transition, the frontend may
use the old start bridge only when `runtime_managed` is explicitly false or the legacy environment
switch is enabled. New runs always use backend supervision and typed completion.
