// RUST-FIX(RF-P3-workshop-tools): user-confirmed workshop over existing Agent/kernel services.
import { definePlugin } from '../../kernel/api.ts';
import type { DstuPluginInstaller } from '../../kernel/plugin-admin.ts';
import type {} from '../../platform/paths/api.ts';
import type { StartupFinalizerOptions } from '../../platform/storage/api.ts';
import type {} from '../agent-skills/api.ts';
import type {} from '../chat/api.ts';
import type {} from '../chat-pipeline/api.ts';
import { WorkshopOperations } from './src/operations.ts';
import { WorkshopCatalog } from './src/catalog.ts';
import { WorkshopToolExecutor } from './src/tools.ts';
import { PipelineWorkshopGeneration } from './src/generation.ts';
import { developmentSkillResource } from './src/resources.ts';
import { consumeWorkshopUiReceipt } from '../../kernel/workshop-ui-authority.ts';
import { pluginExecution } from '../../kernel/plugin-execution.ts';
import type { AgentToolExecutor } from '../agent-skills/api.ts';
import type { ToolCall, ExecutionContext } from '../chat/api.ts';
import type { HttpService } from '../../platform/http/api.ts';
import { settingUrlProblem, type WorkshopLinkReader } from './src/settings.ts';
import { pluginSecretSettingsKey } from '../plugin-services/api.ts';

/** Calendar-address check: one HTTPS GET through the pinned public transport, redirects only within the same host. */
function linkReader(http: () => HttpService | null): WorkshopLinkReader {
  return async (raw, signal) => {
    const service = http();
    if (!service) throw new Error('this Host has no HTTP service');
    const host = new URL(raw).hostname;
    let current = raw;
    for (let hop = 0; ; hop++) {
      const problem = settingUrlProblem(current);
      if (problem) throw new Error(problem);
      if (new URL(current).hostname !== host) throw new Error(`it redirects to another site (${new URL(current).hostname})`);
      const response = await service.fetchBytes(current, { method: 'GET', destination: 'public-pinned', redirect: 'manual', signal,
        timeoutMs: 20_000, maxBytes: 1024 * 1024, headers: { accept: 'text/calendar, text/*;q=0.8, */*;q=0.1' } });
      const location = response.headers.location;
      if (response.status >= 300 && response.status < 400 && location !== undefined) {
        if (hop >= 3) throw new Error('too many redirects');
        current = new URL(location, current).href;
        continue;
      }
      return { status: response.status, ok: response.ok, text: new TextDecoder('utf-8').decode(response.bytes) };
    }
  };
}

export default definePlugin({
  meta: { id: 'dstu.plugin-workshop', version: '1.0.0', platforms: ['desktop'], provides: ['pluginWorkshop'],
    remote: { pluginWorkshop: ['developmentSkill', 'bindSession', 'propose', 'list', 'status', 'create', 'cancel', 'validate', 'install', 'revoke', 'restore', 'export', 'reportFault', 'reportValidation', 'discard', 'redo', 'reduce'] } },
  inject: ['paths', 'agentTools', 'chatSession', 'chatPipeline', 'dstuPluginInstaller'],
  async apply(ctx) {
    const operations = new WorkshopOperations({ ...ctx.app, dataDir: ctx.paths.appDataDir });
    const installer: DstuPluginInstaller = ctx.dstuPluginInstaller;
    operations.bindAdmin(installer);
    // App process lifecycle belongs to the shell; plugin install/config never needs a restart.
    operations.bindRestart(() => ctx.shell.request('plugin:process|restart'));
    const catalog = new WorkshopCatalog(() => installer.plugins(), undefined, name => ctx.get(name) !== undefined);
    // Registration is owned by this builtin. Agent dispatch may run in chat's fiber, not this one.
    const executor = new WorkshopToolExecutor(operations, catalog);
    operations.bindGeneration(new PipelineWorkshopGeneration(ctx.chatSession, ctx.chatPipeline, executor, ctx.backendEvents));
    operations.bindCandidatePreview(candidate => ctx.backendEvents.emitTo({ kind: 'Window', label: 'main' }, 'plugin-workshop:verify-candidate', candidate));
    operations.bindLinkReader(linkReader(() => (ctx.get('http') as HttpService | undefined) ?? null));
    // Card secrets: the same secure-store key pluginSecrets.get(key) reads for that plugin.
    operations.bindSecretStore(async (pluginId, key, value) => {
      const settings = ctx.get('settings') as { saveSecret(key: string, value: string): Promise<unknown> } | undefined;
      if (!settings) throw new Error('WORKSHOP_SETTING_INVALID: the settings service is not available');
      await settings.saveSecret(pluginSecretSettingsKey(pluginId, key), value);
    });
    // Publish only a frozen dispatcher, not the private operations or a transferable owner-run function.
    const dispatcher: AgentToolExecutor = Object.freeze({
      name: Object.freeze(() => executor.name()), canHandle: Object.freeze((name: string) => executor.canHandle(name)),
      sensitivityLevel: Object.freeze((name: string) => executor.sensitivityLevel(name)),
      concurrencyClass: Object.freeze(() => executor.concurrencyClass()), schemaTools: Object.freeze(() => executor.schemaTools()),
      execute: Object.freeze((call: unknown, context: unknown) => pluginExecution.run(ctx.fiber, () => executor.execute(call as ToolCall, context as ExecutionContext))),
    });
    const tools = ctx.agentTools.registerToolExecutors([dispatcher]);
    const startup = new AbortController();
    ctx.effect(() => () => { startup.abort(); tools.dispose(); operations.dispose(); });
    // Plain facade: private compiler/admin/generation ports are not remotely reachable.
    const facade: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    facade.developmentSkill = Object.freeze(async (...args: unknown[]) => {
      consumeWorkshopUiReceipt(args.pop(), 'pluginWorkshop', 'developmentSkill');
      return { ...await developmentSkillResource(args[0] === true), schemaToolIds: executor.schemaTools().map(tool => tool.id) };
    });
    for (const method of ['bindSession', 'propose', 'list', 'status', 'create', 'cancel', 'validate', 'install', 'revoke', 'restore', 'export', 'reportFault', 'reportValidation', 'discard', 'redo', 'reduce'] as const) {
      facade[method] = Object.freeze(async (...args: unknown[]) => {
        const context = consumeWorkshopUiReceipt(args.pop(), 'pluginWorkshop', method);
        return (operations[method] as (...params: unknown[]) => Promise<unknown>).apply(operations, [...args, context]);
      });
    }
    ctx.provide('pluginWorkshop', Object.freeze(facade));
    // The user profile must finish loading before its running versions can reconcile workshop records.
    const reconcile = () => pluginExecution.run(ctx.fiber, async () => {
      if (startup.signal.aborted) return;
      await operations.ready();
      await operations.resumeDelegated();
    });
    const storage = ctx.get('storage');
    if (typeof storage?.registerFinalizer === 'function') {
      const options: StartupFinalizerOptions & { late: 'run'; signal: AbortSignal } = { late: 'run', signal: startup.signal };
      storage.registerFinalizer('plugin-workshop.reconcile', async () => {
        try { await reconcile(); }
        catch (error) { ctx.logger('plugin-workshop').warn(`Startup reconciliation failed: ${String(error)}`); }
      }, options);
    } else await reconcile();
  },
});
