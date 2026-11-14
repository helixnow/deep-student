/** Plugin composition kernel. No React, Tauri, Node, database or domain imports. */
export interface PluginManifest {
  id: string;
  apiVersion: 1;
  provides: string[];
  requires: string[];
}
export interface InvocationContext {
  signal: AbortSignal;
  emit(event: unknown): void;
}
export interface MethodContract {
  input(value: unknown): void;
  output(value: unknown): void;
  event?(value: unknown): void;
}
export type Handler = (input: unknown, context: InvocationContext) => Promise<unknown>;
export interface PluginContext {
  use<T>(service: string): T;
  call<T>(service: string, method: string, input: unknown, options?: { signal?: AbortSignal; onEvent?: (event: unknown) => void }): Promise<T>;
  provide(service: string, handlers: Record<string, Handler>): void;
  provideValue<T>(service: string, value: T): void;
  effect(dispose: () => void | Promise<void>): void;
}
export interface PluginDefinition {
  manifest: PluginManifest;
  activate(context: PluginContext): void | Promise<void>;
}
export class PluginError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
interface Mounted {
  manifest: PluginManifest;
  state: 'starting' | 'running' | 'stopping';
  disposers: Array<() => void | Promise<void>>;
  calls: Map<Promise<unknown>, AbortController>;
}
interface Provider {
  owner: Mounted;
  value?: unknown;
  contracts?: Record<string, MethodContract>;
  handlers?: Record<string, Handler>;
}

export class PluginHost {
  private plugins = new Map<string, Mounted>();
  private services = new Map<string, Provider>();
  private readonly contracts: Readonly<Record<string, Readonly<Record<string, MethodContract>>>>;

  constructor(contracts: Readonly<Record<string, Readonly<Record<string, MethodContract>>>> = {}) {
    this.contracts = Object.freeze(Object.fromEntries(Object.entries(contracts).map(([key, methods]) => [
      key, Object.freeze(Object.fromEntries(Object.entries(methods).map(([name, contract]) => [name, Object.freeze({ ...contract })]))),
    ])));
  }

  has(service: string): boolean { return this.services.get(service)?.owner.state === 'running'; }

  async install(plugin: PluginDefinition): Promise<void> {
    const manifest: PluginManifest = {
      ...plugin.manifest, provides: [...plugin.manifest.provides], requires: [...plugin.manifest.requires],
    };
    if (manifest.apiVersion !== 1) throw new PluginError('api_version', `Unsupported plugin API: ${manifest.id}`);
    if (this.plugins.has(manifest.id)) throw new PluginError('plugin_exists', manifest.id);
    for (const key of manifest.requires) this.provider(key);
    for (const key of manifest.provides) {
      if (this.services.has(key)) throw new PluginError('provider_exists', key);
    }
    const owner: Mounted = { manifest, state: 'starting', disposers: [], calls: new Map() };
    this.plugins.set(manifest.id, owner);
    const register = (key: string, provider: Provider) => {
      if (owner.state !== 'starting') throw new PluginError('activation_closed', manifest.id);
      if (!manifest.provides.includes(key)) throw new PluginError('undeclared_provision', key);
      if (this.services.has(key)) throw new PluginError('provider_exists', key);
      this.services.set(key, provider);
      owner.disposers.push(() => { if (this.services.get(key) === provider) this.services.delete(key); });
    };
    try {
      await plugin.activate({
        use: <T>(key: string): T => {
          if (!manifest.requires.includes(key)) throw new PluginError('undeclared_dependency', key);
          const provider = this.provider(key);
          if (provider.contracts) throw new PluginError('use_rpc_client', key);
          return provider.value as T;
        },
        call: <T>(key: string, method: string, input: unknown, options: { signal?: AbortSignal; onEvent?: (event: unknown) => void } = {}): Promise<T> => {
          if (owner.state !== 'running') return Promise.reject(new PluginError('plugin_busy', manifest.id));
          if (!manifest.requires.includes(key)) return Promise.reject(new PluginError('undeclared_dependency', key));
          const controller = new AbortController();
          const abort = () => controller.abort(options.signal?.reason);
          if (options.signal?.aborted) abort(); else options.signal?.addEventListener('abort', abort, { once: true });
          const call = this.call<T>(key, method, input, { ...options, signal: controller.signal }).finally(() => {
            options.signal?.removeEventListener('abort', abort);
            owner.calls.delete(call);
          });
          owner.calls.set(call, controller);
          return call;
        },
        provide: (key, handlers) => {
          const contracts = this.contracts[key];
          if (!contracts) throw new PluginError('contract_missing', key);
          if (Object.keys(contracts).some((name) => !handlers[name]) || Object.keys(handlers).some((name) => !contracts[name])) {
            throw new PluginError('method_contract_mismatch', key);
          }
          register(key, { owner, contracts: { ...contracts }, handlers: { ...handlers } });
        },
        provideValue: (key, value) => {
          if (this.contracts[key]) throw new PluginError('rpc_contract_required', key);
          register(key, { owner, value });
        },
        effect: (dispose) => {
          if (owner.state !== 'starting') throw new PluginError('activation_closed', manifest.id);
          owner.disposers.push(dispose);
        },
      });
      for (const key of manifest.provides) {
        if (this.services.get(key)?.owner !== owner) throw new PluginError('missing_provision', key);
      }
      // Dependencies can be stopped while an async activation is running.
      for (const key of manifest.requires) this.provider(key);
      owner.state = 'running';
    } catch (error) {
      const failures = await this.disposeEffects(owner);
      this.plugins.delete(manifest.id);
      if (failures.length) throw new AggregateError([error, ...failures], `Plugin activation failed: ${String(error)}`);
      throw error;
    }
  }

