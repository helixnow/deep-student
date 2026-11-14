// @vitest-environment node
// Host 测试宿主按 file: URL 定位模块与 package.json，jsdom 环境下 import.meta.url 不是 file:；渲染用 installDom()。
/**
 * example.word-of-day 端到端：Host 半经真实 profile 装载器（含社区插件清单筛查）装进测试宿主，UI 半装进真实 UI 内核，
 * 二者经 plugin:host|call 连接。覆盖：装载、UI 清单、远程调用放行/拒绝、贡献与渲染、i18n 命名空间隔离、配对、卸载，
 * 以及经官方聊天工具块渲染的 chat.toolResults 贡献。
 */
import '../../../testing/with-dom';
import type { Context } from '@deepseek-ai/cordis';
import i18next from 'i18next';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadProfile } from '../../../../host/kernel/profile.ts';
import type { TestHost } from '../../../../host/kernel/testing.ts';
import type { Block } from '../../../../src/features/chat/core/types/block';
import { McpToolBlockComponent } from '../../../../src/features/chat/plugins/blocks/mcpTool';
import { UiKernelProvider, UiPluginScopeProvider } from '../../../../src/ui-kernel/react';
import { memoryStorageBackend } from '../../../../src/ui-kernel/services/storage';
import { shellNavigationItems } from '../../../../src/ui-plugins/official/shell/navigation';
import { renderNavigationIcon } from '../../../../src/ui-plugins/official/shell/renderNavigationIcon';
import { defineUiPlugin, useSlotEntry, useT, type ShellNavItem } from '@deepstudent/ui';
import { createUiKernel, examplePath, installDom, installUiHalf, loadExample, pinLocalNoon, recordingI18n } from '../../../testing/harness';
import uiHalf, { DEFINE_WORD_TOOL, FAVORITES_KEY, localDate, messages, OPEN_COMMAND_ID, TOOL_RESULT_ID, VIEW_ID } from '../ui';
import { wordForDate } from '../words';

const ID = 'example.word-of-day';
const PROFILE = examplePath('community-word-of-day', 'test.profile.json');

let cleanups: (() => Promise<void>)[] = [];
beforeEach(pinLocalNoon);
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
});

async function setup(uiAdapters: Parameters<typeof createUiKernel>[1] = {}) {
  const { host, result } = await loadExample(PROFILE);
  const i18n = recordingI18n();
  const { kernel, commands } = createUiKernel(host, { i18n: i18n.adapter, ...uiAdapters });
  cleanups.push(async () => {
    await kernel.dispose();
    await host.dispose();
  });
  return { host, result, kernel, commands, i18n };
}

const uiManifest = (host: TestHost) => host.invoke<{ id: string; file: string; version?: string }[]>('plugin:ui|manifest', {});

/** 外壳渲染视图的方式：按 id 取 views 槽位的组件，不经 <SlotOutlet>。 */
function TodayView() {
  const View = useSlotEntry('views', VIEW_ID)?.value.component;
  return View ? <View /> : null;
}

