import { act, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineUiPlugin, UiKernel, type UiAdapters, type UiPluginMeta } from '../kernel';
import { SlotOutlet } from '../outlet';
import { UiKernelProvider, usePluginScope, useT } from '../react';

declare module '../slot-map' {
  interface SlotMap {
    'test.widgets': { title: string; component: (props: { tone?: string }) => ReactNode };
  }
}

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errorSpy.mockRestore());

function declaring(kernel: UiKernel) {
  return kernel.install(defineUiPlugin({ meta: { id: 'dstu.frame.dashboard' }, apply: (ctx) => ctx.ui.declareSlot({ name: 'test.widgets', cardinality: 'list' }) }), { origin: 'builtin' });
}

function widget(meta: UiPluginMeta, title: string, component: (props: { tone?: string }) => ReactNode, order = 0) {
  return defineUiPlugin({ meta, apply: (ctx) => ctx.ui.contribute('test.widgets', { id: `${meta.id}/w`, order, value: { title, component } }) });
}

const Boom = (): ReactNode => {
  throw new Error('widget exploded');
};

function mount(kernel: UiKernel, outlet: ReactNode) {
  return render(<UiKernelProvider kernel={kernel}>{outlet}</UiKernelProvider>);
}

describe('SlotOutlet', () => {
  it('renders contributions in slot order; builtin entries get no extra DOM, community entries a data-ds-plugin scope', async () => {
    const kernel = new UiKernel();
    await declaring(kernel);
    await kernel.install(widget({ id: 'dstu.review' }, 'Review', ({ tone }) => <p>review:{tone}</p>, 10), { origin: 'builtin' });
    await kernel.install(widget({ id: 'community.stats' }, 'Stats', ({ tone }) => <p>stats:{tone}</p>, 20));
    const { container } = mount(kernel, <section><SlotOutlet name="test.widgets" props={{ tone: 'calm' }} /></section>);
    expect(container.querySelector('section')!.innerHTML).toBe(
      '<p>review:calm</p><div data-ds-plugin="community.stats" data-ds-slot="test.widgets" style="display: contents;"><p>stats:calm</p></div>',
    );
    await kernel.dispose();
  });

  it('isolates a failing contribution, keeps its siblings, reports to the kernel and to onError', async () => {
    const kernel = new UiKernel();
    await declaring(kernel);
    await kernel.install(widget({ id: 'dstu.review' }, 'Review', () => <p>review</p>, 10), { origin: 'builtin' });
    await kernel.install(widget({ id: 'community.broken' }, 'Broken', Boom, 20));
    await kernel.install(widget({ id: 'community.fine' }, 'Fine', () => <p>fine</p>, 30));
    const onError = vi.fn();
    mount(kernel, <SlotOutlet name="test.widgets" fallback={({ entry }) => <em>{entry.value.title} unavailable</em>} onError={onError} />);
    expect(screen.getByText('review')).toBeTruthy();
    expect(screen.getByText('fine')).toBeTruthy();
    expect(screen.getByText('Broken unavailable')).toBeTruthy();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toMatchObject({ phase: 'render', entry: { id: 'community.broken/w', owner: 'community.broken' } });
    expect(kernel.errors.list('community.broken')).toMatchObject([
      { pluginId: 'community.broken', origin: 'community', phase: 'render', slot: 'test.widgets', entryId: 'community.broken/w', message: 'widget exploded' },
    ]);
    await kernel.dispose();
  });

  it('supports custom render, filter (isolating filter errors) and empty states', async () => {
    const kernel = new UiKernel();
    await declaring(kernel);
    const { container, rerender } = mount(kernel, <SlotOutlet name="test.widgets" empty={<span>nothing yet</span>} />);
    expect(container.textContent).toBe('nothing yet');
    await act(() => kernel.install(widget({ id: 'a' }, 'Alpha', () => null, 1)));
    await act(() => kernel.install(widget({ id: 'b' }, 'Beta', () => null, 2)));
    rerender(
      <UiKernelProvider kernel={kernel}>
        <SlotOutlet
          name="test.widgets"
          filter={(entry) => {
            if (entry.owner === 'b') throw new Error('bad visibility');
            return true;
          }}
          render={(entry, index) => <b>{index}:{entry.value.title}</b>}
        />
      </UiKernelProvider>,
    );
    expect(container.textContent).toBe('0:Alpha');
    await waitFor(() => expect(kernel.errors.list('b')).toMatchObject([{ phase: 'filter', message: 'bad visibility' }]));
    await kernel.dispose();
  });

  it('falls back to a static table without a kernel provider (F1 §6.1 lightweight windows)', () => {
    const entries = [{ id: 'static', order: 0, owner: 'dstu.ui.content', origin: 'builtin' as const, value: { title: 'S', component: () => <i>static</i> } }];
    const { container } = render(<SlotOutlet name="test.widgets" entries={entries} />);
    expect(container.innerHTML).toBe('<i>static</i>');
  });

  it('auto-unloads a community plugin that exhausts its error budget; builtin plugins are only reported', async () => {
    const kernel = new UiKernel({}, { errorBudget: { community: 2 } });
    await declaring(kernel);
    await kernel.install(widget({ id: 'dstu.flaky' }, 'Official', Boom, 1), { origin: 'builtin' });
    await kernel.install(widget({ id: 'community.flaky' }, 'Flaky', Boom, 2));
    const first = mount(kernel, <SlotOutlet name="test.widgets" />);
    first.unmount();
    const second = mount(kernel, <SlotOutlet name="test.widgets" />);
    await waitFor(() => expect(kernel.list()).not.toContain('community.flaky'));
    expect(kernel.errors.disabled()).toMatchObject([{ pluginId: 'community.flaky', reason: 'error-budget', errors: 2 }]);
    expect(kernel.list()).toContain('dstu.flaky');
    expect(kernel.errors.count('dstu.flaky')).toBe(2);
    await waitFor(() => expect(second.container.querySelector('[data-ds-plugin]')).toBeNull());

    await kernel.install(widget({ id: 'community.flaky' }, 'Flaky v2', () => <p>fixed</p>, 2));
    expect(kernel.errors.count('community.flaky')).toBe(0);
    expect(kernel.errors.disabled()).toEqual([]);
    expect(await screen.findByText('fixed')).toBeTruthy();
    await kernel.dispose();
  });

  it('counts errors a plugin reports itself through ctx.ui.reportError', async () => {
    const kernel = new UiKernel({}, { errorBudget: { community: 1 } });
    let report: ((error: unknown) => void) | undefined;
    await kernel.install(defineUiPlugin({ meta: { id: 'community.self' }, apply: (ctx) => { report = (e) => ctx.ui.reportError(e); } }));
    report!(new Error('sync failed'));
    expect(kernel.errors.list('community.self')).toMatchObject([{ phase: 'report', message: 'sync failed' }]);
    await waitFor(() => expect(kernel.list()).toEqual([]));
  });

  it('provides the owning plugin scope so useT resolves the contributor namespace', async () => {
    const i18n: UiAdapters['i18n'] = { addBundle: () => () => {}, languages: () => ['en-US'] };
    const kernel = new UiKernel({ i18n });
    await declaring(kernel);
    function Title() {
      const t = useT();
      const scope = usePluginScope();
      return <h2>{scope?.id}:{t('title')}</h2>;
    }
    await kernel.install(defineUiPlugin({ meta: { id: 'community.stats' }, apply(ctx) {
      ctx.ui.i18n.addBundles({ 'en-US': { title: 'Stats' } });
      ctx.ui.contribute('test.widgets', { id: 'w', value: { title: 'x', component: Title } });
    } }));
    mount(kernel, <SlotOutlet name="test.widgets" />);
    expect(screen.getByRole('heading').textContent).toBe('community.stats:Stats');
    await kernel.dispose();
  });

  it('stops rendering a plugin\u2019s entries once it unloads', async () => {
    const kernel = new UiKernel();
    await declaring(kernel);
    await kernel.install(widget({ id: 'community.gone' }, 'Gone', () => <p>here</p>));
    const { container } = mount(kernel, <SlotOutlet name="test.widgets" />);
    expect(container.textContent).toBe('here');
    await act(() => kernel.unload('community.gone'));
    expect(container.textContent).toBe('');
    await kernel.dispose();
  });
});
