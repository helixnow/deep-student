/** Ports of dstu-kernel's synchronous registration primitives.
 * Rust Drop is explicit disposal / `using` in JS; ownership never depends on GC.
 */
export class Disposer {
  private action: (() => void) | undefined;
  constructor(action: () => void) { this.action = action; }
  isActive(): boolean { return this.action !== undefined; }
  dispose(): void { const action = this.action; this.action = undefined; action?.(); }
  [Symbol.dispose](): void { this.dispose(); }
}

export class HookSet<T> {
  private entries = new Map<symbol, T>();
  len(): number { return this.entries.size; }
  isEmpty(): boolean { return this.len() === 0; }
  snapshot(): T[] { return [...this.entries.values()]; }
  register(hook: T): Disposer {
    const id = Symbol(); this.entries.set(id, hook);
    return new Disposer(() => { this.entries.delete(id); });
  }
}

export class SlotOccupied extends Error {
  constructor() { super('service slot already occupied'); this.name = 'SlotOccupied'; }
}

export class Slot<T> {
  private entry: { value: T; generation: symbol } | undefined;
  isOccupied(): boolean { return this.entry !== undefined; }
  get(): T | undefined { return this.entry?.value; }
  provide(value: T): Disposer {
    if (this.isOccupied()) throw new SlotOccupied();
    return this.replace(value);
  }
  replace(value: T): Disposer {
    const generation = Symbol(); this.entry = { value, generation };
    return new Disposer(() => { if (this.entry?.generation === generation) this.entry = undefined; });
  }
}

export type GateDecision<R> = { block: R } | undefined;
export class HookKernel<T> {
  private kernel = new HookSet<T>();
  private defaults = new HookSet<T>();
  kernelLen(): number { return this.kernel.len(); }
  defaultLen(): number { return this.defaults.len(); }
  private snapshot(): T[] { return [...this.kernel.snapshot(), ...this.defaults.snapshot()]; }
  addKernel(hook: T): void { this.kernel.register(hook); }
  addDefault(hook: T): Disposer { return this.defaults.register(hook); }
  observe(visit: (hook: T) => void): void { for (const hook of this.snapshot()) visit(hook); }
  gate<R>(check: (hook: T) => GateDecision<R>): R | undefined {
    for (const hook of this.snapshot()) { const result = check(hook); if (result !== undefined) return result.block; }
    return undefined;
  }
  waterfall<C>(context: C, visit: (hook: T, context: C) => void): C {
    for (const hook of this.snapshot()) visit(hook, context);
    return context;
  }
}

export class Scope {
  private disposers: Disposer[] = [];
  add(disposer: Disposer): void { this.disposers.push(disposer); }
  len(): number { return this.disposers.length; }
  isEmpty(): boolean { return this.len() === 0; }
  dispose(): void { while (this.disposers.length) this.disposers.pop()!.dispose(); }
  [Symbol.dispose](): void { this.dispose(); }
}

export interface ScopedPlugin { name: string; apply(scope: Scope): void }
export class ScopedPluginError extends Error {
  readonly plugin: string;
  readonly detail: string;
  constructor(plugin: string, message: string, options?: ErrorOptions) {
    super(`plugin \`${plugin}\` failed: ${message}`, options);
    this.name = 'ScopedPluginError'; this.plugin = plugin; this.detail = message;
  }
}

/** dstu-kernel PluginHost keeps earlier successes on batch failure, unlike profile installAll. */
export class ScopedPluginHost {
  private applied = new Map<string, Scope>();
  len(): number { return this.applied.size; }
  isEmpty(): boolean { return this.len() === 0; }
  contains(name: string): boolean { return this.applied.has(name); }
  appliedNames(): string[] { return [...this.applied.keys()]; }
  apply(plugin: ScopedPlugin): boolean {
    if (this.contains(plugin.name)) return false;
    const scope = new Scope();
    try { plugin.apply(scope); } catch (error) {
      scope.dispose();
      // Rust reparents every PluginError to the plugin that actually failed, so a plugin
      // cannot mislabel itself; non-PluginError throws get wrapped with the same text.
      if (error instanceof ScopedPluginError) throw new ScopedPluginError(plugin.name, error.detail, { cause: error.cause ?? error });
      const detail = error instanceof Error ? error.message : String(error);
      throw new ScopedPluginError(plugin.name, detail, { cause: error });
    }
    this.applied.set(plugin.name, scope); return true;
  }
  applyAll(plugins: Iterable<ScopedPlugin>): number {
    let count = 0; for (const plugin of plugins) if (this.apply(plugin)) count++;
    return count;
  }
  unload(name: string): boolean {
    const scope = this.applied.get(name); if (!scope) return false;
    this.applied.delete(name); scope.dispose(); return true;
  }
  unloadAll(): void { for (const name of this.appliedNames().reverse()) this.unload(name); }
  [Symbol.dispose](): void { this.unloadAll(); }
}