describe('example.word-of-day: Host half', () => {
  it('passes the community manifest screening and provides the service named after its id', async () => {
    const { host, result } = await setup();
    expect(result.degraded).toEqual([]);
    expect(result.installed.map((p) => p.id)).toEqual([ID]);
    expect(host.ctx.get('exampleWordOfDay')).toBeDefined();
    expect(host.ctx.get('wordOfDay')).toBeUndefined();
  });

  it('lists the UI half in both UI manifests as a community plugin', async () => {
    const { host } = await setup();
    const [entry] = (await uiManifest(host)).filter((e) => e.id === ID);
    expect(entry?.version).toBe('1.0.0');
    expect(entry?.file).toBe(examplePath('community-word-of-day', 'dist', 'ui.js'));
    expect(path.isAbsolute(entry!.file)).toBe(true);
    const v2 = await host.invoke<{ plugins: { id: string; origin: string; platforms: string[] }[] }>('plugin:ui|manifest', { version: 2 });
    expect(v2.plugins.find((p) => p.id === ID)).toMatchObject({ origin: 'community', platforms: ['desktop'] });
  });

  it('only exposes the methods declared in meta.remote, to calls made from inside its UI half (they carry its id)', async () => {
    const { kernel } = await setup();
    const { host } = await installUiHalf(kernel, uiHalf);
    const remote = host.exampleWordOfDay!;
    await expect(remote.history!(['2026-11-03'])).resolves.toEqual([wordForDate('2026-11-03')]);
    await expect(remote.secret!()).rejects.toMatchObject({ error_type: 'Validation' });
    await expect(kernel.ui().host.exampleWordOfDay!.history!(['2026-11-03'])).rejects.toThrow(/only available inside a UI plugin/);
  });
});

