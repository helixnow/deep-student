/**
 * SDK 最小示例：一个“学习统计”仪表盘小部件（只在本测试里，不装进应用）。
 * 覆盖 README 的全部概念：definePlugin、SlotMap 声明合并、contribution/contributeAll、SlotOutlet、
 * 命名空间文案 useT、插件存储 usePluginStorage、插件状态 createPluginStore、导航 useNavigate、卸载即撤销。
 */
import { fireEvent, render, screen, act } from '@testing-library/react';
import type { ComponentType } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { UiKernel } from '../../ui-kernel/kernel';
import { UiKernelProvider } from '../../ui-kernel/react';
import { memoryStorageBackend } from '../../ui-kernel/services/storage';
import {
  contributeAll, contribution, createPluginStore, definePlugin, defineSlot, SlotOutlet,
  useNavigate, usePluginStorage, usePluginStore, useT, type PluginStore,
} from '../index';

// ---- 框架插件（拥有槽位的一方）：声明槽位及其值类型 -------------------------------------------
interface DashboardWidget {
  titleKey: string;
  size: 'sm' | 'md';
  component: ComponentType;
}

declare module '../index' {
  interface SlotMap {
    'dashboard.widgets': DashboardWidget;
  }
}

const dashboardFrame = definePlugin({
  meta: { id: 'dstu.frame.dashboard', platforms: ['desktop', 'mobile'] },
  apply(ctx) {
    ctx.ui.declareSlot(defineSlot('dashboard.widgets', 'list', '仪表盘小部件'));
  },
});

// ---- 功能插件（约 40 行）---------------------------------------------------------------------
let reviews: PluginStore<{ done: number }> | undefined;

function StudyStatsWidget() {
  const t = useT();
  const [days, setDays] = usePluginStorage('days', 7);
  const done = usePluginStore(reviews!, (s) => s.done);
  const navigate = useNavigate();
  return (
    <section>
      <h3>{t('title', { days })}</h3>
      <p>{t('done', { count: done })}</p>
      <button onClick={() => setDays(days === 7 ? 30 : 7)}>{t('range')}</button>
      <button onClick={() => navigate('study-stats', { from: 'dashboard' })}>{t('open')}</button>
    </section>
  );
}

const studyStats = definePlugin({
  meta: { id: 'acme.study-stats', version: '0.1.0', platforms: ['desktop', 'mobile'], host: true },
  apply(ctx) {
    ctx.ui.i18n.addBundles({
      'en-US': { title: 'Last {{days}} days', done_one: '{{count}} review', done_other: '{{count}} reviews', range: 'Switch range', open: 'Open' },
    });
    reviews = createPluginStore(ctx, { done: 0 });
    contributeAll(ctx, [
      contribution('views', { id: 'study-stats', key: 'study-stats', value: { id: 'study-stats', titleKey: 'acme.study-stats:title', component: () => null } }),
      contribution('dashboard.widgets', { id: 'study-stats', order: 900, value: { titleKey: 'title', size: 'md', component: StudyStatsWidget } }),
    ]);
  },
});

// ---------------------------------------------------------------------------------------------
describe('SDK minimal example: study-stats widget', () => {
  it('renders through SlotOutlet with namespaced texts, storage, store and navigation, and revokes everything on unload', async () => {
    const navigate = vi.fn();
    const storage = memoryStorageBackend();
    const kernel = new UiKernel({ navigate, storage, i18n: { addBundle: () => () => {}, languages: () => ['en-US'] } });
    await kernel.install(dashboardFrame, { origin: 'builtin' });
    await kernel.install(studyStats);
    expect(kernel.plugins().find((p) => p.id === 'acme.study-stats')?.hostPlugins).toEqual(['acme.study-stats']);

    const { container } = render(
      <UiKernelProvider kernel={kernel}>
        <SlotOutlet name="dashboard.widgets" />
      </UiKernelProvider>,
    );
    expect(screen.getByRole('heading').textContent).toBe('Last 7 days');
    expect(container.querySelector('[data-ds-plugin="acme.study-stats"]')).not.toBeNull();

    fireEvent.click(screen.getByText('Switch range'));
    expect(screen.getByRole('heading').textContent).toBe('Last 30 days');
    expect(storage.dump()).toEqual({ 'ds:plugin:acme.study-stats:days': '30' });

    act(() => reviews!.setState({ done: 1 }));
    expect(screen.getByText('1 review')).toBeTruthy();

    fireEvent.click(screen.getByText('Open'));
    expect(navigate).toHaveBeenCalledWith({ view: 'study-stats', params: { from: 'dashboard' }, source: 'acme.study-stats' });

    await act(() => kernel.unload('acme.study-stats'));
    expect(container.textContent).toBe('');
    expect(kernel.slots.list('views')).toEqual([]);
    expect(reviews!.getState()).toEqual({ done: 0 });
    expect(storage.dump()).toEqual({ 'ds:plugin:acme.study-stats:days': '30' });
    await kernel.dispose();
  });
});
