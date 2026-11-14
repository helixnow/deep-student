import { describe, expect, it } from 'vitest';
import {
  EXTENSION_PLUGIN_ORDER,
  ExtensionRegistry,
  type ExtensionInstallers,
} from '../extensions.ts';
import { Disposer, Slot, SlotOccupied } from '../primitives.ts';

function logger() {
  const errors: string[] = [];
  return { errors, error: (message: string) => void errors.push(message) };
}

function allInstallers(log: string[]): ExtensionInstallers {
  return Object.fromEntries(EXTENSION_PLUGIN_ORDER.map(name => [
    name,
    (scope: { add(disposer: Disposer): void }) => {
      log.push(`apply ${name}`);
      scope.add(new Disposer(() => void log.push(`undo ${name}`)));
    },
  ])) as ExtensionInstallers;
}

describe('src/extensions.rs composition root', () => {
  it('applies the explicit ordered plugin list and is idempotent by name', () => {
    const log: string[] = [];
    const registry = new ExtensionRegistry();
    const installers = allInstallers(log);
    const first = registry.register(installers, logger());
    const second = registry.register(installers, logger());

    expect(first.applied).toEqual([...EXTENSION_PLUGIN_ORDER]);
    expect(first.missing).toEqual([]);
    expect(second.applied).toEqual([]);
    expect(log).toEqual(EXTENSION_PLUGIN_ORDER.map(name => `apply ${name}`));
    expect(registry.appliedNames()).toEqual([...EXTENSION_PLUGIN_ORDER]);
    registry.dispose();
  });

  it('keeps earlier successes on failure, rolls back the failed scope and retries later', () => {
    const log: string[] = [];
    const registry = new ExtensionRegistry();
    let fail = true;
    const standard = allInstallers(log);
    const installers: ExtensionInstallers = {
      web_search_fallback: standard.web_search_fallback,
      memory_vfs: (scope) => {
        log.push('apply memory_vfs');
        scope.add(new Disposer(() => void log.push('undo memory_vfs')));
        if (fail) throw new Error('boom');
      },
      memory_mastery: standard.memory_mastery,
    };
    const errors = logger();
    const failed = registry.register(installers, errors);

    expect(failed.applied).toEqual(['web_search_fallback']);
    expect(failed.failure?.name).toBe('memory_vfs');
    // Rust `apply_all` stops at the first error; later installers are retried next call.
    expect(failed.missing).toEqual([]);
    expect(log).toEqual(['apply web_search_fallback', 'apply memory_vfs', 'undo memory_vfs']);
    expect(errors.errors[0]).toContain('plugin `memory_vfs` failed: boom');

    fail = false;
    const retried = registry.register(installers, logger());
    expect(retried.failure).toBeNull();
    expect(retried.applied).toEqual(['memory_vfs', 'memory_mastery']);
    expect(registry.appliedNames()).toEqual(['web_search_fallback', 'memory_vfs', 'memory_mastery']);
    registry.dispose();
  });

  it('reports unpublished installers instead of registering empty placeholders', () => {
    const registry = new ExtensionRegistry();
    const errors = logger();
    const result = registry.register({ web_search_fallback: () => undefined }, errors);
    expect(result.applied).toEqual(['web_search_fallback']);
    expect(result.missing).toEqual([...EXTENSION_PLUGIN_ORDER].slice(1));
    expect(errors.errors[0]).toContain('installers not published yet');
    registry.dispose();
  });

  it('treats an occupied slot as already installed, like the Rust plugins', () => {
    const slot = new Slot<string>();
    const existing = slot.provide('first');
    const registry = new ExtensionRegistry();
    const result = registry.register({
      web_search_fallback: (scope) => {
        try {
          scope.add(slot.provide('second'));
        } catch (error) {
          if (!(error instanceof SlotOccupied)) throw error;
        }
      },
    }, logger());

    expect(result.failure).toBeNull();
    expect(slot.get()).toBe('first');
    existing.dispose();
    expect(slot.isOccupied()).toBe(false);
    registry.dispose();
  });

  it('does not share state between registries', () => {
    const first = new ExtensionRegistry();
    const second = new ExtensionRegistry();
    first.register({ web_search_fallback: () => undefined }, logger());
    expect(second.appliedNames()).toEqual([]);
    first.dispose();
    second.dispose();
  });
});
