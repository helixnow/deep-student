---
name: dstu-plugin-development
description: Create or modify a dstu plugin using real SDK discovery, managed source files, iterative built-in compilation/repair, hot installation and durable rollback.
---

# dstu plugin development

## Before proposing

- Check the available services, slots and recipes with `dstu_plugin_api_list`. Use the declared capabilities and public SDK.
  What cannot be done (no slot in a built-in screen, mobile only) goes in `limits`, the nearest
  feasible version in `alternatives`; still propose it.
- `dstu_plugin_inventory`: if a built-in feature is similar, say how this differs in `builtinDifference`.
- Ask only for decisions the user must make.
- Third-party APIs: prefer `service:pluginModel`; otherwise a `secret` setting. Never copy a key the user pasted
  into the plan or source. Ask the user to enter it in the secret field on the card.

## From the request to a working plugin

1. Determine the user's intent from the conversation. An explicit request to build, change or fix this goal
   delegates implementation: call `dstu_plugin_propose_install` with `execute: true`. A feasibility question or
   request for a proposal alone does not: omit `execute` or use false. Do not classify intent by matching keywords.
2. Include `title`, `description` (goal and an observable acceptance criterion), `template` (`learning-tool` = Host + UI,
   `host-tool` = Host only), `changes` (observable requirements) and honest `capabilities`. Omit `pluginId` for a new
   plugin; use the existing `workshop.plugin-...` id from `dstu_plugin_status` for a modification. Missing values only
   the user knows go in `settings`: `[{"key":"calendarUrl","title":"课表日历地址（.ics）","kind":"ics-url"}]`.
   Kinds are `ics-url` / `https-url` / `text` / `secret`; use `value` only if the user supplied it, never for a secret.
   Secrets are read with `ctx.pluginSecrets.get(key)`.
3. For delegated execution the Host inherits the current conversation's actual model, writes and compiles source,
   test-loads it, activates the candidate, and separately checks the requested result. Do not ask again for 开始做 or 安装, edit source concurrently, or start a duplicate job.
   Proposal-only cards retain the manual 开始做 and 安装 flow. The Host checks calendar URLs (VCALENDAR), declares
   `net:<host>` for user addresses and assigns versions; do not invent addresses or versions.
4. Repair decisions follow concrete diagnostics: fix actionable compile/runtime errors; report `blockedReason` for a
   missing capability, user value or external condition. Do not invent a fixed retry count. Installed failures can
   restore the last verified release, then continue repairing the delegated goal; rollback cannot undo data or network
   side effects. Explain any blocked condition and request only the missing information or scoped action.
5. Verification is separate from generation and activation. The current verifier uses read-only workbench observations
   of the exact candidate and cites successful tool calls for each acceptance criterion. A mounted page, source code
   or a visible control does not prove a click, write or plugin-tool invocation worked. If such an action is required,
   return blocked with the exact missing scoped test. Without actual UI observation say “视觉未验证”. Report delivery
   only when `execution.stage=complete` and `validation.status=passed`; otherwise state what remains unverified.
6. To change or fix a work, reuse its `pluginId` and describe the changes under the same intent rule. For an authorized,
   failed work that is not being generated, `dstu_plugin_diagnose` → `dstu_plugin_write_source` (minimal fix) →
   `dstu_plugin_validate` can help diagnosis. Validation only compiles and test-loads: it does not prove the goal works.

## Writing plugins (what the Host's generation follows)

- TypeScript/TSX compiled by the app; no npm, scripts or downloads. Preserve the Host-assigned id; `__PLUGIN_ID__` and
  `__SERVICE__` placeholders are replaced. Default-export a normal HostPlugin; register effects inside apply.