describe('example.word-of-day: UI half', () => {
  it('contributes a view, a nav item and a command owned by the plugin, and renders data from the Host half', async () => {
    const navigate = vi.fn();
    const { kernel, commands } = await setup({ navigate });
    expect(await kernel.install(uiHalf)).toBe(true);
    expect(kernel.plugins().find((p) => p.id === ID)).toMatchObject({ origin: 'community', meta: { apiVersion: 2, namespace: ID }, hostPlugins: [ID] });
    expect(kernel.slots.list('views').map((e) => [e.key, e.owner, e.origin])).toEqual([[VIEW_ID, ID, 'community']]);
    expect(kernel.slots.list('nav').map((e) => [e.id, e.owner, e.value.viewId, e.value.labelKey])).toEqual([[VIEW_ID, ID, VIEW_ID, `${ID}:title`]]);
    expect(commands.list().map((c) => [c.id, c.name])).toEqual([[OPEN_COMMAND_ID, `${ID}:open`]]);

    installDom();
    const { render, within } = await import('@testing-library/react');
    const { container, unmount } = render(<UiKernelProvider kernel={kernel}><TodayView /></UiKernelProvider>);
    const today = wordForDate(localDate());
    expect(await within(container).findByRole('heading', { name: today.word })).toBeTruthy();
    unmount();

    await (commands.get(OPEN_COMMAND_ID)!.execute as () => void)();
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ view: VIEW_ID, source: ID }));
  });

  it('keeps favorites in a plugin store persisted to plugin storage, and shows the example sentence in a DsDialog', async () => {
    const storage = memoryStorageBackend();
    const { kernel } = await setup({ storage });
    await kernel.install(uiHalf);
    installDom();
    const { act, fireEvent, render, waitFor, within } = await import('@testing-library/react');
    const today = wordForDate(localDate());
    const view = render(<UiKernelProvider kernel={kernel}><TodayView /></UiKernelProvider>);
    const screen = within(view.container);
    await screen.findByRole('heading', { name: today.word });
    expect(screen.getByText('收藏夹里有 0 个单词')).toBeTruthy();

    await act(async () => fireEvent.click(screen.getByRole('button', { name: '收藏' })));
    expect(screen.getByRole('button', { name: '已收藏' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('收藏夹里有 1 个单词')).toBeTruthy();
    expect(storage.dump()).toEqual({ [`ds:plugin:${ID}:${FAVORITES_KEY}`]: JSON.stringify({ words: [today.word] }) });

    const page = within(document.body);
    expect(page.queryByRole('dialog')).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '例句' })));
    expect((await page.findByRole('dialog', { name: '例句' })).textContent).toContain(today.example);
    await act(async () => fireEvent.keyDown(document, { key: 'Escape' }));
    await waitFor(() => expect(page.queryByRole('dialog')).toBeNull());
    view.unmount();

    await kernel.unload(ID);
    await kernel.install(uiHalf);
    const again = render(<UiKernelProvider kernel={kernel}><TodayView /></UiKernelProvider>);
    expect((await within(again.container).findByRole('button', { name: '已收藏' })).getAttribute('aria-pressed')).toBe('true');
    again.unmount();
  });

  it.each([['macos', '⌘K'], ['windows', 'Ctrl+K'], ['linux', 'Ctrl+K']] as const)(
    'shows the command palette shortcut for the platform the shell reports (%s: %s)',
    async (os, shortcut) => {
      const { kernel } = await setup({ platform: { kind: 'desktop', os, capabilities: [] } });
      await kernel.install(uiHalf);
      installDom();
      const { render, within } = await import('@testing-library/react');
      const view = render(<UiKernelProvider kernel={kernel}><TodayView /></UiKernelProvider>);
      expect(await within(view.container).findByText(`也可以在命令面板（${shortcut}）里搜索“打开每日单词”`)).toBeTruthy();
      view.unmount();
    },
  );

  it('gets a place in both official sidebars although its nav item has no placement and no icon', async () => {
    const { kernel } = await setup();
    expect(await kernel.install(uiHalf)).toBe(true);
    const entries = kernel.slots.list<ShellNavItem>('nav');
    const context = { dev: false, uiLabEnabled: false };
    expect(shellNavigationItems(entries, context, 'desktop').map((i) => [i.id, i.desktop?.placement])).toEqual([[VIEW_ID, 'primary']]);
    expect(shellNavigationItems(entries, context, 'mobile').map((i) => [i.id, i.mobile?.placement])).toEqual([[VIEW_ID, 'launcher']]);
    expect(renderNavigationIcon('community', ID, VIEW_ID, entries[0]!.value.icon, {})).toBeNull();
  });

  it('shows the translated failure text when the Host half rejects and reports it; the third report unloads the plugin', async () => {
    const { host, kernel } = await setup();
    await kernel.install(uiHalf);
    // 生产中 Host 半不在时配对会撤下 UI 半；这里不同步 Host 状态，只借它让远程调用失败。
    await host.unload(ID);
    installDom();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { render, waitFor, within } = await import('@testing-library/react');
    const reason = 'unknown service "exampleWordOfDay"';
    for (let i = 0; i < 2; i++) {
      const view = render(<UiKernelProvider kernel={kernel}><TodayView /></UiKernelProvider>);
      expect((await within(view.container).findByRole('alert')).textContent).toBe(`加载失败：${reason}`);
      view.unmount();
    }
    expect(kernel.errors.list(ID).map((r) => [r.phase, r.slot, r.entryId, r.message])).toEqual([
      ['report', 'views', VIEW_ID, reason],
      ['report', 'views', VIEW_ID, reason],
    ]);
    expect(kernel.list()).toContain(ID);

    const view = render(<UiKernelProvider kernel={kernel}><TodayView /></UiKernelProvider>);
    await waitFor(() => expect(kernel.list()).not.toContain(ID));
    expect(kernel.errors.disabled()).toEqual([{ pluginId: ID, reason: 'error-budget', errors: 3, at: expect.any(Number) }]);
    expect(kernel.slots.list('views')).toEqual([]);
    view.unmount();
    consoleError.mockRestore();
  });

  it('writes texts only into the namespace derived from its id, which other plugins can neither write nor read', async () => {
    const { kernel, i18n } = await setup();
    const warn = vi.spyOn(console, 'warn');
    await kernel.install(uiHalf);
    expect([...new Set(i18n.written)]).toEqual([ID]);
    expect([...i18n.bundles.keys()].sort()).toEqual([`en-US/${ID}`, `zh-CN/${ID}`]);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('is deprecated'));
    warn.mockRestore();

    let v2: Context | undefined;
    let v1: Context | undefined;
    await kernel.install(defineUiPlugin({ meta: { id: 'example.other', apiVersion: 2 }, apply: (ctx) => { v2 = ctx; } }));
    await kernel.install(defineUiPlugin({ meta: { id: 'example.legacy' }, apply: (ctx) => { v1 = ctx; } }));
    expect(() => v2!.ui.i18n.addBundle('zh-CN', ID, { title: '冒名' })).toThrow(`namespace "${ID}" is not derived from plugin id "example.other"`);
    // 现在 v1 插件因命名空间已被认领而失败；W17 关掉 v1 回退（严格模式）后在派生检查处就失败。
    expect(() => v1!.ui.i18n.addBundle('zh-CN', ID, { title: '冒名' }))
      .toThrow(new RegExp(`namespace "${ID}" (belongs to plugin "${ID}"|is not derived from plugin id "example\\.legacy")`));
    v2!.ui.i18n.addBundles({ 'zh-CN': { title: '别的插件', secret: '泄漏' } });
    expect(i18n.bundles.get(`zh-CN/${ID}`)).toEqual(messages['zh-CN']);

    installDom();
    const { render, within } = await import('@testing-library/react');
    function Probe() {
      const t = useT();
      return <p>{[t('title'), t('secret'), t('example.other:title'), t('common:save')].join('|')}</p>;
    }
    const { container, unmount } = render(
      <UiKernelProvider kernel={kernel}>
        <UiPluginScopeProvider value={{ id: ID, origin: 'community' }}><Probe /></UiPluginScopeProvider>
      </UiKernelProvider>,
    );
    expect(within(container).getByText(/\|/).textContent).toBe('每日单词|secret|example.other:title|common:save');
    unmount();
  });

  it('resolves its nav and view label keys through i18next under the derived namespace', async () => {
    const instance = i18next.createInstance();
    await instance.init({ lng: 'zh-CN', fallbackLng: 'en-US', resources: {}, interpolation: { escapeValue: false } });
    const { kernel } = await setup({
      i18n: {
        addBundle: (lng, ns, resources) => {
          instance.addResourceBundle(lng, ns, resources, true, true);
          return () => instance.removeResourceBundle(lng, ns);
        },
      },
    });
    await kernel.install(uiHalf);
    const label = kernel.slots.list('nav')[0]!.value.labelKey;
    expect(instance.t(label)).toBe('每日单词');
    await instance.changeLanguage('en-US');
    expect(instance.t(label)).toBe('Word of the day');
    await kernel.unload(ID);
    expect(instance.hasResourceBundle('en-US', ID)).toBe(false);
  });

  it('follows its Host half: withheld while the Host half is missing, installed again when it comes back', async () => {
    const { host, kernel } = await setup();
    const sync = async () => kernel.hostStatus.update(await host.invoke('plugin:ui|manifest', { version: 2 }));
    await sync();
    expect(await kernel.install(uiHalf)).toBe(true);

    await host.unload(ID);
    await sync();
    await kernel.settled();
    expect(kernel.list()).not.toContain(ID);
    expect(kernel.slots.list('nav')).toEqual([]);
    expect(kernel.pairing()).toEqual([expect.objectContaining({ id: ID, availability: 'missing', active: false })]);

    expect((await loadProfile(host.runtime, PROFILE, { platform: 'desktop' })).degraded).toEqual([]);
    await sync();
    await kernel.settled();
    expect(kernel.list()).toContain(ID);
    expect(kernel.slots.list('nav').map((e) => e.id)).toEqual([VIEW_ID]);
    expect(kernel.pairing()).toEqual([expect.objectContaining({ id: ID, availability: 'available', active: true })]);
  });

  it('revokes every contribution, command and text bundle on unload, and the Host half stops listing it', async () => {
    const { host, kernel, commands, i18n } = await setup();
    await kernel.install(uiHalf);
    await kernel.unload(ID);
    expect(kernel.slots.list('views')).toEqual([]);
    expect(kernel.slots.list('nav')).toEqual([]);
    expect(kernel.slots.list('chat.toolResults')).toEqual([]);
    expect(commands.list()).toEqual([]);
    expect([...i18n.bundles.keys()]).toEqual([]);

    await host.unload(ID);
    expect(host.ctx.get('exampleWordOfDay')).toBeUndefined();
    expect((await uiManifest(host)).map((e) => e.id)).not.toContain(ID);
  });
});

