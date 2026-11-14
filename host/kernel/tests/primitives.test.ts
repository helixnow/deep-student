import { describe, expect, it } from 'vitest';
import { Disposer, HookSet, HookKernel, Slot, SlotOccupied, Scope, ScopedPluginHost, ScopedPluginError } from '../primitives.ts';

describe('dstu-kernel', () => {
  it('drop_runs_once', () => {
    let runs = 0;
    { using disposer = new Disposer(() => runs++); expect(disposer.isActive()).toBe(true); }
    expect(runs).toBe(1);
  });
  it('explicit_dispose_does_not_run_twice', () => {
    let runs = 0;
    { using disposer = new Disposer(() => runs++); disposer.dispose(); }
    expect(runs).toBe(1);
  });
  it('registers_in_order_and_removes_by_disposer', () => {
    const hooks = new HookSet<string>();
    const a = hooks.register('a'); hooks.register('b'); hooks.register('c');
    expect(hooks.snapshot()).toEqual(['a', 'b', 'c']); a.dispose();
    expect(hooks.len()).toBe(2); expect(hooks.snapshot()).toEqual(['b', 'c']);
  });
  it('snapshot_isolated_from_later_removals', () => {
    const hooks = new HookSet<string>();
    const a = hooks.register('a'), b = hooks.register('b');
    const snapshot = hooks.snapshot(); a.dispose(); b.dispose();
    expect(hooks.isEmpty()).toBe(true); expect(snapshot).toEqual(['a', 'b']);
  });
  it('callback_may_register_without_deadlock', () => {
    const hooks = new HookSet<{ name: string; onEvent?: () => void }>();
    hooks.register({ name: 'reentrant', onEvent: () => { hooks.register({ name: 'extra' }); } });
    for (const hook of hooks.snapshot()) hook.onEvent?.();
    expect(hooks.len()).toBe(2);
  });
  it('first_registration_wins', () => {
    const slot = new Slot<number>(); expect(slot.isOccupied()).toBe(false); expect(slot.get()).toBeUndefined();
    slot.provide(1); expect(slot.isOccupied()).toBe(true); expect(slot.get()).toBe(1);
    expect(() => slot.provide(2)).toThrow(SlotOccupied); expect(slot.get()).toBe(1);
  });
  it('dropping_disposer_frees_the_slot_for_a_new_provider', () => {
    const slot = new Slot<number>(); { using first = slot.provide(1); }
    expect(slot.isOccupied()).toBe(false); slot.provide(7); expect(slot.get()).toBe(7);
  });
  it('replace_invalidates_the_old_disposer', () => {
    const slot = new Slot<number>(), old = slot.provide(1); slot.replace(2);
    expect(slot.get()).toBe(2); old.dispose(); expect(slot.get()).toBe(2);
  });
  it('replace_disposer_clears_the_replacement', () => {
    const slot = new Slot<number>(); slot.provide(1); slot.replace(2).dispose(); expect(slot.isOccupied()).toBe(false);
  });
  it('kernel_band_always_runs_before_default_band', () => {
    const kernel = new HookKernel<string>(); kernel.addDefault('default_a'); kernel.addKernel('kernel'); kernel.addDefault('default_b');
    const seen: string[] = []; kernel.observe(h => seen.push(h)); expect(seen).toEqual(['kernel', 'default_a', 'default_b']);
  });
  it('default_band_follows_registration_order_and_is_removable', () => {
    const kernel = new HookKernel<string>(), first = kernel.addDefault('first'); kernel.addDefault('second');
    expect(kernel.defaultLen()).toBe(2); first.dispose(); const seen: string[] = []; kernel.observe(h => seen.push(h)); expect(seen).toEqual(['second']);
  });
  it('gate_stops_at_first_block_and_skips_later_bands', () => {
    const kernel = new HookKernel<string>(); kernel.addKernel('approval_gate'); kernel.addDefault('task_audit');
    const ran: string[] = [];
    expect(kernel.gate(h => { ran.push(h); return h === 'approval_gate' ? { block: 'blocked by kill switch' } : undefined; })).toBe('blocked by kill switch');
    expect(ran).toEqual(['approval_gate']); ran.length = 0;
    expect(kernel.gate(h => { ran.push(h); return undefined; })).toBeUndefined(); expect(ran).toEqual(['approval_gate', 'task_audit']);
  });
  it('waterfall_threads_context_in_band_order', () => {
    const kernel = new HookKernel<string>(); kernel.addDefault('default'); kernel.addKernel('kernel'); let calls = 0;
    expect(kernel.waterfall<string[]>([], (h, seen) => { calls++; seen.push(h); })).toEqual(['kernel', 'default']); expect(calls).toBe(2);
  });
  it('gate_returns_none_when_empty', () => { expect(new HookKernel().gate(() => undefined)).toBeUndefined(); });
  it('throwing_visitor_leaves_hook_registry_usable', () => {
    // Host 的异常后可用性保证：HookSet/HookKernel 不执行锁定，visitor 抛错只向调用方传播，
    // 注册表内容不变，后续仍可 observe/gate/waterfall 与继续注册。
    const kernel = new HookKernel<string>();
    kernel.addKernel('a');
    expect(() => kernel.observe(() => { throw new Error('boom'); })).toThrow('boom');
    const seen: string[] = [];
    kernel.observe(hook => seen.push(hook));
    expect(seen).toEqual(['a']);
    const added = kernel.addDefault('b');
    const after: string[] = [];
    kernel.waterfall(after, (hook, list) => list.push(hook));
    expect(after).toEqual(['a', 'b']);
    added.dispose();
  });
  const tracking = (name: string, steps: string[], fail: boolean, log: string[]) => ({ name, apply(scope: Scope) {
    for (const step of steps) { scope.add(new Disposer(() => { log.push(`undo ${name}:${step}`); })); log.push(`apply ${name}:${step}`); }
    if (fail) throw new ScopedPluginError('mislabeled', 'boom');
  } });
  it('apply_is_idempotent_by_name', () => {
    const log: string[] = [], host = new ScopedPluginHost(), plugin = tracking('p', ['a'], false, log);
    expect(host.apply(plugin)).toBe(true); expect(host.apply(plugin)).toBe(false); expect(host.len()).toBe(1);
    expect(host.appliedNames()).toEqual(['p']); expect(log).toEqual(['apply p:a']); host.unloadAll();
  });
  it('failed_apply_rolls_back_in_reverse_order_and_carries_plugin_name', () => {
    const log: string[] = [], host = new ScopedPluginHost();
    expect(() => host.apply(tracking('failing', ['a', 'b'], true, log))).toThrow('plugin `failing` failed: boom');
    expect(host.contains('failing')).toBe(false); expect(host.isEmpty()).toBe(true);
    expect(log).toEqual(['apply failing:a', 'apply failing:b', 'undo failing:b', 'undo failing:a']);
  });
  it('failed_apply_reparents_non_plugin_errors_to_the_failing_plugin', () => {
    const host = new ScopedPluginHost();
    const raw = new Error('raw failure');
    expect(() => host.apply({ name: 'raw', apply: () => { throw raw; } })).toThrow('plugin `raw` failed: raw failure');
    expect(host.isEmpty()).toBe(true);
  });
  it('unload_rolls_back_in_reverse_order', () => {
    const log: string[] = [], host = new ScopedPluginHost(); expect(host.apply(tracking('p', ['a', 'b', 'c'], false, log))).toBe(true);
    log.length = 0; expect(host.unload('p')).toBe(true); expect(host.unload('p')).toBe(false); expect(log).toEqual(['undo p:c', 'undo p:b', 'undo p:a']);
  });
  it('apply_all_keeps_explicit_order_and_stops_at_failure', () => {
    const log: string[] = [], host = new ScopedPluginHost();
    expect(() => host.applyAll([tracking('first', ['a'], false, log), tracking('failing', ['b'], true, log), tracking('last', ['c'], false, log)])).toThrow('plugin `failing` failed: boom');
    expect(host.contains('first')).toBe(true); expect(host.contains('failing')).toBe(false); expect(host.contains('last')).toBe(false);
    expect(log).toEqual(['apply first:a', 'apply failing:b', 'undo failing:b']); host.unloadAll();
  });
  it('duplicate_names_in_one_batch_apply_once', () => {
    let calls = 0; const host = new ScopedPluginHost(), p = { name: 'counting', apply: () => { calls++; } };
    expect(host.applyAll([p, { ...p }])).toBe(1); expect(calls).toBe(1); expect(host.len()).toBe(1); host.unloadAll();
  });
  it('unload_all_uses_host_order_and_rolls_back_each_scope', () => {
    const log: string[] = [], host = new ScopedPluginHost(); host.apply(tracking('first', ['a'], false, log)); host.apply(tracking('second', ['b'], false, log));
    log.length = 0; host.unloadAll(); expect(host.isEmpty()).toBe(true); expect(log).toEqual(['undo second:b', 'undo first:a']);
  });
});
