// RUST-FIX(RF-P6-manager-cards): 我的插件卡片、做一个新的、锁定的基础服务、渠道空行与详情抽屉。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';

import { UiKernelProvider } from '@/ui-kernel/react';
import { showGlobalNotification } from '@/components/UnifiedNotification';

import { PluginManagerPanel } from '../PluginManagerPanel';
import { PluginManagerController } from '../controller';
import { pluginAdditions, pluginIsEssential, pluginMonogram, pluginTint, PLUGIN_TINTS } from '../presentation';
import type { ManagedPlugin } from '../types';
import type { PluginManagerWorkshop } from '../workshop';
import { FakePluginManagerAdapter, managedPlugin } from './fixtures';

vi.mock('react-i18next', async () => (await import('./i18nMock')).i18nMock());
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('@/features/settings/api/pluginsApi', () => ({
  pluginsApi: { list: vi.fn(async () => []) },
  PLUGIN_EVENTS: { stateChanged: 'plugin-state-changed', qrcode: 'plugin-qrcode', activity: 'plugin-activity' },
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

const CONTRIBUTIONS_KEY = 'ds:plugin-manager:contribution-points';

/** 最小的 UI 内核替身：只有管理页读的槽位归属与导航。 */
function fakeKernel(slots: Record<string, { owner: string; key?: string }[]>) {
  const navigate = vi.fn();
  const kernel = {
    slots: {
      definitions: () => Object.keys(slots).map((name) => ({ name })),
      list: (name: string) => (slots[name] ?? []).map((entry) => ({ origin: 'community', ...entry })),
      subscribe: () => () => undefined,
    },
    navigation: { canNavigate: () => true, navigate },
  };
  return { kernel: kernel as never, navigate };
}

function setup(plugins: ManagedPlugin[], options: { workshop?: PluginManagerWorkshop; wrap?: (node: ReactNode) => ReactNode } = {}) {
  const adapter = new FakePluginManagerAdapter(plugins);
  const controller = new PluginManagerController(adapter);
  const panel = <PluginManagerPanel controller={controller} workshop={options.workshop} />;
  render(<>{options.wrap ? options.wrap(panel) : panel}</>);
  return { adapter, controller, user: userEvent.setup() };
}

const workshopStub = (overrides: Partial<PluginManagerWorkshop> = {}): PluginManagerWorkshop => ({
  onCreate: vi.fn(), onModify: vi.fn(), creations: null, ...overrides,
});

beforeEach(() => { localStorage.removeItem(CONTRIBUTIONS_KEY); });
afterEach(() => { vi.mocked(showGlobalNotification).mockClear(); });

describe('what a plugin adds (chips)', () => {
  it('maps Host-known and UI-kernel contribution points to user words, once each, in a fixed order', () => {
    const plugin = managedPlugin({ origin: 'community', contributes: ['agent.tools'] });
    expect(pluginAdditions(plugin, ['nav', 'views', 'editor.selectionToolbar', 'chat.toolResults', 'genui.components', 'unknown.slot']))
      .toEqual(['app', 'selectionButton', 'agentTool', 'chatCard']);
    // The sidebar entry that leads to a view is not a second thing; alone it is a navigation entry.
    expect(pluginAdditions(managedPlugin(), ['nav'])).toEqual(['navEntry']);
    expect(pluginAdditions(managedPlugin({ agentTools: [{ name: 't', title: 'T' }] }))).toEqual(['agentTool']);
    expect(pluginAdditions(managedPlugin())).toEqual([]);
  });

  it('renders chips from the manifest, live slots and the remembered points of a disabled plugin', async () => {
    localStorage.setItem(CONTRIBUTIONS_KEY, JSON.stringify({ 'workshop.mnemonic': ['editor.selectionToolbar'] }));
    const { kernel } = fakeKernel({ views: [{ owner: 'workshop.formula', key: 'formula-view' }], nav: [{ owner: 'workshop.formula', key: 'formula-nav' }] });
    setup([
      managedPlugin({ id: 'workshop.formula', origin: 'community', source: 'workshop', displayName: '公式速查' }),
      managedPlugin({ id: 'workshop.mnemonic', origin: 'community', source: 'workshop', displayName: '编成口诀', enabled: false, runtime: 'stopped' }),
      managedPlugin({ id: 'workshop.timetable', origin: 'community', source: 'workshop', displayName: '查课表', contributes: ['agent.tools'], agentTools: [{ name: 'today', title: '查今天的课' }] }),
      managedPlugin({ id: 'community.silent', origin: 'community', displayName: '安静' }),
    ], { wrap: (node) => <UiKernelProvider kernel={kernel}>{node}</UiKernelProvider> });
    const chips = (id: string) => {
      const card = screen.getAllByTestId('plugin-card').find((element) => element.getAttribute('data-plugin-id') === id)!;
      return [...card.querySelectorAll('[data-testid="plugin-adds"] li')].map((chip) => chip.textContent);
    };
    await screen.findByText('公式速查');
    expect(chips('workshop.formula')).toEqual(['新应用']);
    expect(chips('workshop.mnemonic')).toEqual(['选区按钮']);
    expect(chips('workshop.timetable')).toEqual(['AI 助手新本事']);
    expect(chips('community.silent')).toEqual([]);
    expect(screen.getAllByRole('list', { name: '它增加了' })).toHaveLength(3);
  });
});

describe('my plugins as cards', () => {
  it('gives each card a stable tinted monogram, its own icon glyph when it brings one, and a switch by its name', async () => {
    const formula = managedPlugin({ id: 'workshop.formula', origin: 'community', displayName: '公式速查' });
    expect(pluginTint(formula.id)).toBe(pluginTint('workshop.formula'));
    expect(PLUGIN_TINTS).toContain(pluginTint(formula.id));
    expect(pluginMonogram(formula, '公式速查')).toBe('公');
    expect(pluginMonogram(managedPlugin({ icon: 'Package' }), 'exporter')).toBe('E');
    expect(pluginMonogram(managedPlugin({ icon: '🧮' }), 'x')).toBe('🧮');
    setup([formula]);
    const card = await screen.findByTestId('plugin-card');
    expect(within(card).getByTestId('plugin-tile')).toHaveTextContent('公');
    const heading = within(card).getByRole('heading', { name: '公式速查' });
    expect(card).toHaveAttribute('aria-labelledby', heading.id);
    expect(within(card).getByRole('switch', { name: '启用 公式速查' })).toBeInTheDocument();
    expect(within(card).getByTestId('plugin-summary-state')).toHaveAttribute('data-tone', 'ok');
  });

  it('opens a plugin that registered an app, and offers the consent step first when one is pending', async () => {
    const { kernel, navigate } = fakeKernel({ views: [{ owner: 'workshop.formula', key: 'formula-view' }] });
    const { user } = setup([
      managedPlugin({ id: 'workshop.formula', origin: 'community', displayName: '公式速查' }),
      managedPlugin({ id: 'community.pending', origin: 'community', displayName: '待同意', consent: 'required', runtime: 'stopped' }),
    ], { wrap: (node) => <UiKernelProvider kernel={kernel}>{node}</UiKernelProvider> });
    await user.click(await screen.findByRole('button', { name: '打开 公式速查' }));
    expect(navigate).toHaveBeenCalledWith('dstu.plugin-manager', 'formula-view');
    expect(screen.getByRole('button', { name: '查看 待同意 需要的权限并允许' })).toHaveTextContent('允许并启用');
    // Not allowed yet means not running: the switch says off until 「允许并启用」.
    expect(screen.getByRole('switch', { name: '启用 待同意' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByRole('button', { name: '打开 待同意' })).toBeNull();
  });

  it('shows where a plugin came from instead of a trust-tier chip', async () => {
    setup([
      managedPlugin({ id: 'workshop.formula', origin: 'community', source: 'workshop', trust: 'full', displayName: '公式速查', version: '1.0.0' }),
      managedPlugin({ id: 'community.file', origin: 'community', source: 'package', trust: 'restricted', author: '小林', displayName: '导入的', version: '2.0.0' }),
      managedPlugin({ id: 'community.anon', origin: 'community', source: 'package', trust: 'restricted', author: undefined, displayName: '匿名', version: '0.1.0' }),
    ]);
    const origins = (await screen.findAllByTestId('plugin-card-origin')).map((node) => node.textContent);
    expect(origins).toEqual(['你让 AI 做的 · v1.0.0', '来自文件 · 作者 小林 · v2.0.0', '来源未知 · v0.1.0']);
    expect(screen.queryByTestId('plugin-trust-badge')).toBeNull();
    expect(screen.queryByText('完全信任')).toBeNull();
    expect(screen.queryByText('受限')).toBeNull();
    expect(screen.queryByText('社区')).toBeNull();
  });

  it('offers modify, details, export, rollback and uninstall from the overflow menu', async () => {
    const onModify = vi.fn();
    const onExport = vi.fn(async () => 'D:/exports/formula-1.2.0.dstuplugin');
    const onRestorePrevious = vi.fn(async () => undefined);
    const works = vi.fn(async () => [{ pluginId: 'workshop.formula', version: '1.2.0', previousVersion: '1.1.0', changes: ['新增电磁学章节'] }]);
    const { user, adapter } = setup([
      managedPlugin({ id: 'workshop.formula', origin: 'community', source: 'workshop', version: '1.2.0', displayName: '公式速查' }),
    ], { workshop: workshopStub({ onModify, onExport, onRestorePrevious, works }) });
    const more = await screen.findByRole('button', { name: '公式速查 的更多操作' });

    await user.click(more);
    await waitFor(() => expect(screen.getByRole('menuitem', { name: '回到上一版（v1.1.0）' })).toBeInTheDocument());
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['让 AI 改', '详情', '停用', '导出', '回到上一版（v1.1.0）', '卸载']);
    await user.click(screen.getByRole('menuitem', { name: '让 AI 改' }));
    expect(onModify).toHaveBeenCalledWith('workshop.formula');

    await user.click(more);
    await user.click(screen.getByRole('menuitem', { name: '导出' }));
    await waitFor(() => expect(showGlobalNotification).toHaveBeenCalledWith('success', '已导出 公式速查：D:/exports/formula-1.2.0.dstuplugin'));

    await user.click(more);
    await user.click(screen.getByRole('menuitem', { name: '回到上一版（v1.1.0）' }));
    const restore = screen.getByRole('alertdialog');
    expect(onRestorePrevious).not.toHaveBeenCalled();
    await user.click(within(restore).getByRole('button', { name: '回到上一版' }));
    await waitFor(() => expect(onRestorePrevious).toHaveBeenCalledWith('workshop.formula'));

    await user.click(more);
    await user.click(screen.getByRole('menuitem', { name: '卸载' }));
    const uninstall = await screen.findByRole('alertdialog');
    expect(uninstall).toHaveTextContent('卸载『公式速查』？');
    expect(uninstall).not.toHaveTextContent('workshop.formula');
    expect(uninstall).not.toHaveTextContent('1.2.0');
    expect(adapter.calls.uninstall).toEqual([]);
  });

  it('hides version and workshop actions the host cannot back, keeping details and uninstall', async () => {
    const { user } = setup([managedPlugin({ id: 'community.file', origin: 'community', source: 'package', displayName: '导入的' })],
      { workshop: workshopStub() });
    await user.click(await screen.findByRole('button', { name: '导入的 的更多操作' }));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['详情', '停用', '卸载']);
  });

  it('opens details in a sheet from the menu and returns focus to that menu button when it closes', async () => {
    const { user } = setup([
      managedPlugin({ id: 'workshop.timetable', origin: 'community', source: 'workshop', displayName: '查课表', trust: 'full', consent: 'granted',
        permissions: ['agent:tools', 'net:calendar.example.edu.cn', 'service:notes'], agentTools: [{ name: 'today', title: '查今天的课' }] }),
    ]);
    await user.click(await screen.findByRole('button', { name: '查课表 的更多操作' }));
    await user.click(screen.getByRole('menuitem', { name: '详情' }));
    const sheet = await screen.findByRole('dialog');
    const detail = within(sheet).getByTestId('plugin-detail');
    expect(within(detail).getByTestId('plugin-detail-tools')).toHaveTextContent('AI 助手学会的新本事：查今天的课');
    const permissions = within(detail).getByTestId('plugin-detail-permissions');
    expect([...permissions.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      '让 AI 助手学会新本事「查今天的课」', '联网读取 calendar.example.edu.cn（只读，仅限这个域名）', '使用应用服务「笔记」',
    ]);
    // Raw strings only under 技术信息.
    expect(permissions).not.toHaveTextContent('service:notes');
    expect(within(detail).getByTestId('plugin-detail-raw-permissions')).toHaveTextContent('agent:tools, net:calendar.example.edu.cn, service:notes');
    expect(within(detail).getByTestId('plugin-detail-consent')).toHaveTextContent('你已同意当前这一版的权限。');
    expect(within(detail).getByTestId('plugin-detail-id')).toHaveTextContent('workshop.timetable');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(screen.getByRole('button', { name: '查课表 的更多操作' })).toHaveFocus());
  });
});

describe('detail sheet', () => {
  it('shows no settings section, revision or save button for a plugin without config', async () => {
    const { user, adapter } = setup([
      managedPlugin({ id: 'community.plain', origin: 'community', displayName: '无配置', configurable: false }),
      managedPlugin({ id: 'community.empty-schema', origin: 'community', displayName: '空配置' }),
    ]);
    await user.click(await screen.findByRole('button', { name: '查看 无配置 的详情' }));
    let sheet = await screen.findByRole('dialog');
    expect(within(sheet).queryByTestId('plugin-detail-settings')).toBeNull();
    expect(within(sheet).queryByRole('button', { name: '保存' })).toBeNull();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    adapter.config = { schema: { type: 'object', dict: {} }, values: {}, revision: 1 };
    await user.click(screen.getByRole('button', { name: '查看 空配置 的详情' }));
    sheet = await screen.findByRole('dialog');
    await waitFor(() => expect(adapter.calls.readConfig).toContain('community.empty-schema'));
    await waitFor(() => expect(within(sheet).queryByText('正在读取配置')).toBeNull());
    expect(within(sheet).queryByTestId('plugin-detail-settings')).toBeNull();
    expect(within(sheet).queryByText(/修订号/)).toBeNull();
    expect(within(sheet).queryByRole('button', { name: '保存' })).toBeNull();
  });

  it('says in plain words what changed when the consent no longer matches', async () => {
    const { user } = setup([
      managedPlugin({ id: 'community.changed', origin: 'community', displayName: '变了', consent: 'required', consentReason: 'permissions', runtime: 'stopped' }),
    ]);
    await user.click(await screen.findByRole('button', { name: '查看 变了 的详情' }));
    const line = within(await screen.findByRole('dialog')).getByTestId('plugin-detail-consent');
    expect(line).toHaveTextContent('权限变了，需要你重新确认。');
    expect(line).toHaveAttribute('data-consent-reason', 'permissions');
  });
});

describe('empty states and starters', () => {
  it('invites a first plugin and keeps the starters available when the user has none', async () => {
    const onCreate = vi.fn();
    const { user } = setup([managedPlugin({ id: 'dstu.notes', category: 'learning' })], { workshop: workshopStub({ onCreate }) });
    expect(await screen.findByTestId('plugin-mine-empty')).toHaveTextContent('还没有你自己的插件');
    expect(screen.getByTestId('plugin-count-community')).toHaveTextContent('0');
    await user.click(screen.getAllByTestId('plugin-starter')[2]!);
    expect(onCreate).toHaveBeenCalledWith('教它一项新本事：说一句「查课表」就列出今天的课');
    expect(screen.getByTestId('plugin-import')).toHaveTextContent('从文件导入');
    // The free-form entry is the same clickable pill as the starters, not loose text.
    expect(screen.getByTestId('plugin-create').className).toContain('bg-muted');
    expect(screen.getByTestId('plugin-create').className).toContain('!rounded-full');
  });

  it('shows a single quiet channel row when there are no channel plugins', async () => {
    setup([managedPlugin()]);
    const row = await screen.findByTestId('channel-empty-row');
    expect(row).toHaveTextContent('渠道插件');
    expect(row).toHaveTextContent('未发现渠道插件');
    expect(screen.queryByRole('heading', { name: '渠道插件' })).toBeNull();
  });

  it('never invents store listings, ratings or download counts', async () => {
    setup([managedPlugin()], { workshop: workshopStub() });
    await screen.findByTestId('plugin-starters');
    expect(screen.queryByText(/评分|下载|安装量|rating|downloads/i)).toBeNull();
  });
});

describe('built-in capabilities', () => {
  const base = (overrides: Partial<ManagedPlugin> = {}) => managedPlugin({
    id: 'dstu.platform.storage', category: 'platform', displayName: '本地存储', requiredBy: ['dstu.notes', 'dstu.chat', 'dstu.qbank'], ...overrides,
  });

  it('treats only an enabled built-in that other plugins use as essential', () => {
    expect(pluginIsEssential(base())).toBe(true);
    expect(pluginIsEssential(base({ enabled: false }))).toBe(false);
    expect(pluginIsEssential(base({ requiredBy: [] }))).toBe(false);
    expect(pluginIsEssential(base({ origin: 'community' }))).toBe(false);
  });

  it('locks a base service with the reason instead of a switch, and keeps switches elsewhere', async () => {
    const { user, adapter } = setup([
      base(),
      managedPlugin({ id: 'dstu.notes', category: 'learning', displayName: '笔记' }),
      managedPlugin({ id: 'dstu.chat', category: 'conversation', displayName: '对话' }),
      managedPlugin({ id: 'dstu.translation', category: 'conversation', displayName: '翻译', requiredBy: ['dstu.chat'], enabled: false, runtime: 'stopped' }),
    ]);
    const lockedRow = (await screen.findAllByTestId('plugin-row')).find((row) => row.getAttribute('data-plugin-id') === 'dstu.platform.storage')!;
    expect(lockedRow).toHaveAttribute('data-locked', 'true');
    expect(within(lockedRow).queryByRole('switch', { hidden: true })).toBeNull();
    const lock = within(lockedRow).getByTestId('plugin-locked');
    expect(lock).toHaveAttribute('tabindex', '0');
    expect(lock).toHaveTextContent('笔记、对话 等 3 项功能正在使用它提供的服务');
    // A disabled plugin is never locked: turning it back on must stay possible.
    expect(screen.getByRole('switch', { name: '启用 翻译', hidden: true })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: '启用 笔记', hidden: true })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '查看 本地存储 的详情', hidden: true }));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).queryByRole('switch')).toBeNull();
    expect(within(sheet).getByTestId('plugin-detail-locked')).toHaveTextContent('不提供开关');
    expect(adapter.calls.setEnabled).toEqual([]);
  });
});

