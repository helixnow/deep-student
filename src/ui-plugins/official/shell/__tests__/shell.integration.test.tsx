import React, { lazy, Suspense } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defineUiPlugin, UiKernel } from '@/ui-kernel/kernel';
import { UiKernelProvider, useSlot } from '@/ui-kernel/react';
import type { ShellView } from '@/ui-kernel/contracts/shell';
import { MobileAppNavigationProvider, MobileSidebarNavigation } from '@/components/layout/MobileSidebarNavigation';
import { useViewStore } from '@/stores/viewStore';
import { RegisteredViewLayer } from '../RegisteredViewLayer';
import shellPlugin from '../index';
import type { CurrentView } from '@/types/navigation';

let kernel: UiKernel;
beforeEach(async () => {
  kernel = new UiKernel();
  await kernel.install(shellPlugin, { origin: 'builtin' });
  useViewStore.setState({ currentView: 'chat-v2', previousView: null });
});
afterEach(async () => {
  cleanup();
  await kernel.dispose();
});

it('renders the original seven mobile destinations and revokes them when the shell plugin unloads', async () => {
  render(<UiKernelProvider kernel={kernel}><MobileSidebarNavigation /></UiKernelProvider>);
  expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(['会话', '资源', '音视频', '待办', '技能', '闪卡', '数据']);
  expect(screen.getByRole('navigation')).toHaveClass('grid-cols-3');
  await act(() => kernel.unload('dstu.ui.shell'));
  expect(screen.queryAllByRole('button')).toHaveLength(0);
  await act(() => kernel.install(shellPlugin, { origin: 'builtin' }));
  expect(screen.getAllByRole('button')).toHaveLength(7);
});

it('preserves the keyboard navigation rejection path and settings-only drawer entry', () => {
  const navigate = vi.fn(() => false);
  const onNavigate = vi.fn();
  render(<UiKernelProvider kernel={kernel}><MobileAppNavigationProvider navigate={navigate}>
    <MobileSidebarNavigation settingsOnly onNavigate={onNavigate} />
  </MobileAppNavigationProvider></UiKernelProvider>);
  fireEvent.click(screen.getByRole('button', { name: '设置' }));
  expect(navigate).toHaveBeenCalledWith('settings');
  expect(onNavigate).not.toHaveBeenCalled();
});

function Views({ currentView, visited, contents = {} }: { currentView: CurrentView; visited: Set<CurrentView>; contents?: Record<string, React.ReactNode> }) {
  const entries = useSlot<ShellView>('views');
  return <>{entries.map(({ value }) => <RegisteredViewLayer
    key={value.id} entry={value} view={value.id as CurrentView} currentView={currentView}
    visitedViews={visited} errorBoundaryName={value.id} extraClass={value.extraClass}
    content={value.contentKey ? contents[value.contentKey] : undefined}
  />)}</>;
}

it('keeps unvisited pages lazy, preserves memoized hidden contents, and removes rendered views on unload', async () => {
  const load = vi.fn(async () => ({ default: () => <div>lazy dashboard</div> }));
  const Dashboard = lazy(load);
  const chatRender = vi.fn();
  function Chat() { chatRender(); return <div>chat contents</div>; }
  const contents = { dashboardContent: <Suspense fallback={null}><Dashboard /></Suspense>, chatV2Content: <Chat /> };
  const { rerender } = render(<UiKernelProvider kernel={kernel}><Views currentView="chat-v2" visited={new Set(['chat-v2'])} contents={contents} /></UiKernelProvider>);
  expect(load).not.toHaveBeenCalled();
  expect(chatRender).toHaveBeenCalledTimes(1);
  rerender(<UiKernelProvider kernel={kernel}><Views currentView="dashboard" visited={new Set(['chat-v2', 'dashboard'])} contents={contents} /></UiKernelProvider>);
  expect(await screen.findByText('lazy dashboard')).toBeTruthy();
  expect(load).toHaveBeenCalledTimes(1);
  expect(chatRender).toHaveBeenCalledTimes(1);
  await act(() => kernel.unload('dstu.ui.shell'));
  expect(screen.queryByText('chat contents')).toBeNull();
  expect(screen.queryByText('lazy dashboard')).toBeNull();
});

it('isolates a failing contributed view with the existing view error boundary', async () => {
  await kernel.install(defineUiPlugin({ meta: { id: 'community.broken' }, apply(ctx) {
    ctx.ui.views.register({ id: 'community-broken', titleKey: 'broken', component: () => { throw new Error('community view failure'); } });
  } }));
  render(<UiKernelProvider kernel={kernel}>
    <div>host survives</div>
    <Views currentView={'community-broken' as CurrentView} visited={new Set(['community-broken' as CurrentView])} />
  </UiKernelProvider>);
  expect(screen.getByText('host survives')).toBeTruthy();
  expect(document.querySelector('[data-view-layer-shell="community-broken"]')).toBeTruthy();
  expect(screen.getByText('[community-broken] community view failure')).toBeTruthy();
});
