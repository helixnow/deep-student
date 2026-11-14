/** Test driver only: a captured object is not a production execution credential. */
import type { DstuPluginInstaller } from '../../../kernel/plugin-admin.ts';
import type { HostRuntime } from '../../../kernel/runtime.ts';
import { pluginExecution } from '../../../kernel/plugin-execution.ts';

export async function injectedInstaller(runtime: HostRuntime): Promise<DstuPluginInstaller> {
  let installer: DstuPluginInstaller | undefined;
  const id = 'dstu.workshop-test-installer';
  await runtime.install({ name: id, meta: { id }, inject: ['dstuPluginInstaller'], apply(ctx) { installer = ctx.dstuPluginInstaller; } });
  const fiber = runtime.get(id)!.fiber;
  return {
    onFault: listener => pluginExecution.run(fiber, () => installer!.onFault(listener)),
    isolateManaged: id => pluginExecution.run(fiber, () => installer!.isolateManaged(id)),
    activateManaged: (id, revision) => pluginExecution.run(fiber, () => installer!.activateManaged(id, revision)),
    inventory: () => pluginExecution.run(fiber, () => installer!.inventory()),
    configOf: work => pluginExecution.run(fiber, () => installer!.configOf(work)),
    configureManaged: (work, values) => pluginExecution.run(fiber, () => installer!.configureManaged(work, values)),
    setEnabledManaged: (work, enabled) => pluginExecution.run(fiber, () => installer!.setEnabledManaged(work, enabled)),
    plugins: () => pluginExecution.run(fiber, () => installer!.plugins()),
    uninstall: (work, revision) => pluginExecution.run(fiber, () => installer!.uninstall(work, revision)),
    installManagedDirectory: request => pluginExecution.run(fiber, () => installer!.installManagedDirectory(request)),
    onActivation: listener => pluginExecution.run(fiber, () => installer!.onActivation(listener)),
    selfCheckContext: (work, names) => pluginExecution.run(fiber, () => installer!.selfCheckContext(work, names)),
  };
}
