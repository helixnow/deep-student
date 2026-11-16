/**
 * Real Host, production workshop assembly, real session store and UiKernel, local HTTP/SSE model (no real model).
 *
 * The film's path, end to end: the proposal card appears in the chat → 开始做 → generate / compile / self-check →
 * 「等你确认」 card with what it can do and 「装好后在哪里找到它」 → one click 「安装」 → installed and running →
 * its app is registered on the learning desktop and 「打开<名>」 opens its window → the manager shows it in
 * 「我的插件」 → 停用 / 启用 (no second consent) / 卸载 (through the workshop) / 恢复 / 导出 / 让 AI 改 / 回到上一版.
 */
import React, { Suspense } from 'react';
import * as ReactDom from 'react-dom';
import * as sdk from '@/ui-sdk';
import i18next from 'i18next';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { expect, it, vi } from 'vitest';
import { render, fireEvent, waitFor, within, act } from '@testing-library/react';
import { createPipelineHost } from '../../../host/plugins/chat-pipeline/tests/chat-host';
import { persistenceStorePort } from '../../../host/plugins/chat-pipeline/tests/persistence-store-port';
import { historyStorePort } from '../../../host/plugins/chat-pipeline/tests/history-store-port';
import agentSkills from '../../../host/plugins/agent-skills';
import orchestration from '../../../host/plugins/agent-orchestration';
import workshop from '../../../host/plugins/plugin-workshop';
import { PipelineWorkshopGeneration } from '../../../host/plugins/plugin-workshop/src/generation';
import { WorkshopOperations } from '../../../host/plugins/plugin-workshop/src/operations';
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
import { APP_EVENTS, dispatchAppEvent } from '@/events/app';
import appI18n from '@/i18n';
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
import { appRegistry } from '@/features/workbench/core/appRegistry';
import { useWindowStore } from '@/features/workbench/core/windowStore';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';
import WorkbenchEventBridge from '@/features/workbench/components/WorkbenchEventBridge';
import { mirrorPluginViewApps, pluginViewAppTypeId } from '@/features/workbench/apps/plugin-views/register';
import '@/features/plugin-manager/production';
import '@/app/pluginWorkshop';

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
/** Non-model durations (ms) measured inside the real Host. */
const timings = vi.hoisted(() => ({} as Record<string, number[]>));
const timed = vi.hoisted(() => async <T,>(label: string, run: () => Promise<T>): Promise<T> => {
  const start = performance.now();
  try { return await run(); } finally { (timings[label] ??= []).push(performance.now() - start); }
});
vi.mock('@tauri-apps/api/core', () => ({ invoke: bridge.invoke, convertFileSrc: (path: string) => path }));
vi.mock('react-i18next', async importOriginal => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  ...(await import('@/features/plugin-manager/__tests__/i18nMock')).i18nMock(),
}));
// Timing probes only: the real compiler and lifecycle self-check run unchanged.
vi.mock('../../../host/plugins/plugin-workshop/src/compiler.ts', async importOriginal => {
  const real = await importOriginal<typeof import('../../../host/plugins/plugin-workshop/src/compiler')>();
  return {
    ...real,
    compileWorkshop: (...args: Parameters<typeof real.compileWorkshop>) => timed('compile', () => real.compileWorkshop(...args)),
    checkWorkshopLifecycle: (...args: Parameters<typeof real.checkWorkshopLifecycle>) => timed('selfCheck', () => real.checkWorkshopLifecycle(...args)),
  };
});

const ms = (values?: number[]) => (values ?? []).map(value => `${Math.round(value)}ms`).join(', ') || '—';