  private provider(service: string): Provider {
    const provider = this.services.get(service);
    if (!provider || provider.owner.state !== 'running') throw new PluginError('service_unavailable', service);
    return provider;
  }

  call<T>(service: string, method: string, input: unknown, options: { signal?: AbortSignal; onEvent?: (event: unknown) => void } = {}): Promise<T> {
    let provider: Provider;
    try { provider = this.provider(service); } catch (error) { return Promise.reject(error); }
    const contract = provider.contracts?.[method];
    const handler = provider.handlers?.[method];
    if (!contract || !handler) return Promise.reject(new PluginError('method_unavailable', `${service}.${method}`));
    try { contract.input(input); } catch (error) { return Promise.reject(error); }
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort(); else options.signal?.addEventListener('abort', abort, { once: true });
    const call = Promise.resolve().then(() => handler(input, {
      signal: controller.signal,
      emit: (event) => {
        if (!contract.event) throw new PluginError('events_undeclared', `${service}.${method}`);
        contract.event(event);
        options.onEvent?.(event);
      },
    })).then((output) => { contract.output(output); return output as T; }).finally(() => {
      options.signal?.removeEventListener('abort', abort);
      provider.owner.calls.delete(call);
    });
    provider.owner.calls.set(call, controller);
    return call;
  }

  async unload(id: string): Promise<void> {
    const owner = this.plugins.get(id);
    if (!owner) return;
    if (owner.state !== 'running') throw new PluginError('plugin_busy', id);
    for (const other of this.plugins.values()) {
      if (other !== owner && other.manifest.requires.some((key) => owner.manifest.provides.includes(key))) {
        throw new PluginError('dependents_active', `${other.manifest.id} requires ${id}`);
      }
    }
    owner.state = 'stopping';
    for (const controller of owner.calls.values()) controller.abort(new PluginError('plugin_stopping', id));
    // Cooperative calls retain their provider until their cleanup completes.
    await Promise.allSettled([...owner.calls.keys()]);
    const errors = await this.disposeEffects(owner);
    this.plugins.delete(id);
    if (errors.length) throw new AggregateError(errors, `Plugin cleanup failed: ${id}`);
  }

  private async disposeEffects(owner: Mounted): Promise<unknown[]> {
    const errors: unknown[] = [];
    while (owner.disposers.length) {
      try { await owner.disposers.pop()!(); } catch (error) { errors.push(error); }
    }
    return errors;
  }

  async dispose(): Promise<void> {
    const errors: unknown[] = [];
    for (const id of [...this.plugins.keys()].reverse()) {
      try { await this.unload(id); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Plugin host cleanup failed');
  }
}
