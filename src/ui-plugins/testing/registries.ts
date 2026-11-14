/**
 * In-memory stand-ins for the three application registries behind `ctx.ui.commands`, `ctx.ui.chat.registerBlock` and
 * `ctx.ui.workbench.registerApp`. Production passes the real singletons (ui-kernel/bootstrap.ts); test kernels that
 * install the official plugins need the same adapters, with the same contract: duplicate keys are rejected and a revoke
 * removes only its own registration.
 */
import type { UiAdapters } from '../../ui-kernel/kernel';

function keyedRegistry<T>(kind: string, keyOf: (value: T) => string) {
  const entries = new Map<string, T>();
  const listeners = new Set<() => void>();
  const emit = () => { for (const listener of [...listeners]) listener(); };
  return {
    register(value: T): () => void {
      const key = keyOf(value);
      if (entries.has(key)) throw new Error(`${kind} "${key}" is already registered; use an id of your own`);
      entries.set(key, value);
      emit();
      return () => {
        if (entries.get(key) !== value) return;
        entries.delete(key);
        emit();
      };
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    list: () => [...entries.values()],
    get: (key: string) => entries.get(key),
  };
}

export function memoryRegistryAdapters(): Required<Pick<UiAdapters, 'commands' | 'chatBlocks' | 'workbenchApps'>> {
  const blocks = keyedRegistry<{ type: string; renderer: unknown }>('chat block type', (entry) => entry.type);
  return {
    commands: keyedRegistry<{ id: string } & Record<string, unknown>>('command', (command) => command.id),
    chatBlocks: {
      register: (type, renderer) => blocks.register({ type, renderer }),
      subscribe: blocks.subscribe,
      list: () => blocks.list().map((entry) => entry.renderer),
      get: (type) => blocks.get(type)?.renderer,
    },
    workbenchApps: keyedRegistry<{ typeId: string } & Record<string, unknown>>('workbench app', (def) => def.typeId),
  };
}
