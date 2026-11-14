// RUST-FIX(RF-P3-workshop-tools): user-confirmed workshop over existing Agent/kernel services.
import { definePlugin } from '../../kernel/api.ts';
import type { DstuPluginInstaller } from '../../kernel/plugin-admin.ts';
import type {} from '../../platform/paths/api.ts';
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

export default definePlugin({
  meta: { id: 'dstu.plugin-workshop', version: '1.0.0', platforms: ['desktop'], provides: ['pluginWorkshop'],
    remote: { pluginWorkshop: ['developmentSkill', 'bindSession', 'propose', 'list', 'status', 'create', 'cancel', 'validate', 'install', 'revoke', 'restore', 'export', 'reportFault'] } },
  inject: ['paths', 'agentTools', 'chatSession', 'chatPipeline', 'dstuPluginInstaller'],
  async apply(ctx) {
    const operations = new WorkshopOperations({ ...ctx.app, dataDir: ctx.paths.appDataDir });
    const installer: DstuPluginInstaller = ctx.dstuPluginInstaller;
    operations.bindAdmin(installer);
    // App process lifecycle belongs to the shell; plugin install/config never needs a restart.
    operations.bindRestart(() => ctx.shell.request('plugin:process|restart'));
    await operations.ready();
    const catalog = new WorkshopCatalog(() => installer.plugins());
    // Registration is owned by this builtin. Agent dispatch may run in chat's fiber, not this one.
    const executor = new WorkshopToolExecutor(operations, catalog);
    operations.bindGeneration(new PipelineWorkshopGeneration(ctx.chatSession, ctx.chatPipeline, executor));
    // Publish only a frozen dispatcher, not the private operations or a transferable owner-run function.
    const dispatcher: AgentToolExecutor = Object.freeze({
      name: Object.freeze(() => executor.name()), canHandle: Object.freeze((name: string) => executor.canHandle(name)),
      sensitivityLevel: Object.freeze((name: string) => executor.sensitivityLevel(name)),
      concurrencyClass: Object.freeze(() => executor.concurrencyClass()), schemaTools: Object.freeze(() => executor.schemaTools()),
      execute: Object.freeze((call: unknown, context: unknown) => pluginExecution.run(ctx.fiber, () => executor.execute(call as ToolCall, context as ExecutionContext))),
    });
    const tools = ctx.agentTools.registerToolExecutors([dispatcher]);
    ctx.effect(() => () => { tools.dispose(); operations.dispose(); });
    // Plain facade: private compiler/admin/generation ports are not remotely reachable.
    const facade: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    facade.developmentSkill = Object.freeze(async (...args: unknown[]) => {
      consumeWorkshopUiReceipt(args.pop(), 'pluginWorkshop', 'developmentSkill');
      return { ...await developmentSkillResource(args[0] === true), schemaToolIds: executor.schemaTools().map(tool => tool.id) };
    });
    for (const method of ['bindSession', 'propose', 'list', 'status', 'create', 'cancel', 'validate', 'install', 'revoke', 'restore', 'export', 'reportFault'] as const) {
      facade[method] = Object.freeze(async (...args: unknown[]) => {
        const context = consumeWorkshopUiReceipt(args.pop(), 'pluginWorkshop', method);
        return (operations[method] as (...params: unknown[]) => Promise<unknown>).apply(operations, [...args, context]);
      });
    }
    ctx.provide('pluginWorkshop', Object.freeze(facade));
  },
});