/** 聊天里一次工具调用的 mcp_tool 块（字段同聊天流写进块里的）。 */
const toolBlock = (toolName: string, toolInput: Record<string, unknown>, status: Block['status'] = 'success'): Block => ({
  id: 'b1', type: 'mcp_tool', status, messageId: 'm1', toolName, toolInput, toolOutput: { definition: 'a happy accident' }, startedAt: 1, endedAt: 2,
} as Block);

describe('example.word-of-day: chat tool result', () => {
  it('adds a save button below the result of the dictionary MCP tool in the official tool block, into the favorites the view shows', async () => {
    const storage = memoryStorageBackend();
    const { kernel } = await setup({ storage });
    await kernel.install(uiHalf);
    expect(kernel.slots.list('chat.toolResults').map((e) => [e.id, e.key, e.owner, e.origin, e.value.placement, e.value.match]))
      .toEqual([[TOOL_RESULT_ID, DEFINE_WORD_TOOL, ID, 'community', 'actions', 'qualified']]);

    installDom();
    const { act, fireEvent, render, within } = await import('@testing-library/react');
    const chat = render(<UiKernelProvider kernel={kernel}><McpToolBlockComponent block={toolBlock('mcp_define_word', { word: 'serendipity' })} /></UiKernelProvider>);
    const block = within(chat.container);
    expect(chat.container.querySelector('.mcp-tool-block')?.textContent).toContain('a happy accident');
    await act(async () => fireEvent.click(block.getByRole('button', { name: '收藏“serendipity”' })));
    expect(block.getByRole('button', { name: '已收藏“serendipity”' }).getAttribute('aria-pressed')).toBe('true');
    expect(storage.dump()).toEqual({ [`ds:plugin:${ID}:${FAVORITES_KEY}`]: JSON.stringify({ words: ['serendipity'] }) });
    chat.unmount();

    const view = render(<UiKernelProvider kernel={kernel}><TodayView /></UiKernelProvider>);
    expect(await within(view.container).findByText('收藏夹里有 1 个单词')).toBeTruthy();
    view.unmount();
  });

  it('matches define_word by its base name only, leaves calls without a word and failed calls to the generic view, and goes away on unload', async () => {
    const { kernel } = await setup();
    await kernel.install(uiHalf);
    installDom();
    const { render, within } = await import('@testing-library/react');
    const saveButton = (block: Block) => {
      const view = render(<UiKernelProvider kernel={kernel}><McpToolBlockComponent block={block} /></UiKernelProvider>);
      expect(view.container.querySelector('.mcp-tool-block')).not.toBeNull();
      const text = within(view.container).queryByRole('button', { name: /收藏/ })?.textContent ?? null;
      view.unmount();
      return text;
    };
    for (const name of ['define_word', 'mcp_define_word', 'mcp.tools.define_word']) {
      expect(saveButton(toolBlock(name, { word: 'ephemeral' }))).toBe('收藏“ephemeral”');
    }
    expect(saveButton(toolBlock('mcp_define_words', { word: 'ephemeral' }))).toBeNull();
    expect(saveButton(toolBlock('mcp_define_word', {}))).toBeNull();
    expect(saveButton(toolBlock('mcp_define_word', { word: '  ' }))).toBeNull();
    expect(saveButton(toolBlock('mcp_define_word', { word: 'ephemeral' }, 'error'))).toBeNull();

    await kernel.unload(ID);
    expect(saveButton(toolBlock('mcp_define_word', { word: 'ephemeral' }))).toBeNull();
  });
});