describe('first-use pass: removal, waiting works and primary actions', () => {
  it('uninstalls a workshop work through the workshop, in plain words with no id or version', async () => {
    const onUninstall = vi.fn(async () => undefined);
    const { user, adapter } = setup([
      managedPlugin({ id: 'workshop.formula', origin: 'community', source: 'workshop', version: '1.2.0', displayName: '公式速查' }),
    ], { workshop: workshopStub({ onUninstall }) });
    await user.click(await screen.findByRole('button', { name: '公式速查 的更多操作' }));
    await user.click(screen.getByRole('menuitem', { name: '卸载' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('卸载『公式速查』？');
    expect(dialog).toHaveTextContent('它会从应用里消失。它保存的数据会留着，做过的版本也保留在工坊里，可以在「工坊创作记录」里恢复。');
    expect(dialog).not.toHaveTextContent('workshop.formula');
    await user.click(within(dialog).getByRole('button', { name: '卸载' }));
    await waitFor(() => expect(onUninstall).toHaveBeenCalledWith('workshop.formula'));
    expect(adapter.calls.uninstall).toEqual([]);
  });

  it('opens 工坊创作记录 by itself when something waits for confirmation', async () => {
    const pending = vi.fn(async () => [{ pluginId: 'workshop.x', name: '公式速查', phase: 'ready' }]);
    setup([], { workshop: workshopStub({ pending, creations: <p>creations-mounted</p> }) });
    expect(await screen.findByText('creations-mounted')).toBeInTheDocument();
    expect(screen.getByTestId('plugin-creations-toggle')).toHaveTextContent('工坊创作记录 · 1 个等你确认');
    expect(screen.getByTestId('plugin-creations-toggle')).toHaveAttribute('aria-expanded', 'true');
  });

  it('labels workshop works 「你让 AI 做的」 and offers 「试一句」 for a running AI skill', async () => {
    setup([managedPlugin({ id: 'workshop.timetable', origin: 'community', source: 'workshop', displayName: '查课表', version: '1.0.0',
      enabled: true, runtime: 'running', consent: 'granted', permissions: ['agent:tools'], agentTools: [{ name: 'today', title: '查课表' }] })]);
    expect(await screen.findByTestId('plugin-card-origin')).toHaveTextContent('你让 AI 做的 · v1.0.0');
    expect(screen.getByTestId('plugin-card-try-say')).toHaveTextContent('试一句『查课表』');
    expect(screen.getByTestId('plugin-adds-label')).toHaveTextContent('它增加了');
    expect(screen.getByText('AI 助手新本事')).toHaveAttribute('title', 'AI 助手学会的新本事，对它说一句就能用');
  });
});
