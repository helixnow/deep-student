import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { defineUiPlugin, UiKernel } from '../kernel';
import { SlotOutlet } from '../outlet';
import { memoryStorageBackend } from '../services/storage';
import { UiKernelProvider, useNavigate, usePlatform, usePluginErrors, usePluginStorage, usePluginStore, useT } from '../react';

function contribute(id: string, component: () => ReactNode) {
  return defineUiPlugin({ meta: { id }, apply: (ctx) => ctx.ui.contribute('hooks.test', { id: 'c', value: component }) });
}

async function setup(kernel: UiKernel) {
  await kernel.install(defineUiPlugin({ meta: { id: 'frame' }, apply: (ctx) => ctx.ui.declareSlot({ name: 'hooks.test', cardinality: 'list' }) }), { origin: 'builtin' });
}

describe('service hooks', () => {
  it('usePlatform follows shell refinements', async () => {
    const kernel = new UiKernel();
    function Os() {
      return <span>{usePlatform().os}</span>;
    }
    render(<UiKernelProvider kernel={kernel}><Os /></UiKernelProvider>);
    expect(screen.getByText('unknown')).toBeTruthy();
    act(() => kernel.platform.update({ os: 'macos' }));
    expect(screen.getByText('macos')).toBeTruthy();
  });

  it('useNavigate navigates with the contributing plugin as source', async () => {
    const navigate = vi.fn();
    const kernel = new UiKernel({ navigate });
    await setup(kernel);
    await kernel.install(defineUiPlugin({ meta: { id: 'views' }, apply: (ctx) => ctx.ui.views.register({ id: 'home', titleKey: 'home', component: () => null }) }));
    await kernel.install(contribute('community.links', function Link() {
      const go = useNavigate();
      return <button onClick={() => go('home', { from: 'link' })}>go</button>;
    }));
    render(<UiKernelProvider kernel={kernel}><SlotOutlet name="hooks.test" /></UiKernelProvider>);
    fireEvent.click(screen.getByText('go'));
    expect(navigate).toHaveBeenCalledWith({ view: 'home', params: { from: 'link' }, source: 'community.links' });
    await kernel.dispose();
  });

  it('usePluginStorage reads and writes the contributor\u2019s namespaced storage and syncs with ctx.ui.storage', async () => {
    const backend = memoryStorageBackend();
    const kernel = new UiKernel({ storage: backend });
    await setup(kernel);
    let ctx: Context | undefined;
    await kernel.install(defineUiPlugin({ meta: { id: 'community.counter' }, apply(c) {
      ctx = c;
      c.ui.contribute('hooks.test', { id: 'counter', value: function Counter() {
        const [count, setCount] = usePluginStorage('count', 0);
        return <button onClick={() => setCount((n) => n + 1)}>count {count}</button>;
      } });
    } }));
    render(<UiKernelProvider kernel={kernel}><SlotOutlet name="hooks.test" /></UiKernelProvider>);
    fireEvent.click(screen.getByText('count 0'));
    expect(screen.getByText('count 1')).toBeTruthy();
    expect(backend.dump()).toEqual({ 'ds:plugin:community.counter:count': '1' });
    act(() => ctx!.ui.storage.set('count', 41));
    expect(screen.getByText('count 41')).toBeTruthy();
    await kernel.dispose();
  });

  it('usePluginStore subscribes to a plugin store and sees the reset on unload', async () => {
    const kernel = new UiKernel();
    let store: ReturnType<Context['ui']['createStore']> | undefined;
    await kernel.install(defineUiPlugin({ meta: { id: 'community.state' }, apply: (ctx) => { store = ctx.ui.createStore({ count: 2 }); } }));
    function Count() {
      return <span>n={usePluginStore(store as never, (s: { count: number }) => s.count)}</span>;
    }
    render(<Count />);
    act(() => store!.setState({ count: 5 }));
    expect(screen.getByText('n=5')).toBeTruthy();
    await act(() => kernel.unload('community.state'));
    expect(screen.getByText('n=2')).toBeTruthy();
  });

  it('usePluginErrors lists budget reports; useT outside a plugin subtree explains itself', async () => {
    const kernel = new UiKernel();
    await kernel.install(defineUiPlugin({ meta: { id: 'community.err' }, apply: () => {} }));
    function Errors() {
      return <span>{usePluginErrors('community.err').map((e) => e.message).join(',') || 'none'}</span>;
    }
    render(<UiKernelProvider kernel={kernel}><Errors /></UiKernelProvider>);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    act(() => void kernel.errors.report({ pluginId: 'community.err', origin: 'community', phase: 'report', error: new Error('boom') }));
    expect(screen.getByText('boom')).toBeTruthy();
    function Orphan() {
      return <span>{useT()('x')}</span>;
    }
    expect(() => render(<UiKernelProvider kernel={kernel}><Orphan /></UiKernelProvider>)).toThrow('useT: must be used inside a plugin contribution');
    spy.mockRestore();
    await kernel.dispose();
  });
});
