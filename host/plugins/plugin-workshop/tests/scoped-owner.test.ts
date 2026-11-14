import { mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { definePlugin } from '../../../kernel/api.ts';
import { PluginAdmin } from '../../../kernel/plugin-admin.ts';
import { UserProfileStore } from '../../../kernel/profile-store.ts';
import { CommunityConsentLedger } from '../../../kernel/community-consent.ts';
import { PluginPackages } from '../../../kernel/plugin-packages/index.ts';
import { createNodeFiles } from '../../../platform/files/index.ts';
import { AgentToolExecutorRegistry, type AgentToolExecutor } from '../../agent-skills/api.ts';
import type { ExecutionContext, ToolCall } from '../../chat/api.ts';
import type { WorkshopCard } from '../api.ts';
import workshop from '../index.ts';

it('P1 scope composition: paired UI background generation, Agent validation/export and retained restore use the builtin owner', async () => {
  await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
  const dataDir = await realpath(await mkdtemp(join(process.cwd(), '.tmp', 'dstu-scoped-workshop-')));
  await mkdir(join(dataDir, 'plugins'));
  const official = join(dataDir, 'official.json'); await writeFile(official, '{"plugins":[]}');
  const registry = new AgentToolExecutorRegistry();
  const answers = new Map<string, string>();
  const host = await createTestHost({ app: { dataDir, version: '0.20.0' }, provide: {
    paths: { appDataDir: dataDir },
    agentTools: { registerToolExecutors: (executors: readonly AgentToolExecutor[]) => registry.register(executors), toolExecutors: () => registry.all() },
    chatSession: { createSession() {}, getMessageBlocks: (id: string) => [{ type: 'content', content: answers.get(id) }] },
    chatPipeline: { async execute(_window: unknown, request: { content: string }) {
      await Promise.resolve(); // Background continuation must retain workshop attribution after the UI RPC returns.
      const template = JSON.parse(request.content.slice(request.content.indexOf('Template: ') + 'Template: '.length));
      const id = `msg-${answers.size}`;
      answers.set(id, JSON.stringify({ files: [{ path: 'index.ts', content: template['index.ts'] }] }));
      return id;
    } },
  } });
  const files = createNodeFiles({ roots: [{ name: 'appData', path: dataDir }] });
  new PluginAdmin({ runtime: host.runtime, store: new UserProfileStore(join(dataDir, 'plugins/user.profile.json'), official), official,
    consent: new CommunityConsentLedger(dataDir), files, packages: new PluginPackages(files.scope(join(dataDir, 'plugins'))) }).register();
  await host.runtime.install(workshop);
  expect(Object.isFrozen(registry.all()[0])).toBe(true);
  expect(Object.isFrozen(registry.all()[0]?.execute)).toBe(true);
  expect(Reflect.get(registry.all()[0]!, 'inOwner')).toBeUndefined();
  expect(Reflect.get(registry.all()[0]!, 'operations')).toBeUndefined();
  const ui = <T>(method: string, args: unknown[] = []) => host.invoke<T>('plugin:host|call', { caller: 'dstu.plugin-workshop', service: 'pluginWorkshop', method, args });
  try {
    let card = await ui<WorkshopCard>('propose', [{ sessionId: 'owner-session', title: 'Test', description: 'Test', template: 'host-tool', changes: [], capabilities: [] }]);
    await ui('create', [card.id, card.revision]);
    await vi.waitFor(async () => {
      card = await ui<WorkshopCard>('status', [card.id]);
      expect(card.state, card.error ?? '').toBe('pending-confirmation');
    }, { timeout: 5000 });
    // Different provider fiber represents the central chat tool dispatcher, not the workshop owner.
    await host.runtime.install(definePlugin({ meta: { id: 'dstu.tool-dispatch-test', provides: ['testDispatch'], remote: { testDispatch: ['run'] } },
      inject: ['agentTools'], apply(ctx) {
        ctx.provide('testDispatch', { run: async (name: string, id: string) => {
          const executor = ctx.agentTools.toolExecutors().find(item => item.canHandle(name))!;
          return executor.execute!({ id: 'call-1', name, arguments: { id } } as ToolCall, {
            session_id: 'owner-session', block_id: 'block', emitToolCallStart() {}, emitToolCallEnd() {}, emitToolCallError() {},
          } as unknown as ExecutionContext);
        } });
      } }));
    for (const name of ['dstu_plugin_validate', 'dstu_plugin_export']) {
      const result = await host.invoke<{ success: boolean; error?: string }>('plugin:host|call', {
        caller: 'dstu.tool-dispatch-test', service: 'testDispatch', method: 'run', args: [name, card.id],
      });
      expect(result.success, result.error).toBe(true);
    }
    card = await ui<WorkshopCard>('install', [card.id, card.revision]);
    card = await ui<WorkshopCard>('revoke', [card.id, card.revision]);
    card = await ui<WorkshopCard>('restore', [card.id, card.revision]);
    expect(card.state).toBe('installed');
    expect(host.ctx.get('dstuPluginInstaller')).toBeUndefined();
  } finally { await host.dispose(); }
}, 20_000);
