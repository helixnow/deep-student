/** Scoped builtin capability. Never published in the root service scope. */
import { Service, type Context, type Fiber } from '@deepseek-ai/cordis';
import type { DstuPluginInstaller, ManagedPluginInstallRequest, WorkshopActivationResult } from './plugin-admin.ts';
import type { PluginExecution } from './kernel.ts';
import { PluginLoadError } from './plugin-load-error.ts';

type Binding = { installer: DstuPluginInstaller; owner: () => Fiber | undefined; execution: PluginExecution | undefined };
const bindings = new WeakMap<object, Binding>();

export class BuiltinPluginInstaller extends Service implements DstuPluginInstaller {
  constructor(ctx: Context, installer: DstuPluginInstaller, owner: () => Fiber | undefined, execution: PluginExecution | undefined) {
    super(ctx, 'dstuPluginInstaller');
    bindings.set(ctx, { installer, owner, execution });
  }

  private authorizedBinding(): Binding {
    // RUST-FIX(RF-P1-managed-plugin-install): Cordis binds this.ctx to the actual reader, including get()/child contexts.
    let ctx: Context | null = this.ctx;
    while (ctx) {
      const binding = bindings.get(ctx);
      if (binding) {
        if (this.ctx.fiber === binding.owner() && binding.execution?.current() === binding.owner()) return binding;
        break;
      }
      ctx = Object.getPrototypeOf(ctx) as Context | null;
    }
    throw new PluginLoadError('KERNEL_API_FORBIDDEN', this.ctx.fiber.name, 'dstuPluginInstaller requires an explicitly injected builtin plugin context');
  }

  private authorized(): DstuPluginInstaller { return this.authorizedBinding().installer; }
  activateManaged(id: string, revision: string) { return this.authorized().activateManaged(id, revision); }
  isolateManaged(id: string) { return this.authorized().isolateManaged(id); }
  onFault(listener: (id: string, reason: string) => Promise<void>): () => void {
    const binding = this.authorizedBinding();
    return binding.installer.onFault((id, reason) => binding.execution!.run(binding.owner()!, () => listener(id, reason)));
  }

  installManagedDirectory(request: ManagedPluginInstallRequest) { return this.authorized().installManagedDirectory(request); }
  inventory() { return this.authorized().inventory(); }
  configOf(id: string) { return this.authorized().configOf(id); }
  configureManaged(id: string, values: Record<string, unknown>) { return this.authorized().configureManaged(id, values); }
  setEnabledManaged(id: string, enabled: boolean) { return this.authorized().setEnabledManaged(id, enabled); }
  uninstall(id: string, revision: string) { return this.authorized().uninstall(id, revision); }
  plugins() { return this.authorized().plugins(); }
  onActivation(listener: (result: WorkshopActivationResult) => Promise<void>): () => void {
    const binding = this.authorizedBinding();
    return binding.installer.onActivation(result => binding.execution!.run(binding.owner()!, () => listener(result)));
  }
  selfCheckContext(id: string, names: readonly string[]) { return this.authorized().selfCheckContext(id, names); }
}
