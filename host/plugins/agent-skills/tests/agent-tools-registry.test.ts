import { expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
import plugin from '../index.ts';
import type { AgentToolExecutor } from '../api.ts';
import { AgentToolExecutorRegistry } from '../api.ts';
import { memorySettings, unavailableStorage } from './platform-stubs.ts';
import { definePlugin, Disposer } from '../../../kernel/api.ts';

function executor(name: string, handles: readonly string[]): AgentToolExecutor {
  return {
    name: () => name,
    canHandle: toolName => handles.includes(toolName),
    sensitivityLevel: () => 'medium',
    concurrencyClass: () => 'serial',
  };
}

it('agent_tools_registry_keeps_registration_order_and_appends_duplicate_registrations', () => {
  const registry = new AgentToolExecutorRegistry();
  const first = executor('FirstExecutor', ['first']);
  const second = executor('SecondExecutor', ['second']);
  registry.register([first, second]);
  registry.register([first]);
  expect(registry.all().map(candidate => candidate.name())).toEqual([
    'FirstExecutor', 'SecondExecutor', 'FirstExecutor',
  ]);
});

it('agentTools service publishes executors registered by other plugins', async () => {
  const host = await createTestHost({
    plugins: [pathsPlugin, plugin],
    provide: { settings: memorySettings(), storage: unavailableStorage() },
  });
  try {
    const canvas = executor('CanvasToolExecutor', ['builtin-note_read', 'builtin-note_set']);
    const chatanki = executor('ChatAnkiToolExecutor', ['chatanki_update_card']);
    host.ctx.agentTools.registerToolExecutors([canvas]);
    host.ctx.agentTools.registerToolExecutors([chatanki]);
    expect(host.ctx.agentTools.toolExecutors().map(candidate => candidate.name())).toEqual([
      'PtcExecutor', 'SkillWorkshopExecutor', 'SkillsExecutor', 'LlmUsageToolExecutor', 'McpProposeExecutor',
      'McpManageExecutor', 'SkillMarketReadToolExecutor', 'SkillMarketInstallToolExecutor', 'WorkbenchToolExecutor',
      'ConnectorToolExecutor', 'FetchExecutor', 'SkillInstallExecutor', 'SkillLifecycleExecutor',
      'CanvasToolExecutor', 'ChatAnkiToolExecutor',
    ]);
    expect(host.ctx.agentTools.toolExecutors()[13]!.canHandle('builtin-note_read')).toBe(true);
    expect(host.ctx.agentTools.toolExecutors()[12]!.canHandle('builtin-note_read')).toBe(false);
  } finally {
    await host.dispose();
  }
});

it('W02 registry disposes only one registration identity and preserves snapshots', () => {
  const registry = new AgentToolExecutorRegistry();
  const shared = executor('Shared', ['shared']);
  const sameName = executor('Shared', ['other']);
  const tail = executor('Tail', ['tail']);
  const input = [shared, sameName, shared];
  const first = registry.register(input);
  registry.register([tail]);
  const second = registry.register([shared, sameName]);
  const snapshot = registry.all();
  expect(first).toBeInstanceOf(Disposer);
  expect(snapshot).toEqual([shared, sameName, shared, tail, shared, sameName]);
  input.splice(0);
  expect(registry.all()).toEqual(snapshot);
  first.dispose();
  expect(first.isActive()).toBe(false);
  expect(registry.all()).toEqual([tail, shared, sameName]);
  const later = registry.register([shared, sameName]);
  first.dispose();
  expect(registry.all()).toEqual([tail, shared, sameName, shared, sameName]);
  second.dispose();
  expect(registry.all()).toEqual([tail, shared, sameName]);
  later.dispose();
  later.dispose();
  expect(registry.all()).toEqual([tail]);
  expect(snapshot).toEqual([shared, sameName, shared, tail, shared, sameName]);
  (snapshot as AgentToolExecutor[]).splice(0);
  expect(registry.all()).toEqual([tail]);
  const empty = registry.register([]);
  empty.dispose();
  expect(registry.all()).toEqual([tail]);
});

it('W02 Host unload and reinstall revoke only the scope-owned registration', async () => {
  const host = await createTestHost({
    plugins: [pathsPlugin, plugin],
    provide: { settings: memorySettings(), storage: unavailableStorage() },
  });
  const shared = executor('Shared', ['shared']);
  const sameName = executor('Shared', ['other']);
  const registrations: Disposer[] = [];
  const owner = definePlugin({
    meta: { id: 'fixture.executor-owner', commands: [] },
    inject: ['agentTools'],
    apply(ctx) {
      ctx.effect(() => {
        const registration = ctx.agentTools.registerToolExecutors([shared, shared]);
        registrations.push(registration);
        return () => registration.dispose();
      });
    },
  });
  const peer = definePlugin({
    meta: { id: 'fixture.executor-peer', commands: [] },
    inject: ['agentTools'],
    apply(ctx) {
      ctx.effect(() => {
        const registration = ctx.agentTools.registerToolExecutors([sameName, shared]);
        return () => registration.dispose();
      });
    },
  });
  try {
    const baseline = host.ctx.agentTools.toolExecutors();
    const legacy = executor('Legacy', ['legacy']);
    // Ignoring the new return value remains supported, but is not auto-cleanup.
    host.ctx.agentTools.registerToolExecutors([legacy]);
    await host.install(owner, peer);
    const snapshot = host.ctx.agentTools.toolExecutors();
    expect(snapshot).toEqual([...baseline, legacy, shared, shared, sameName, shared]);
    expect(registrations[0]).toBeInstanceOf(Disposer);
    await host.unload('fixture.executor-owner');
    expect(registrations[0]!.isActive()).toBe(false);
    expect(host.ctx.agentTools.toolExecutors()).toEqual([...baseline, legacy, sameName, shared]);
    await host.install(owner);
    registrations[0]!.dispose();
    expect(host.ctx.agentTools.toolExecutors()).toEqual([...baseline, legacy, sameName, shared, shared, shared]);
    expect(snapshot).toEqual([...baseline, legacy, shared, shared, sameName, shared]);
    await host.unload('fixture.executor-peer');
    expect(host.ctx.agentTools.toolExecutors()).toEqual([...baseline, legacy, shared, shared]);
    await host.unload('fixture.executor-owner');
    expect(host.ctx.agentTools.toolExecutors()).toEqual([...baseline, legacy]);
  } finally {
    await host.dispose();
  }
});
