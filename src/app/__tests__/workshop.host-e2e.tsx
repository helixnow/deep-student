/** Real Host, production workshop assembly, real session store and UiKernel, local HTTP/SSE model. */
import React, { Suspense } from 'react';
import * as ReactDom from 'react-dom';
import * as sdk from '@/ui-sdk';
import i18next from 'i18next';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { render, fireEvent, waitFor, within, act } from '@testing-library/react';
import { createPipelineHost } from '../../../host/plugins/chat-pipeline/tests/chat-host';
import { persistenceStorePort } from '../../../host/plugins/chat-pipeline/tests/persistence-store-port';
import { historyStorePort } from '../../../host/plugins/chat-pipeline/tests/history-store-port';
import agentSkills from '../../../host/plugins/agent-skills';
import orchestration from '../../../host/plugins/agent-orchestration';
import workshop from '../../../host/plugins/plugin-workshop';
import type { PluginWorkshopService } from '../../../host/plugins/plugin-workshop/api';
import { PluginAdmin } from '../../../host/kernel/plugin-admin';
import { UserProfileStore } from '../../../host/kernel/profile-store';
import { CommunityConsentLedger } from '../../../host/kernel/community-consent';
import { PluginPackages } from '../../../host/kernel/plugin-packages';
import { createNodeFiles } from '../../../host/platform/files';
import { pluginServiceName } from '../../../host/kernel/plugin-id';
import { UiKernel } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import { UiPluginLoader } from '@/ui-kernel/loader';
import { sharedModuleSource } from '@/ui-kernel/shared';
import workshopUi from '@/ui-plugins/official/plugin-workshop';
import { workshopContributions } from '@/ui-plugins/official/plugin-workshop/api';
import settingsUi from '@/ui-plugins/official/settings';
import { McpToolBlockComponent } from '@/features/chat/plugins/blocks/mcpTool';
import type { Block } from '@/features/chat/core/types/block';
import { sessionManager } from '@/features/chat/core/session/sessionManager';
import { peekPendingChatNavigation, resetChatNavigationHandshakeForTest } from '@/features/chat/navigation/pendingChatNavigation';
import { skillDefaults } from '@/features/chat/skills/skillDefaults';
import { skillRegistry } from '@/features/chat/skills/registry';
import { hostSkillSchemaToolIds } from '@/features/chat/skills/hostResources';
import '@/features/plugin-manager/production';
import '@/app/pluginWorkshop';

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: bridge.invoke, convertFileSrc: (path: string) => path }));
vi.mock('react-i18next', async importOriginal => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  ...(await import('@/features/plugin-manager/__tests__/i18nMock')).i18nMock(),
}));