- UI imports only react, react-dom, @deepstudent/ui, i18next and @milkdown/kit/* (editor). Use SDK components and theme variables
  (`hsl(var(--foreground))`); never override global selectors or modify the app HTML. zh-CN title via
  `ctx.ui.i18n.addBundles`.
- Reference apps: use `DsSearchInput`, `DsCard`, `DsListItem`, `DsBadge`; formulas use safe `MathText {tex, display?}`
  or `{text}` with `$…$`, never dangerouslySetInnerHTML. Read exact props from
  `examples:resources/dstu-workshop/recipes/reference-app/ui.tsx`.
- New Agent tool ("when I say X, do Y"): host-tool + manifest `agentTools` + `agent:tools`; a method with the same name
  on the primary service `(args, tool) => JSON`; network only via `tool.fetch` (HTTPS GET) on declared `net:<host>`; no
  imports, global fetch/process/require. Read user values from config: `apply(ctx, config)` → `config.calendarUrl`;
  throw a clear message when missing. Recipe: `examples:resources/dstu-workshop/recipes/agent-tool/index.ts` (+ `package.json`).
- Button that asks the model (e.g. 编成口诀): learning-tool, `service:pluginModel`, `inject: ['pluginModel']`,
  `ctx.pluginModel.complete({ system, prompt }, { signal })`; UI contributes to `editor.selectionToolbar` with
  `addItem(key, { label, icon, showLabel: true, onRun })` (never restyle `.toolbar-item`) and shows waiting / result /
  error in `createPluginOverlay(ctx)`. Open editors pick the button up right after installation. Recipe:
  `examples:resources/dstu-workshop/recipes/selection-model/ui.tsx` (+ `index.ts`, `package.json`).
- Plugin services (declare `service:<name>` + inject): `studyData` (notes / cards / questions / review / todos / resources:
  list, get, search, create, update), `pluginSchedule.daily(id, 'HH:MM', run)` / `weekly` / `every` / `onStartup` (runs in
  the Host, missed runs catch up), `pluginNotify.notify({ title, body, view })`, `pluginSecrets`, `pluginModel.complete` /
  `.stream` (optional `images`). App events without declaring: `ctx.on('study/note-saved' | 'study/card-reviewed' |
  'study/answer-finished' | 'study/cards-created', fn)`. UI: `pluginFiles` (pick / read / save) and `editorApi(view)` from
  @deepstudent/ui; slots `pdf.selectionToolbar`, `chat.composer.commands`, `chat.message.actions`, `review.cardActions`,
  `statusbar.items`, `desktop.widgets`, `theme.variants`. Recipes: `nightly-summary`, `pdf-selection`, `chat-command`.
- App data (notes, cards, question bank, review, files, todos …): `dstu_plugin_api_list` (category `services`) lists every
  live service as `service:<name>`; `dstu_plugin_api_read` gives its real method signatures and docs. Inject it, declare
  `service:<name>` and call only methods listed there. For other extension points use the same tools; report unsupported
  ones as unsupported and propose an available alternative, never patch the application.
- Keep `capabilities` honest; the Host also displays the built code's actual data access and permissions.

## After installation

- Configuration: `dstu_plugin_inventory` (hasConfig), `dstu_plugin_config_get` (real schema and values), then
  `dstu_plugin_configure` with complete values: validated and hot-applied, persisted under the manager's revision check.
  `dstu_plugin_set_enabled` hot-loads or unloads a managed plugin. Neither restarts the app.
- Installed plugins run in the app's process. Full trust is not isolation; do not promise code safety from structure
  checks or reversal of filesystem/network/data side effects.
- Failures leave the installed release untouched; faulty installed works are isolated and may recover an earlier approved
  version. Use `dstu_plugin_rollback` for a failed managed work. Revocation retains sources and packages.
- `dstu_plugin_export` writes a local .dstuplugin only, never publishes. `dstu_plugin_app_restart` only when the user
  explicitly asks for an app restart.
- Stored data must stay readable across versions: keep a version field (`{ v: 1, … }`), migrate older records on read,
  never rename or drop existing keys in a modification.
