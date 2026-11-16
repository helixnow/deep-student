---
name: dstu-plugin-development
description: Create or modify a dstu plugin using real SDK discovery, managed source files, iterative built-in compilation/repair, hot installation and durable rollback.
---

# dstu plugin development

<!-- RUST-FIX(RF-P3-workshop-compiler): shipped progressive plugin-development guidance. -->

The learner asks in plain words ("给我做个公式速查的小应用", "选中一段话时多一个『编成口诀』的按钮",
"以后我说『查课表』，就去读…"). There is ONE path; follow it, do not ask follow-up questions first unless a
value only the user knows is missing and cannot go into `settings`.

## The one path

1. **Propose** with `dstu_plugin_propose_install` right away: `title` (short Chinese name), `description` (the goal
   and one observable acceptance criterion), `template` (`learning-tool` = Host + UI; `host-tool` = Host only, e.g. a
   new Agent tool), `changes`, `capabilities` (honest, plain words). Omit `pluginId` for a new plugin; pass the existing
   `workshop.plugin-...` id from `dstu_plugin_status` to modify one. Values only the user knows (a calendar .ics address,
   a site address, a name) go in `settings`: `[{ "key": "calendarUrl", "title": "课表日历地址（.ics）", "kind": "ics-url" }]`
   (`ics-url` / `https-url` / `text` / `secret`; add `value` only if the user already said it, never for `secret`). Never
   invent addresses. An API key is `secret`: the Host keeps it in the secure store; read it with `ctx.pluginSecrets.get(key)`.
2. **Stop.** The chat shows a card. Tell the user in one short sentence to check it and press 「开始做」 (and fill in what
   it asks). Pressing it is the user's approval to generate the code and test-load it in the app; until then
   `write_source` and `validate` are refused. Do not poll.
3. **The Host makes it**: it writes the source with the model, compiles, test-loads/unloads it, and repairs exact
   errors up to three rounds, showing progress on the card. It checks a calendar address for real (it must return a
   VCALENDAR) and declares `net:<host>` for user addresses itself. A modification gets its new version from the Host;
   you never bump versions.
4. **One click installs.** The card then shows 「等你确认」 with what it can do, where to find it and 「安装」. The user's
   click installs the frozen candidate and hot-loads it (no restart, no folder dragging). Agent tools can never install,
   enable, disable, revoke or restore.
5. **To change or fix it**, propose again with the same `pluginId` and the requested `changes`; the user presses
   开始做 again. Only when a started work has failed may you repair it yourself: `dstu_plugin_diagnose`, then
   `dstu_plugin_write_source` (minimal fix) and `dstu_plugin_validate`; the card says the AI is editing meanwhile.
   Report manifest, build and test-load errors honestly. Without actual UI observation say “视觉未验证”.

## Writing plugins (what the Host's generation follows)

- TypeScript/TSX compiled by the app; no npm, scripts or downloads. Preserve the Host-assigned id; `__PLUGIN_ID__` and
  `__SERVICE__` placeholders are replaced. Default-export a normal HostPlugin; register effects inside apply.
- UI imports only react, react-dom, @deepstudent/ui, i18next and @milkdown/kit/* (editor). Use SDK components and theme variables
  (`hsl(var(--foreground))`); never override global selectors or modify the app HTML. zh-CN title via
  `ctx.ui.i18n.addBundles`.
- Reference / lookup apps: `DsSearchInput {value,onChange(string),placeholder}`, `DsCard {flush?}`,
  `DsListItem {title,description?,trailing?,children?,onClick?,selected?}`, `DsBadge {variant?}`; formulas always with
  `MathText {tex, display?}` (or `{text}` with `$…$` inside): safe KaTeX, loaded on demand, shows the source when it
  does not parse. Never dangerouslySetInnerHTML. Recipe: `examples:resources/dstu-workshop/recipes/reference-app/ui.tsx`.
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
- The card also lists what the built code itself uses (files, programs, sites, timers, which service methods read or
  change data), read by the Host. Keep `capabilities` honest; the Host's lines are what the user installs.

## After installation

- Configuration: `dstu_plugin_inventory` (hasConfig), `dstu_plugin_config_get` (real schema and values), then
  `dstu_plugin_configure` with complete values: validated and hot-applied, persisted under the manager's revision check.
  `dstu_plugin_set_enabled` hot-loads or unloads a managed plugin. Neither restarts the app.
- Installed plugins run in the app's process. Full trust is not isolation; do not promise code safety from structure
  checks or reversal of filesystem/network/data side effects.
- Failures leave the installed release untouched; faulty installed works are isolated and may recover an earlier approved
  version. Use `dstu_plugin_rollback` for a failed managed work. Revocation keeps sources and packages; restoration
  rechecks retained files without asking a model.
- `dstu_plugin_export` writes a local .dstuplugin only, never publishes. `dstu_plugin_app_restart` only when the user
  explicitly asks for an app restart.