it('RF-P5-workshop-assembly: creates, generates, confirms, runs, revokes, restores without model and exports through the real Host', async () => {
  const requests: Record<string, unknown>[] = [];
  let responseText = '';
  let parentTurn = 0;
  let modifyPluginId: string | undefined;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const request = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(request);
    const background = JSON.stringify(request.messages).includes('Host-controlled creation task');
    const delta = background ? { content: responseText } : parentTurn++ === 0
      ? { tool_calls: [{ index: 0, id: 'proposal-tool', type: 'function', function: {
        name: 'dstu_plugin_propose_install', arguments: JSON.stringify({ title: '每日回忆', description: 'A daily recall helper',
          template: 'learning-tool', changes: ['Add recall view'], capabilities: [], ...(modifyPluginId ? { pluginId: modifyPluginId } : {}) }),
      } }] } : { content: '请确认工坊卡片。' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: 'tool_calls' in delta ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
  const host = await createPipelineHost({ llm: true, appVersion: '0.20.0', tempRoot: join(process.cwd(), '.tmp'), provide: { mcp: { registry: {
    callTool: async () => [false, null, 'not used', null, null, null], detectToolConflicts: async () => [], stripMcpNamespace: (name: string) => name,
  } } } });
  const ui = new UiKernel({ invoke: (cmd, args) => bridge.invoke(cmd, args) });
  const views: ReturnType<typeof render>[] = [];
  const cleanups: Array<() => void> = [];
  let loader: UiPluginLoader | undefined;
  let rpc!: PluginWorkshopService;
  workshopContributions.announce(ctx => { rpc = ctx.ui.host.pluginWorkshop as unknown as PluginWorkshopService; });
  try {
    const autoApprove = (sid: string) => {
      const off = host.ctx.backendEvents.listenWindow({ window: 'main', webview: 'main' }, `chat_v2_event_${sid}`, raw => {
        const event = raw as { type?: string; phase?: string; payload?: { toolCallId?: string; toolName?: string } };
        if (event.type !== 'tool_approval_request' || event.phase !== 'start' || !event.payload?.toolCallId || !event.payload.toolName) return;
        host.ctx.agentApproval.respond({
          sessionId: sid, toolCallId: event.payload.toolCallId, toolName: event.payload.toolName,
          approved: true, reason: null, remember: false, rememberSession: false,
        });
      });
      cleanups.push(off);
    };
    const root = host.ctx.paths.appDataDir;
    await mkdir(join(root, 'plugins'), { recursive: true });
    const official = join(root, 'official.json');
    await writeFile(official, '{"plugins":[]}');
    const store = new UserProfileStore(join(root, 'plugins/user.profile.json'), official);
    const ledger = new CommunityConsentLedger(root);
    const files = createNodeFiles({ roots: [{ name: 'appData', path: root }] });
    const packages = new PluginPackages(files.scope(join(root, 'plugins')));
    new PluginAdmin({ runtime: host.runtime, store, official, consent: ledger, files, packages }).register();
    await host.install(agentSkills, orchestration, workshop);
    const service = host.ctx.chatSession, persistence = persistenceStorePort();
    Object.assign(service, persistence, historyStorePort(service, persistence), {
      getMessageWithConn: (_conn: unknown, id: string) => service.getMessage(id),
      updateMessageWithConn: (conn: { run(sql: string, params: unknown[]): void }, message: { id: string; blockIds: string[]; _meta?: unknown }) =>
        conn.run('UPDATE chat_v2_messages SET block_ids_json=?, meta_json=? WHERE id=?', [JSON.stringify(message.blockIds), JSON.stringify(message._meta ?? null), message.id]),
    });
    await host.ctx.llm.saveApiConfigurations([{ id: 'workshop-model', name: 'Workshop local SSE', apiKey: '', authMode: 'none',
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, model: 'workshop-model',
      apiProtocol: 'openai_chat_completions', modelAdapter: 'general', supportsTools: true, enabled: true,
      isMultimodal: false, isReasoning: false, isEmbedding: false, isReranker: false }]);
    bridge.invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      const result = await host.invoke(cmd, args);
      ui.hostStatus.update(host.runtime.uiManifestV2());
      return result;
    });
    await ui.install(settingsUi, { origin: 'builtin' });
    await ui.install(workshopUi, { origin: 'builtin' });
    ui.hostStatus.update(host.runtime.uiManifestV2());
    await waitFor(() => expect(skillRegistry.has('dstu-plugin-development')).toBe(true));
    expect(skillRegistry.get('dstu-plugin-development')?.content).toBe('');
    const original = sessionManager.getOrCreate('original-draft');
    original.setState({ inputValue: '保留原会话草稿' });
    skillDefaults.add('tutor-mode');
    resetChatNavigationHandshakeForTest();
    const section = ui.slots.list('settings.sections').find(entry => entry.value.id === 'plugin-manager')!;
    const Manager = section.value.component;
    const managerView = render(<UiKernelProvider kernel={ui}><Suspense fallback={null}><Manager /></Suspense></UiKernelProvider>);
    views.push(managerView);
    const screen = within(document.body);
    const managerScreen = within(managerView.container);
    fireEvent.click(await managerScreen.findByRole('button', { name: '用 AI 创作插件' }));
    await waitFor(() => expect(peekPendingChatNavigation()?.kind).toBe('session'));
    const nav = peekPendingChatNavigation();
    if (nav?.kind !== 'session') throw new Error('Workshop navigation was not requested');
    const sessionId = nav.sessionId;
    const state = sessionManager.getOrCreate(sessionId).getState();
    expect(state.activeSkillIds).toEqual(['dstu-plugin-development']);
    expect(service.getSession(sessionId)?.metadata).toMatchObject({ dstuWorkshop: { kind: 'create' } });
    expect(original.getState().inputValue).toBe('保留原会话草稿');
    expect(skillDefaults.getAll()).toContain('tutor-mode');
    expect(requests).toHaveLength(0); // opening the entry never sends or starts generation
    expect(await rpc.list()).toEqual([]);
    const schemaToolIds = hostSkillSchemaToolIds(state.activeSkillIds);
    expect(schemaToolIds).toHaveLength(14);
    autoApprove(sessionId);
    const messageId = await host.ctx.chatPipeline.execute({ window: 'main', webview: 'main' }, {
      sessionId, content: '请创作每日回忆插件', options: { activeSkillIds: state.activeSkillIds, schemaToolIds,
        skillContents: { 'dstu-plugin-development': skillRegistry.get('dstu-plugin-development')!.content } },
    }, new AbortController().signal, null);
    const [draft] = await rpc.list();
    expect(draft?.state).toBe('draft');
    expect(draft.sessionId).toBe(sessionId);
    expect(await packages.list()).toEqual([]);
    const toolBlock = service.getMessageBlocks(messageId).find(block => block.type === 'mcp_tool' || block.type === 'tool_call');
    expect(toolBlock).toBeDefined();
    expect(toolBlock?.toolOutput).toMatchObject({ kind: 'dstu-plugin-workshop', id: draft.id, state: 'draft' });
    const block = toolBlock as unknown as Block;
    views.push(render(<UiKernelProvider kernel={ui}><McpToolBlockComponent block={block} /></UiKernelProvider>));
    const card = await screen.findByLabelText('插件工坊确认');
    expect(card).toHaveTextContent('等待创建确认');
    const name = pluginServiceName(draft.pluginId);
    responseText = JSON.stringify({ files: [
      { path: 'index.ts', content: `export default {name:${JSON.stringify(draft.pluginId)},meta:{id:${JSON.stringify(draft.pluginId)},version:'1.0.0',ui:'./ui.js',provides:[${JSON.stringify(name)}],remote:{${JSON.stringify(name)}:['today']}},apply(ctx){ctx.provide(${JSON.stringify(name)},{today(){return {word:'recall',meaning:'Generated by local SSE'};}});}};` },
      { path: 'ui.tsx', content: `import React from 'react';import {defineUiPlugin} from '@deepstudent/ui';export default defineUiPlugin({meta:{id:${JSON.stringify(draft.pluginId)},version:'1.0.0',host:true},apply(ctx){function Recall(){const [word,setWord]=React.useState(null);React.useEffect(()=>{void ctx.ui.host[${JSON.stringify(name)}].today().then(setWord);},[]);return React.createElement('section',null,React.createElement('h2',null,word?.word),React.createElement('p',null,word?.meaning));}ctx.ui.views.register({id:'recall',titleKey:'title',component:Recall});ctx.ui.nav.register({id:'recall',viewId:'recall',labelKey:'title'});}});` },
    ] });
    fireEvent.click(within(card).getByRole('button', { name: '创建/安装' }));
    await waitFor(async () => expect(['pending-confirmation', 'failed']).toContain((await rpc.status(draft.id)).state), { timeout: 30_000 });
    const candidate = await rpc.status(draft.id);
    expect(candidate.state, candidate.error ?? JSON.stringify(candidate.check)).toBe('pending-confirmation');
    expect(await packages.list()).toEqual([]);
    await waitFor(() => expect(card).toHaveTextContent('等待安装确认'), { timeout: 5000 });
    const installButton = within(card).getByRole('button', { name: '创建/安装' });
    await waitFor(() => expect(installButton).toBeEnabled(), { timeout: 5000 });
    fireEvent.click(installButton);
    await waitFor(async () => {
      const status = await rpc.status(draft.id);
      const alerts = within(card).queryAllByRole('alert').map(node => node.textContent).filter(Boolean).join('\n');
      expect(status.state, [status.error, alerts].filter(Boolean).join('\n')).toBe('installed');
    }, { timeout: 15_000 });
    expect((await packages.list())[0]).toMatchObject({ id: draft.pluginId, enabled: true });
    expect((await ledger.read()).find(entry => entry.id === draft.pluginId)).toMatchObject({ trust: 'full', source: 'workshop' });
    expect(host.runtime.get(draft.pluginId)).toBeDefined();
    fireEvent.click(managerScreen.getByRole('radio', { name: '我的创作' }));
    const tryButton = await managerScreen.findByRole('button', { name: '试用' });
    await waitFor(() => expect(tryButton).toBeEnabled());
    fireEvent.click(tryButton);
    await waitFor(() => expect(host.runtime.get(draft.pluginId), managerScreen.queryAllByRole('alert').map(node => node.textContent).join('\n')).toBeDefined());
    expect((await store.read()).file.plugins.find(entry => entry.id === draft.pluginId)?.disabled).toBeUndefined();

    // Node has no import maps. Use the production shared-module source with data URLs,
    // and transport the actual built UI file instead of Chromium's ds-plugin:// scheme.
    const shared = { react: React, 'react-dom': ReactDom, '@deepstudent/ui': sdk, i18next };
    (globalThis as unknown as { __DS_SHARED__: typeof shared }).__DS_SHARED__ = shared;
    const urls = Object.fromEntries(Object.entries(shared).map(([id, value]) => [id,
      `data:text/javascript;base64,${Buffer.from(sharedModuleSource(id, value)).toString('base64')}`]));
    const nativeImport = (url: string): Promise<{ default?: unknown }> => import(/* @vite-ignore */ url);
    loader = new UiPluginLoader(ui, {
      ready: (id, version) => host.invoke('plugin:ui|ready', { id, version }),
      importModule: async () => {
        const entry = host.runtime.uiManifest().find(item => item.id === draft.pluginId)!;
        let source = await readFile(entry.file, 'utf8');
        for (const [id, url] of Object.entries(urls)) source = source.replaceAll(`"${id}"`, `"${url}"`).replaceAll(`'${id}'`, `'${url}'`);
        return nativeImport(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
      },
    });
    await loader.sync(host.runtime.uiManifest());
    expect(loader.loadErrors()).toEqual([]);
    const view = ui.slots.list('views').find(entry => entry.owner === draft.pluginId)!;
    expect(view).toBeDefined();
    const Generated = view.value.component as React.ComponentType;
    views.push(render(<UiKernelProvider kernel={ui}><Generated /></UiKernelProvider>));
    await screen.findByText('Generated by local SSE');
    expect(screen.getByText('recall')).toBeInTheDocument();
    const modelRequests = requests.length;
    const revokeButton = managerScreen.getByRole('button', { name: '撤销' });
    await waitFor(() => expect(revokeButton).toBeEnabled());
    fireEvent.click(revokeButton);
    await waitFor(async () => expect((await rpc.status(draft.id)).state,
      managerScreen.queryAllByRole('alert').map(node => node.textContent).join('\n')).toBe('revoked'));
    expect(host.runtime.get(draft.pluginId)).toBeUndefined();
    expect(await packages.list()).toEqual([]);
    await loader.sync(host.runtime.uiManifest());
    expect(ui.slots.list('views').some(entry => entry.owner === draft.pluginId)).toBe(false);
    const clickEnabled = async (button: HTMLElement) => {
      await waitFor(() => expect(button).toBeEnabled(), { timeout: 5000 });
      fireEvent.click(button);
    };
    await clickEnabled(await managerScreen.findByRole('button', { name: '恢复' }));
    await waitFor(async () => expect((await rpc.status(draft.id)).state).toBe('installed'));
    expect((await packages.verify(draft.pluginId)).version).toBe('1.0.0');
    expect(requests).toHaveLength(modelRequests);
    await clickEnabled(await managerScreen.findByRole('button', { name: '导出 .dstuplugin' }));
    const exportNotice = await managerScreen.findByText(/已导出：.*\.dstuplugin/);
    const exportPath = exportNotice.textContent!.replace('已导出：', '');
    expect((await readFile(exportPath)).byteLength).toBeGreaterThan(0);
    expect(requests).toHaveLength(modelRequests);
    expect(bridge.invoke.mock.calls.filter(([cmd, args]) => cmd === 'plugin:host|call' && args.service === 'pluginWorkshop')
      .every(([, args]) => args.caller === 'dstu.plugin-workshop')).toBe(true);

    // The user edit entry, not the Agent, authorizes the new session to own this work.
    const installed = await rpc.status(draft.id);
    resetChatNavigationHandshakeForTest();
    await clickEnabled(await managerScreen.findByRole('button', { name: '让 AI 修改' }));
    await waitFor(() => expect(peekPendingChatNavigation()?.kind).toBe('session'));
    const editNav = peekPendingChatNavigation();
    if (editNav?.kind !== 'session') throw new Error('Edit navigation was not requested');
    expect(editNav.sessionId).not.toBe(sessionId);
    const editing = await rpc.status(draft.id);
    expect(editing.sessionId).toBe(editNav.sessionId);
    expect(editing.revision).toBe(installed.revision + 1);
    const editState = sessionManager.getOrCreate(editNav.sessionId).getState();
    expect(editState.activeSkillIds).toEqual(['dstu-plugin-development']);
    expect(service.getSession(editNav.sessionId)?.metadata).toMatchObject({ dstuWorkshop: { kind: 'modify', workshopId: draft.id, pluginId: draft.pluginId } });
    expect(requests).toHaveLength(modelRequests);
    modifyPluginId = draft.pluginId;
    parentTurn = 0;
    const unauthorizedMessage = await host.ctx.chatPipeline.execute({ window: 'main', webview: 'main' }, {
      sessionId, content: '旧会话尝试修改作品', options: { activeSkillIds: state.activeSkillIds, schemaToolIds,
        skillContents: { 'dstu-plugin-development': skillRegistry.get('dstu-plugin-development')!.content } },
    }, new AbortController().signal, null);
    const rejectedTool = service.getMessageBlocks(unauthorizedMessage).find(block => block.toolName?.includes('dstu_plugin_propose_install'));
    expect(rejectedTool?.error).toContain('another conversation');
    expect((await rpc.status(draft.id)).sessionId).toBe(editNav.sessionId);
    parentTurn = 0;
    autoApprove(editNav.sessionId);
    await host.ctx.chatPipeline.execute({ window: 'main', webview: 'main' }, {
      sessionId: editNav.sessionId, content: '修改这个已有作品', options: { activeSkillIds: editState.activeSkillIds,
        schemaToolIds: hostSkillSchemaToolIds(editState.activeSkillIds),
        skillContents: { 'dstu-plugin-development': skillRegistry.get('dstu-plugin-development')!.content } },
    }, new AbortController().signal, null);
    expect(await rpc.status(draft.id)).toMatchObject({ id: draft.id, pluginId: draft.pluginId, sessionId: editNav.sessionId, state: 'draft' });
    expect(await rpc.list()).toHaveLength(1);
    expect((await packages.verify(draft.pluginId)).version).toBe('1.0.0');
    expect(original.getState().inputValue).toBe('保留原会话草稿');
  } finally {
    for (const off of cleanups) off();
    for (const view of views.reverse()) view.unmount();
    await loader?.dispose();
    await act(async () => { await ui.dispose(); });
    skillDefaults.remove('tutor-mode');
    resetChatNavigationHandshakeForTest();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await host.dispose();
  }
}, 60_000);