it('RF-P5-workshop-assembly: proposal card → 开始做 → 安装 → opens on the desktop → manager card → 停用/启用/卸载/恢复/导出/让 AI 改/回到上一版, without a model, through the real Host', async () => {
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
          template: 'learning-tool', changes: [modifyPluginId ? 'Show the word of the day v2' : 'Add recall view'],
          capabilities: ['每天给你一个要回忆的词'], ...(modifyPluginId ? { pluginId: modifyPluginId } : {}) }),
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
  // Same navigation adapter as the production bootstrap: kernel navigation → NAVIGATE_TO_VIEW.
  const ui = new UiKernel({
    invoke: (cmd, args) => bridge.invoke(cmd, args),
    navigate: ({ view, params }) => dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_VIEW, { ...params, view }),
  });
  const views: ReturnType<typeof render>[] = [];
  const cleanups: Array<() => void> = [];
  let loader: UiPluginLoader | undefined;
  let rpc!: PluginWorkshopService;
  workshopContributions.announce(ctx => { rpc = ctx.ui.host.pluginWorkshop as unknown as PluginWorkshopService; });
  // Host-side timing probes around the generation (local SSE, no model), install and restore.
  for (const [proto, method, label] of [[PipelineWorkshopGeneration.prototype, 'generate', 'generate'],
    [WorkshopOperations.prototype, 'install', 'install'], [WorkshopOperations.prototype, 'restore', 'restore']] as const) {
    const original = (proto as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[method];
    vi.spyOn(proto as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>, method)
      .mockImplementation(function (this: unknown, ...args: unknown[]) { return timed(label, () => original.apply(this, args)); });
  }
  const wall: Record<string, number> = {};
  let step = 0;
  let completed = false;
  try {
    workbenchBus.setEnabled(true);
    useWindowStore.setState({ windows: {}, focusStack: [], lifecycles: {}, launchPayloads: {}, tilingRatios: {}, desktopSize: { w: 1600, h: 900 } });
    cleanups.push(mirrorPluginViewApps(ui));
    views.push(render(<WorkbenchEventBridge />));
    const pluginWindows = (typeId: string) => Object.values(useWindowStore.getState().windows).filter(entry => entry.typeId === typeId);

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
    const Manager = section.value.component as React.ComponentType; // the manager section reads no settings props
    const managerView = render(<UiKernelProvider kernel={ui}><Suspense fallback={null}><Manager /></Suspense></UiKernelProvider>);
    views.push(managerView);
    const screen = within(document.body);
    const managerScreen = within(managerView.container);
    const clickEnabled = async (button: HTMLElement) => {
      await waitFor(() => expect(button).toBeEnabled(), { timeout: 5000 });
      fireEvent.click(button);
    };
    const alerts = (scope: ReturnType<typeof within>) => scope.queryAllByRole('alert').map(node => node.textContent).filter(Boolean).join('\n');
    const skillOptions = (ids: string[]) => ({ activeSkillIds: ids, schemaToolIds: hostSkillSchemaToolIds(ids),
      skillContents: { 'dstu-plugin-development': skillRegistry.get('dstu-plugin-development')!.content } });
    const execute = (sid: string, content: string, ids: string[]) => host.ctx.chatPipeline.execute({ window: 'main', webview: 'main' },
      { sessionId: sid, content, options: skillOptions(ids) }, new AbortController().signal, null);
    const generatedFiles = (pluginId: string, version: string, meaning: string) => {
      const name = pluginServiceName(pluginId);
      return JSON.stringify({ files: [
        { path: 'index.ts', content: `export default {name:${JSON.stringify(pluginId)},meta:{id:${JSON.stringify(pluginId)},version:'${version}',ui:'./ui.js',provides:[${JSON.stringify(name)}],remote:{${JSON.stringify(name)}:['today']}},apply(ctx){ctx.provide(${JSON.stringify(name)},{today(){return {word:'recall',meaning:${JSON.stringify(meaning)}};}});}};` },
        { path: 'ui.tsx', content: `import React from 'react';import {defineUiPlugin} from '@deepstudent/ui';export default defineUiPlugin({meta:{id:${JSON.stringify(pluginId)},version:'${version}',host:true},apply(ctx){function Recall(){const [word,setWord]=React.useState(null);React.useEffect(()=>{void ctx.ui.host[${JSON.stringify(name)}].today().then(setWord);},[]);return React.createElement('section',null,React.createElement('h2',null,word?.word),React.createElement('p',null,word?.meaning));}ctx.ui.views.register({id:'recall',titleKey:'title',component:Recall});ctx.ui.nav.register({id:'recall',viewId:'recall',labelKey:'title'});}});` },
      ] });
    };

    step = 1;
    // ── 1. 「做一个新的」 opens a workshop conversation; nothing is sent or generated yet ──
    // The manager section is lazy: allow a slow first import on a busy machine.
    fireEvent.click(await managerScreen.findByTestId('plugin-create', {}, { timeout: 15_000 }));
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
    expect(hostSkillSchemaToolIds(state.activeSkillIds)).toHaveLength(14);
    autoApprove(sessionId);

    step = 2;
    // ── 2. The Agent proposes: the card appears in the chat, nothing is installed ──
    const messageId = await execute(sessionId, '请创作每日回忆插件', state.activeSkillIds);
    const [draft] = await rpc.list();
    expect(draft?.state).toBe('draft');
    expect(draft.sessionId).toBe(sessionId);
    expect(await packages.list()).toEqual([]);
    const toolBlock = service.getMessageBlocks(messageId).find(block => block.type === 'mcp_tool' || block.type === 'tool_call');
    expect(toolBlock).toBeDefined();
    expect(toolBlock?.toolOutput).toMatchObject({ kind: 'dstu-plugin-workshop', id: draft.id, state: 'draft' });
    const chatView = render(<UiKernelProvider kernel={ui}><McpToolBlockComponent block={toolBlock as unknown as Block} /></UiKernelProvider>);
    views.push(chatView);
    const chat = within(chatView.container);
    const card = await chat.findByTestId('workshop-card');
    await waitFor(() => expect(card).toHaveAttribute('data-phase', 'proposed'));
    expect(card).toHaveAccessibleName('插件工坊');
    expect(chat.getByTestId('workshop-tool-stage')).toHaveTextContent('等你确认');
    expect(within(card).getByTestId('workshop-where')).toHaveTextContent('装好后在哪里找到它：全部应用 → 每日回忆');
    expect(within(card).getByTestId('workshop-capabilities')).toHaveTextContent('每天给你一个要回忆的词');
    expect(within(card).getByTestId('workshop-action-decline')).toHaveTextContent('不要了');
    expect(within(card).queryByTestId('workshop-action-install')).toBeNull();
    expect(within(card).queryByTestId('workshop-risk')).toBeNull(); // the risk is said once, at the install decision

    step = 3;
    // ── 3. 开始做: generate (local SSE, no model) → compile → self-check, still nothing installed ──
    const pluginId = draft.pluginId;
    // A boolean: the runtime record holds Host context proxies that the failure printer cannot format.
    const running = () => host.runtime.get(pluginId) !== undefined;
    responseText = generatedFiles(pluginId, '1.0.0', 'Generated by local SSE');
    const startButton = within(card).getByTestId('workshop-action-start');
    expect(startButton).toHaveTextContent('开始做');
    let started = performance.now();
    fireEvent.click(startButton);
    await waitFor(async () => expect(['pending-confirmation', 'failed']).toContain((await rpc.status(draft.id)).state), { timeout: 30_000, interval: 20 });
    wall.startToReady = performance.now() - started;
    const candidate = await rpc.status(draft.id);
    expect(candidate.state, candidate.error ?? JSON.stringify(candidate.check)).toBe('pending-confirmation');
    expect(candidate.check).toMatchObject({ ok: true, manifest: 'passed', compile: 'passed', lifecycle: 'passed' });
    expect(candidate.places).toEqual([{ kind: 'app', title: '每日回忆' }]);
    expect(await packages.list()).toEqual([]);
    expect(running(), 'running').toBe(false);

    step = 4;
    // ── 4. 「等你确认」: what it can do, where to find it, the risk once, one button 「安装」 ──
    await waitFor(() => expect(card).toHaveAttribute('data-phase', 'ready'), { timeout: 5000 });
    expect(chat.getByTestId('workshop-tool-stage')).toHaveTextContent('等你确认');
    expect(within(card).getByTestId('workshop-where')).toHaveTextContent('装好后在哪里找到它：全部应用 → 每日回忆');
    expect(within(card).getByTestId('workshop-capabilities')).toHaveTextContent('每天给你一个要回忆的词');
    expect(within(card).getByTestId('workshop-risk')).toBeInTheDocument();
    expect(within(card).getByTestId('workshop-action-decline')).toHaveTextContent('不要了');
    const installButton = within(card).getByTestId('workshop-action-install');
    expect(installButton).toHaveTextContent('安装');
    await waitFor(() => expect(installButton).toBeEnabled(), { timeout: 5000 });
    started = performance.now();
    fireEvent.click(installButton);

    step = 5;
    // ── 5. One click: installed, running, trusted for exactly this release, card says where it is ──
    await waitFor(async () => {
      const status = await rpc.status(draft.id);
      expect(status.state, [status.error, alerts(chat)].filter(Boolean).join('\n')).toBe('installed');
    }, { timeout: 15_000, interval: 20 });
    wall.installClickToInstalled = performance.now() - started;
    expect((await packages.list())[0]).toMatchObject({ id: pluginId, enabled: true });
    expect((await ledger.read()).find(entry => entry.id === pluginId)).toMatchObject({ trust: 'full', source: 'workshop' });
    expect(running(), 'running').toBe(true);
    await waitFor(() => expect(card).toHaveAttribute('data-phase', 'installed'), { timeout: 5000 });
    expect(chat.getByTestId('workshop-installed')).toHaveTextContent('装好了');
    expect(chat.getByTestId('workshop-tool-stage')).toHaveTextContent('已安装');
    expect(within(card).getByTestId('workshop-where')).toHaveTextContent('装好后在哪里找到它：全部应用 → 每日回忆');
    const primary = chat.getByTestId('workshop-primary');
    expect(primary).toHaveAttribute('data-place', 'app');
    expect(primary).toHaveTextContent('打开每日回忆');

    // The renderer's plugin loader picks the new UI up from the Host manifest (the bootstrap does this on hostStatus).
    // Node has no import maps: use the production shared-module source with data URLs, and transport the actual built
    // UI file instead of Chromium's ds-plugin:// scheme.
    const shared = { react: React, 'react-dom': ReactDom, '@deepstudent/ui': sdk, i18next };
    (globalThis as unknown as { __DS_SHARED__: typeof shared }).__DS_SHARED__ = shared;
    const urls = Object.fromEntries(Object.entries(shared).map(([id, value]) => [id,
      `data:text/javascript;base64,${Buffer.from(sharedModuleSource(id, value)).toString('base64')}`]));
    const nativeImport = (url: string): Promise<{ default?: unknown }> => import(/* @vite-ignore */ url);
    loader = new UiPluginLoader(ui, {
      ready: (id, version) => host.invoke('plugin:ui|ready', { id, version }),
      // Each import gets a fresh module like production's ds-plugin://…?reload=<n> URL (re-enable, restore, update).
      importModule: async pluginUrl => {
        const entry = host.runtime.uiManifest().find(item => item.id === pluginId)!;
        let source = await readFile(entry.file, 'utf8');
        for (const [id, url] of Object.entries(urls)) source = source.replaceAll(`"${id}"`, `"${url}"`).replaceAll(`'${id}'`, `'${url}'`);
        return nativeImport(`data:text/javascript;base64,${Buffer.from(`${source}\n// ${pluginUrl}`).toString('base64')}`);
      },
    });
    // Production pushes host://ui-manifest and the plugin status together; here the same two reads, then wait for the kernel.
    const syncUi = async () => { await act(async () => {
      ui.hostStatus.update(host.runtime.uiManifestV2());
      await loader!.sync(host.runtime.uiManifest());
      await ui.settled();
    }); };
    await syncUi();
    expect(loader.loadErrors()).toEqual([]);

    step = 6;
    // ── 6. Its app is on the learning desktop, and 「打开每日回忆」 opens its window ──
    const view = ui.slots.list('views').find(entry => entry.owner === pluginId)!;
    expect(view?.key).toBeTruthy();
    const typeId = pluginViewAppTypeId(view.key!);
    expect(appRegistry.get(typeId)).toMatchObject({ typeId, instanceMode: 'single' });
    expect(pluginWindows(typeId)).toHaveLength(0);
    started = performance.now();
    fireEvent.click(primary);
    await waitFor(() => expect(pluginWindows(typeId), alerts(chat) || 'plugin windows').toHaveLength(1));
    wall.openClickToWindow = performance.now() - started;
    // The window body is the registered app's own render (the same lazy component the desktop mounts).
    const AppWindow = appRegistry.get(typeId)!.render;
    const [opened] = pluginWindows(typeId);
    views.push(render(<UiKernelProvider kernel={ui}><Suspense fallback={null}>
      <AppWindow windowId={opened.id} instanceKey={null} launchPayload={undefined} isActive isVisible onTitleChange={() => {}} requestClose={() => {}} />
    </Suspense></UiKernelProvider>));
    const windowBody = await screen.findByTestId('wb-plugin-view-window');
    expect(windowBody).toHaveAttribute('data-plugin-owner', pluginId);
    await within(windowBody).findByText('Generated by local SSE');
    expect(within(windowBody).getByText('recall')).toBeInTheDocument();
    const modelRequests = requests.length;

    step = 7;
    // ── 7. The manager: a card in 「我的插件」, 「你让 AI 做的」, no trust chip, 「打开<名>」 ──
    const managerCard = () => managerScreen.queryAllByTestId('plugin-card').find(node => node.getAttribute('data-plugin-id') === pluginId);
    await waitFor(() => expect(managerCard()).toBeDefined(), { timeout: 5000 });
    expect(within(managerScreen.getByTestId('plugin-section-mine')).getAllByTestId('plugin-card').map(node => node.getAttribute('data-plugin-id'))).toContain(pluginId);
    const mine = () => within(managerCard()!);
    expect(managerCard()).toHaveAttribute('data-source', 'workshop');
    expect(mine().getByTestId('plugin-card-origin')).toHaveTextContent('你让 AI 做的 · v1.0.0');
    expect(mine().getByTestId('plugin-card-name')).toHaveTextContent('每日回忆');
    expect(mine().queryByTestId('plugin-trust-badge')).toBeNull();
    const openFromManager = await mine().findByTestId('plugin-card-open');
    expect(openFromManager).toHaveTextContent('打开每日回忆');
    act(() => { useWindowStore.setState({ windows: {}, focusStack: [] }); });
    fireEvent.click(openFromManager);
    await waitFor(() => expect(pluginWindows(typeId)).toHaveLength(1));

    step = 8;
    // ── 8. 停用 from the chat card; 启用 again from the manager asks no second consent for the same release ──
    const consentsBefore = JSON.stringify(await ledger.read());
    await clickEnabled(chat.getByTestId('workshop-more'));
    fireEvent.click(await screen.findByTestId('workshop-menu-disable'));
    await waitFor(() => expect(running(), 'running').toBe(false));
    await waitFor(() => expect(card).toHaveAttribute('data-phase', 'disabled'), { timeout: 5000 });
    await syncUi();
    expect(appRegistry.get(typeId)).toBeUndefined(); // the desktop app goes with its view
    const enableSwitch = await mine().findByRole('switch', { name: '启用 每日回忆' });
    await waitFor(() => expect(enableSwitch).not.toBeChecked(), { timeout: 5000 });
    await clickEnabled(enableSwitch);
    await waitFor(() => expect(running(), 'running').toBe(true));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(JSON.stringify(await ledger.read())).toBe(consentsBefore);
    await syncUi();
    expect(loader.loadErrors()).toEqual([]);
    expect(appRegistry.get(typeId)).toBeDefined();
    // And the same from the manager's ⋯ 停用 → the chat card's 启用.
    // The card settles (switch on and no longer busy) before its menu is used.
    await waitFor(() => { expect(enableSwitch).toBeChecked(); expect(enableSwitch).toBeEnabled(); }, { timeout: 5000 });
    fireEvent.click(mine().getByTestId('plugin-card-more'));
    const disableItem = (await screen.findAllByRole('menuitem', { name: '停用' })).at(-1)!;
    await waitFor(() => expect(disableItem).not.toHaveAttribute('aria-disabled', 'true'));
    fireEvent.click(disableItem);
    await waitFor(() => expect(running(), alerts(managerScreen) || 'running').toBe(false), { timeout: 5000 });
    await waitFor(() => expect(card).toHaveAttribute('data-phase', 'disabled'), { timeout: 5000 });
    await clickEnabled(chat.getByTestId('workshop-enable'));
    await waitFor(() => expect(running(), alerts(chat) || 'running').toBe(true), { timeout: 5000 });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(JSON.stringify(await ledger.read())).toBe(consentsBefore);
    await waitFor(() => expect(card).toHaveAttribute('data-phase', 'installed'), { timeout: 5000 });
    expect((await store.read()).file.plugins.find(entry => entry.id === pluginId)?.disabled).toBeUndefined();
    await syncUi();

    step = 9;
    // ── 9. 卸载 from the manager goes through the workshop (revoke); the record keeps it restorable ──
    await waitFor(() => expect(mine().getByTestId('plugin-card-more')).toBeEnabled());
    fireEvent.click(mine().getByTestId('plugin-card-more'));
    fireEvent.click(await screen.findByRole('menuitem', { name: '卸载' }));
    const uninstallDialog = await screen.findByRole('alertdialog');
    expect(uninstallDialog).toHaveTextContent('卸载『每日回忆』？');
    expect(uninstallDialog).toHaveTextContent('做过的版本也保留在工坊里');
    fireEvent.click(within(uninstallDialog).getByRole('button', { name: '卸载' }));
    await waitFor(async () => expect((await rpc.status(draft.id)).state, alerts(managerScreen)).toBe('revoked'));
    expect(running(), 'running').toBe(false);
    expect(await packages.list()).toEqual([]);
    await waitFor(() => expect(managerCard()).toBeUndefined(), { timeout: 5000 });
    await syncUi();
    expect(ui.slots.list('views').some(entry => entry.owner === pluginId)).toBe(false);
    expect(appRegistry.get(typeId)).toBeUndefined();
    await waitFor(() => expect(card).toHaveAttribute('data-phase', 'undone'), { timeout: 5000 });
    expect(chat.getByTestId('workshop-undone')).toBeInTheDocument();
    expect(chat.getByTestId('workshop-tool-stage')).toHaveTextContent('已卸载');

    step = 10;
    // ── 10. 恢复 from 「工坊创作记录」 reinstalls the retained version without the model ──
    fireEvent.click(managerScreen.getByTestId('plugin-creations-toggle'));
    const creation = await managerScreen.findByTestId('workshop-creation');
    expect(creation).toHaveAttribute('data-phase', 'undone');
    await clickEnabled(within(creation).getByRole('button', { name: '恢复' }));
    await waitFor(async () => expect((await rpc.status(draft.id)).state, alerts(managerScreen)).toBe('installed'));
    expect((await packages.verify(pluginId)).version).toBe('1.0.0');
    expect(running(), 'running').toBe(true);
    await syncUi();
    expect(appRegistry.get(typeId)).toBeDefined();
    expect(requests).toHaveLength(modelRequests);
    fireEvent.click(managerScreen.getByTestId('plugin-creations-toggle'));
    await waitFor(() => expect(card).toHaveAttribute('data-phase', 'installed'), { timeout: 5000 });

    step = 11;
    // ── 11. 导出 from the chat card writes a .dstuplugin ──
    await clickEnabled(chat.getByTestId('workshop-more'));
    fireEvent.click(await screen.findByTestId('workshop-menu-export'));
    const exportNotice = await chat.findByText(/已导出到：.*\.dstuplugin/);
    const exportPath = exportNotice.textContent!.replace('已导出到：', '');
    expect((await readFile(exportPath)).byteLength).toBeGreaterThan(0);
    expect(requests).toHaveLength(modelRequests);
    expect(bridge.invoke.mock.calls.filter(([cmd, args]) => cmd === 'plugin:host|call' && args.service === 'pluginWorkshop')
      .every(([, args]) => args.caller === 'dstu.plugin-workshop')).toBe(true);

    step = 12;
    // ── 12. 让 AI 改 from the manager returns to the conversation that made it, with the sentence ready, not sent ──
    const installed = await rpc.status(draft.id);
    // The composer sentence comes from the app's i18n (zh-CN: 「把『每日回忆』改成：」).
    const editPrompt = appI18n.t('plugin_manager:workshop.editPrompt', { name: '每日回忆' }) as string;
    resetChatNavigationHandshakeForTest();
    fireEvent.click(mine().getByTestId('plugin-card-more'));
    fireEvent.click(await screen.findByRole('menuitem', { name: '让 AI 改' }));
    await waitFor(() => expect(peekPendingChatNavigation()).toMatchObject({ kind: 'session', sessionId }));
    await waitFor(() => expect(sessionManager.getOrCreate(sessionId).getState().inputValue).toBe(editPrompt));
    expect((await rpc.status(draft.id)).revision).toBe(installed.revision); // no rebinding for the owner conversation
    expect(requests).toHaveLength(modelRequests);

    // Another conversation cannot take the work over through the Agent.
    resetChatNavigationHandshakeForTest();
    fireEvent.click(managerScreen.getByTestId('plugin-create'));
    await waitFor(() => expect(peekPendingChatNavigation()?.kind).toBe('session'));
    const otherNav = peekPendingChatNavigation();
    if (otherNav?.kind !== 'session') throw new Error('Second workshop navigation was not requested');
    expect(otherNav.sessionId).not.toBe(sessionId);
    autoApprove(otherNav.sessionId);
    modifyPluginId = pluginId;
    parentTurn = 0;
    const unauthorizedMessage = await execute(otherNav.sessionId, '另一个会话尝试修改作品', ['dstu-plugin-development']);
    const rejectedTool = service.getMessageBlocks(unauthorizedMessage).find(block => block.toolName?.includes('dstu_plugin_propose_install'));
    expect(rejectedTool?.error).toContain('another conversation');
    expect((await rpc.status(draft.id)).sessionId).toBe(sessionId);

    // The user deleted the original conversation: 让 AI 改 opens a new one and the user's click binds it.
    await host.invoke('chat_v2_delete_session', { sessionId });
    const requestsBeforeEdit = requests.length;
    resetChatNavigationHandshakeForTest();
    fireEvent.click(mine().getByTestId('plugin-card-more'));
    fireEvent.click(await screen.findByRole('menuitem', { name: '让 AI 改' }));
    await waitFor(() => expect(peekPendingChatNavigation()?.kind).toBe('session'));
    const editNav = peekPendingChatNavigation();
    if (editNav?.kind !== 'session') throw new Error('Edit navigation was not requested');
    expect([sessionId, otherNav.sessionId]).not.toContain(editNav.sessionId);
    const editing = await rpc.status(draft.id);
    expect(editing.sessionId).toBe(editNav.sessionId);
    expect(editing.revision).toBe(installed.revision + 1);
    const editState = sessionManager.getOrCreate(editNav.sessionId).getState();
    expect(editState.activeSkillIds).toEqual(['dstu-plugin-development']);
    // A new conversation gets the sentence trimmed (openWorkshopSession trims starters too).
    await waitFor(() => expect(sessionManager.getOrCreate(editNav.sessionId).getState().inputValue).toBe(editPrompt.trim()));
    expect(service.getSession(editNav.sessionId)?.metadata).toMatchObject({ dstuWorkshop: { kind: 'modify', workshopId: draft.id, pluginId } });
    expect(requests).toHaveLength(requestsBeforeEdit); // opening the edit never sends anything

    step = 13;
    // ── 13. The modification: a new card in the new conversation → 开始做 → 安装 v1.0.1 → 回到上一版 ──
    parentTurn = 0;
    autoApprove(editNav.sessionId);
    const modifyMessage = await execute(editNav.sessionId, '修改这个已有作品', editState.activeSkillIds);
    expect(await rpc.status(draft.id)).toMatchObject({ id: draft.id, pluginId, sessionId: editNav.sessionId, state: 'draft' });
    expect(await rpc.list()).toHaveLength(1);
    expect((await packages.verify(pluginId)).version).toBe('1.0.0');
    expect(original.getState().inputValue).toBe('保留原会话草稿');
    chatView.unmount(); views.splice(views.indexOf(chatView), 1);
    const modifyBlock = service.getMessageBlocks(modifyMessage).find(block => block.type === 'mcp_tool' || block.type === 'tool_call');
    const modifyView = render(<UiKernelProvider kernel={ui}><McpToolBlockComponent block={modifyBlock as unknown as Block} /></UiKernelProvider>);
    views.push(modifyView);
    const chat2 = within(modifyView.container);
    const card2 = await chat2.findByTestId('workshop-card');
    await waitFor(() => expect(card2).toHaveAttribute('data-phase', 'proposed'));
    responseText = generatedFiles(pluginId, '1.0.1', 'Generated v2 by local SSE'); // the Host's modify scaffold bumps package.json to 1.0.1
    started = performance.now();
    await clickEnabled(within(card2).getByTestId('workshop-action-start'));
    await waitFor(async () => expect(['pending-confirmation', 'failed']).toContain((await rpc.status(draft.id)).state), { timeout: 30_000, interval: 20 });
    wall.modifyStartToReady = performance.now() - started;
    const candidate2 = await rpc.status(draft.id);
    expect(candidate2.state, candidate2.error ?? JSON.stringify(candidate2.check)).toBe('pending-confirmation');
    await waitFor(() => expect(card2).toHaveAttribute('data-phase', 'ready'), { timeout: 5000 });
    expect(card2).toHaveTextContent('每日回忆 · v1.0.1');
    expect(card2).toHaveTextContent('相对 v1.0.0 的变化');
    expect(running(), 'running').toBe(true); // v1.0.0 keeps running until the user installs the new one
    started = performance.now();
    await clickEnabled(within(card2).getByTestId('workshop-action-install'));
    await waitFor(async () => {
      const status = await rpc.status(draft.id);
      expect(status.state, [status.error, alerts(chat2)].filter(Boolean).join('\n')).toBe('installed');
    }, { timeout: 15_000, interval: 20 });
    wall.modifyInstallClickToInstalled = performance.now() - started;
    expect((await packages.verify(pluginId)).version).toBe('1.0.1');
    await waitFor(() => expect(card2).toHaveAttribute('data-phase', 'installed'), { timeout: 5000 });
    await waitFor(() => expect(mine().getByTestId('plugin-card-origin')).toHaveTextContent('v1.0.1'), { timeout: 5000 });
    await clickEnabled(chat2.getByTestId('workshop-more'));
    fireEvent.click(await screen.findByTestId('workshop-menu-restore-previous'));
    await waitFor(async () => expect((await packages.verify(pluginId)).version, alerts(chat2)).toBe('1.0.0'), { timeout: 15_000 });
    await waitFor(async () => expect((await rpc.status(draft.id)).state).toBe('installed'));
    // The state was already 「已安装」 before going back: wait for the retained version to be running again.
    await waitFor(() => expect(running(), alerts(chat2) || 'running').toBe(true), { timeout: 5000 });
    expect(await rpc.status(draft.id)).toMatchObject({ version: '1.0.0' });

    step = 14;
    // ── 14. 卸载 from the chat card, then 恢复 from the same card ──
    await waitFor(() => expect(chat2.getByTestId('workshop-more')).toBeEnabled(), { timeout: 5000 });
    fireEvent.click(chat2.getByTestId('workshop-more'));
    fireEvent.click(await screen.findByTestId('workshop-menu-uninstall'));
    await waitFor(async () => expect((await rpc.status(draft.id)).state, alerts(chat2)).toBe('revoked'));
    expect(running(), 'running').toBe(false);
    await waitFor(() => expect(card2).toHaveAttribute('data-phase', 'undone'), { timeout: 5000 });
    await clickEnabled(chat2.getByTestId('workshop-restore'));
    await waitFor(async () => expect((await rpc.status(draft.id)).state, alerts(chat2)).toBe('installed'));
    expect(running(), 'running').toBe(true);
    expect(requests.filter(request => JSON.stringify(request.messages).includes('Host-controlled creation task'))).toHaveLength(2);

    process.stderr.write([
      '[workshop timings, no model — local SSE returns the files at once]',
      `  generate (local SSE round trip + write files): ${ms(timings.generate)}`,
      `  compile (esbuild + manifest): ${ms(timings.compile)}`,
      `  self-check (lifecycle load/unload): ${ms(timings.selfCheck)}`,
      `  install (Host op, incl. its self-check re-run): ${ms(timings.install)}`,
      `  restore (Host op): ${ms(timings.restore)}`,
      `  wall: 开始做→等你确认 ${Math.round(wall.startToReady)}ms; 安装→已安装 ${Math.round(wall.installClickToInstalled)}ms; 打开→窗口 ${Math.round(wall.openClickToWindow)}ms`,
      `  wall (modify): 开始做→等你确认 ${Math.round(wall.modifyStartToReady)}ms; 安装→已安装 ${Math.round(wall.modifyInstallClickToInstalled)}ms`,
    ].join('\n') + '\n');
    completed = true;
  } finally {
    // vitest runs silent: say where a failing run stopped.
    if (!completed) process.stderr.write(`[workshop e2e] stopped in step ${step}\n`);
    for (const off of cleanups) off();
    for (const view of views.reverse()) view.unmount();
    await loader?.dispose();
    await act(async () => { await ui.dispose(); });
    skillDefaults.remove('tutor-mode');
    resetChatNavigationHandshakeForTest();
    vi.restoreAllMocks();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await host.dispose();
  }
}, 120_000);
