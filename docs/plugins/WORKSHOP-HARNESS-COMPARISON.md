# Plugin Workshop and DeepSeek Harness

## Executive summary

Deep Student's Workshop is a managed, security-sensitive creator flow layered on
Cordis: the Host owns source roots, esbuild, package transactions and the user
profile; the Agent supplies SDK-informed source. DeepSeek Harness takes the more
general approach that everything is a Cordis plugin and lets Creator mode use
Plugin Manager to install durable bundles. The important shared idea is that
plugin effects belong to a disposable lifecycle, not to an untracked process.

Workshop now follows the same agent loop while retaining the stronger local
confirmation boundary: discover APIs, write managed files, compile and test-load,
feed exact diagnostics into bounded repair passes, freeze a candidate, then one
paired UI confirmation installs and activates it. The profile and retained
version directory make the result survive restart.

## Comparison

| Area | Deep Student Workshop | DeepSeek Harness / Cordis |
|---|---|---|
| Architecture | Builtin Workshop plugin plus Host PluginAdmin and UI kernel; generated Host/UI package | Everything is a Cordis plugin; Loader composes a profile/bundle tree |
| Discovery | `dstu_plugin_api_list/read` exposes exact SDK, services, slots, examples and schemas | `cordis_inspect_list/query` exposes Host and connected Client providers, live Loader entries and Config schemas |
| Authoring | Agent output is JSON files written only below a Host-assigned managed root | Creator writes bundle/package files and a profile patch, then Plugin Manager installs it |
| Build/debug | Host-owned esbuild and real Host lifecycle self-check; up to three diagnostic repair passes | Package manager/build validation; agent can inspect activation diagnostics and retry |
| Approval | Proposal, generated candidate, then explicit paired UI confirmation; Agent never receives install authority | `plugin_manager` is privileged and requires danger-full-access or per-call approval |
| Live update | Confirmed Workshop install enables and hot-loads the package; profile persists for restart | HMR recomposes live profiles; non-HMR changes may report restart-required |
| Lifecycle | Cordis fibers/effects dispose registrations; Host isolates failed `apply` entries | Fiber state PENDING → LOADING → ACTIVE/FAILED and unload disposal; Loader/HMR replaces trees |
| Recovery | Compile/test gate, package/profile transaction rollback, retained `lastGoodPackageDir`, startup degraded isolation, UI error budget circuit breaker | Install snapshots manifests/lockfiles; failed activation reports diagnostics; HMR removes/reloads instances |

## Autonomous Workshop loop

Workshop mode adds three managed tools in addition to the existing six:

* `dstu_plugin_diagnose` reads the exact managed source, candidate status,
  build attempt, retained version and live Host inventory.
* `dstu_plugin_write_source` validates every path and writes only files below the
  conversation-owned source directory. It cannot edit profiles, installed
  packages or arbitrary filesystem paths.
* `dstu_plugin_rollback` asks the Host to recover the previous approved release.

The normal loop is `api_list → api_read → propose(autoGenerate: true)`. The
explicit creation request starts generation without an extra Create click;
manual proposals still support the existing Create action. Generation seeds a
template, asks the Agent for JSON file contents, compiles Host and UI with the
Host-owned esbuild configuration, and runs a real isolated Host install/unload
self-check. A failed pass records its exact diagnostics and is offered to the
next generation prompt. Three passes bound runaway repair; success snapshots
source and build bytes into a frozen candidate. The UI confirmation then calls
the manager transaction, activates the package immediately, and keeps the
profile entry and retained source/package for the next process.

## Fault protection and rollback

1. **Compile/test gate.** Manifest screening, source containment, esbuild and
   Host `apply`/unload all have to pass before a candidate can be confirmed.
2. **Install transaction.** PluginAdmin writes package storage and
   `user.profile.json` through its revisioned transaction. Failure restores the
   prior package, consent and runtime where possible.
3. **Activation recovery.** Workshop records the last running version and its
   retained package directory. A failed activation is reported to the card and
   the prior version is restored; `reportFault` isolates a degraded managed
   plugin before requesting recovery.
4. **Startup safety.** `loadStartupProfile` falls back to the official profile
   when the user profile itself is malformed, while `installProfile` isolates a
   plugin whose dependency or `apply` fails. Electron's Host supervisor bounds
   restart attempts and offers a user-confirmed safe-mode restart. This existing
   fallback is not an automatic crash-loop quarantine of an identified plugin.
5. **UI circuit breaker.** `UiErrorBudget` counts community render/report
   failures. `SlotBoundary` and related UI services report failures; exhausting
   the budget unloads the plugin. The Workshop integration observes the disabled
   plugin, stores the diagnostic and invokes managed isolation/recovery. This
   keeps a broken view from taking down the UI and gives the Agent an exact
   repair/rollback path.

## Deliberate boundaries

Neither system is a sandbox for trusted same-process plugin code. Workshop's
path and manifest checks prevent accidental authority escalation and stale
candidate installation; they cannot undo arbitrary side effects already made by
plugin code. The Agent can repair source and inspect failures, but only the
paired user UI authorizes live installation. Generation and validation execute
test-Host code and therefore are not read-only operations. Visual verification remains explicit: a
successful Host check does not claim that a UI was visually reviewed.

Full-process crashes, infinite loops and native faults cannot be caught by an
in-process test Host or SlotBoundary. Absolute “never blocks the app” protection
requires out-of-process execution/watchdogs; this change does not provide it.
Community (non-Workshop) UI plugins retain the existing UI-only circuit breaker;
the new persistent Host recovery bridge intentionally handles Workshop-owned
packages only. Esbuild validates syntax/bundling, not all TypeScript types.

## Minimal profile test wiring

The desktop memory/VFS wiring test previously loaded the complete desktop
profile without creating PluginAdmin. Workshop correctly degraded with
`SERVICE_MISSING: dstuPluginInstaller`: that capability is intentionally scoped
to builtin plugins, not a root service. The fixture now registers the real
PluginAdmin before loading the profile, matching `connection.ts` bootstrap.
No optional injection or globally accessible installer bypass was introduced.

## References

* `host/plugins/plugin-workshop/src/compiler.ts`, `generation.ts`, `operations.ts`
* `host/kernel/plugin-admin.ts`, `profile.ts`, `profile-install.ts`, `runtime.ts`
* `src/ui-kernel/services/errors.ts`, `src/ui-kernel/react/SlotBoundary.tsx`
* [Harness API inspection](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/extensions/tool-cordis/README.md)
* [Harness Plugin Manager](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/plugin-manager/README.md)
* [Cordis lifecycle/HMR](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/framework/index.md)

Research checked the upstream documentation on 2026-11-08 and the installed
`@deepseek-ai/cordis` 4.0.5 sources. Upstream master is moving; in particular its
Plugin Manager documents that a failed HMR replacement may leave the previous
version no longer running, rather than promising automatic version rollback.
