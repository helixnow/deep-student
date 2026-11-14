import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { UiKernel, defineUiPlugin } from '@/ui-kernel/kernel';
import { createOfficialUiTestKernel } from '@/ui-plugins/testing/render';
import { UiKernelProvider } from '@/ui-kernel/react';
import { ModernSidebar } from '@/components/ModernSidebar';
import { MobileSidebarNavigation } from '@/components/layout/MobileSidebarNavigation';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import type { ShellNavItem } from '@/ui-kernel/contracts/shell';
import { useViewStore } from '@/stores/viewStore';
import shellPlugin, { officialShellViewIds } from '../index';
import { consumerEvidence } from './consumerEvidence';
import type { CurrentView } from '@/types/navigation';

const officialIconFailure = vi.hoisted(() => ({ enabled: false }));
vi.mock('@/components/icons/StudySidebarIcons', async importOriginal => {
  const actual = await importOriginal<typeof import('@/components/icons/StudySidebarIcons')>();
  return { ...actual, StudyChatIcon: (props: React.ComponentProps<typeof actual.StudyChatIcon>) => {
    if (officialIconFailure.enabled) throw new Error('original builtin icon dependency failure');
    return <actual.StudyChatIcon {...props} />;
  } };
});

vi.mock('@/features/chat/hooks/useSessionManagement', () => ({
  useSidebarSessionData: () => ({ sessions: [], groups: [], refresh: vi.fn(), setSessions: vi.fn(), setGroups: vi.fn() }),
}));
vi.mock('@/features/chat/superSession/useSuperSessionEntry', () => ({
  useSuperSessionEntry: () => ({ enabled: false, sessionId: null, session: null, refresh: vi.fn() }),
}));
vi.mock('@/command-palette/CommandPaletteProvider', () => ({
  useCommandPalette: () => ({ openSessionSearch: vi.fn() }),
}));

let kernel: UiKernel;
beforeEach(async () => {
  officialIconFailure.enabled = false;
  kernel = await createOfficialUiTestKernel();
  useViewStore.setState({ currentView: 'chat-v2', previousView: null });
});
afterEach(async () => {
  officialIconFailure.enabled = false;
  cleanup();
  await kernel.dispose();
});

function BrokenIcon(): never { throw new Error('broken community navigation icon'); }

async function contribute(placement: 'primary' | 'settings', owner = 'community.bad-icon') {
  const item: ShellNavItem = {
    id: 'bad-icon', viewId: 'todo', labelKey: 'community:bad-icon', fallback: 'community:bad-icon', icon: BrokenIcon, order: 5,
    desktop: { placement },
    mobile: { placement: placement === 'primary' ? 'launcher' : 'settings',
      label: { key: 'community:bad-icon', fallback: 'community:bad-icon' },
      ariaLabel: { key: 'community:bad-icon', fallback: 'community:bad-icon' } },
  };
  await kernel.install(defineUiPlugin({ meta: { id: owner }, apply(ctx) { ctx.ui.nav.register(item); } }));
}

it('keeps the real desktop sidebar, labels and other entries alive when a community primary icon throws', async () => {
  await contribute('primary');
  const navigate = vi.fn();
  render(<UiKernelProvider kernel={kernel}><ModernSidebar currentView="chat-v2" onViewChange={navigate} /></UiKernelProvider>);
  expect(screen.getByText('DeepStudent')).toBeTruthy();
  expect(screen.getByRole('button', { name: '资源库' })).toBeTruthy();
  const item = screen.getByRole('button', { name: 'community:bad-icon' });
  expect(item.querySelector('svg')).toBeNull();
  fireEvent.click(item);
  expect(navigate).toHaveBeenCalledWith('todo');
  await act(() => kernel.unload('community.bad-icon'));
  expect(screen.queryByRole('button', { name: 'community:bad-icon' })).toBeNull();
  expect(screen.getByRole('button', { name: '资源库' })).toBeTruthy();
});

it('isolates both desktop settings trigger and menu icons without swallowing the settings action', async () => {
  await contribute('settings');
  const navigate = vi.fn();
  render(<UiKernelProvider kernel={kernel}><ModernSidebar currentView="chat-v2" onViewChange={navigate} /></UiKernelProvider>);
  const trigger = screen.getByRole('button', { name: 'community:bad-icon' });
  fireEvent.click(trigger);
  const action = await screen.findByRole('menuitem', { name: 'community:bad-icon' });
  expect(action.querySelector('svg')).toBeNull();
  fireEvent.click(action);
  expect(navigate).toHaveBeenCalledWith('todo');
  expect(screen.getByText('DeepStudent')).toBeTruthy();
});

it.each([false, true])('keeps the real mobile navigation mounted when settingsOnly=%s has a bad community icon', async settingsOnly => {
  await contribute(settingsOnly ? 'settings' : 'primary');
  const navigate = vi.fn();
  render(<UiKernelProvider kernel={kernel}><MobileSidebarNavigation settingsOnly={settingsOnly} onNavigate={navigate} /></UiKernelProvider>);
  const item = screen.getByRole('button', { name: 'community:bad-icon' });
  expect(item.querySelector('svg')).toBeNull();
  fireEvent.click(item);
  expect(navigate).toHaveBeenCalledWith('todo');
  if (!settingsOnly) expect(screen.getAllByRole('button')).toHaveLength(8);
  await act(() => kernel.unload('community.bad-icon'));
  expect(screen.queryByRole('button', { name: 'community:bad-icon' })).toBeNull();
  expect(screen.getAllByRole('button')).toHaveLength(settingsOnly ? 1 : 7);
});

it('retains error propagation for the real builtin plugin installed by the official installer', () => {
  expect(kernel.slots.list('nav').filter(entry => entry.owner === 'dstu.ui.shell').every(entry => entry.origin === 'builtin')).toBe(true);
  officialIconFailure.enabled = true;
  render(<UiKernelProvider kernel={kernel}><ErrorBoundary fallback={<div>outer boundary</div>}>
    <MobileSidebarNavigation />
  </ErrorBoundary></UiKernelProvider>);
  expect(screen.getByText('outer boundary')).toBeTruthy();
  expect(screen.queryByRole('navigation')).toBeNull();
});

it.each(['desktop', 'mobile'] as const)('isolates a community replacement under the official plugin id on %s', async surface => {
  await kernel.install(defineUiPlugin({ meta: { id: 'dstu.ui.shell' }, async apply(ctx) {
    await shellPlugin.apply(ctx, undefined);
    const item: ShellNavItem = { id: 'replacement-bad-icon', viewId: 'todo', labelKey: 'replacement:bad-icon', icon: BrokenIcon,
      desktop: { placement: 'primary' }, mobile: { placement: 'launcher' } };
    ctx.ui.nav.register(item);
  } })); // origin omitted deliberately: the kernel must default to community.
  expect(kernel.slots.list('nav').every(entry => entry.origin === 'community')).toBe(true);
  render(<UiKernelProvider kernel={kernel}><ErrorBoundary fallback={<div>outer boundary</div>}>
    {surface === 'desktop' ? <ModernSidebar currentView="chat-v2" onViewChange={() => undefined} /> : <MobileSidebarNavigation />}
  </ErrorBoundary></UiKernelProvider>);
  expect(screen.queryByText('outer boundary')).toBeNull();
  expect(screen.getByRole('button', { name: 'replacement:bad-icon' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '资源库' })).toBeTruthy();
  await act(() => kernel.unload('dstu.ui.shell'));
  expect(screen.queryByRole('button', { name: 'replacement:bad-icon' })).toBeNull();
  await act(() => kernel.install(shellPlugin, { origin: 'builtin' }));
  expect(kernel.slots.list('nav').every(entry => entry.origin === 'builtin')).toBe(true);
  expect(screen.getByRole('button', { name: '资源库' })).toBeTruthy();
});

it.each(['desktop', 'mobile'] as const)('appends unplaced iconless F0 contributions by order on %s and routes registered keys', async surface => {
  await kernel.install(defineUiPlugin({ meta: { id: 'community.default-nav' }, apply(ctx) {
    ctx.ui.views.register({ id: 'community-new-view', titleKey: 'community:new', component: () => <div>community view</div> });
    ctx.ui.nav.register({ id: 'later', viewId: 'community-new-view', labelKey: 'community:later', order: -100 });
    ctx.ui.nav.register({ id: 'earlier', viewId: 'community-new-view', labelKey: 'community:earlier', order: -200 });
  } }));
  const navigate = vi.fn();
  const { container } = render(<UiKernelProvider kernel={kernel}>
    {surface === 'desktop' ? <ModernSidebar currentView="chat-v2" onViewChange={navigate} /> : <MobileSidebarNavigation onNavigate={navigate} />}
  </UiKernelProvider>);
  const region = surface === 'desktop' ? container.querySelector('[data-sidebar-fixed-region="primary-navigation"]')! : screen.getByRole('navigation');
  const labels = [...region.querySelectorAll('button')].map(button => button.getAttribute('aria-label'));
  expect(labels.slice(-2)).toEqual(['community:earlier', 'community:later']);
  expect(labels.indexOf('资源库')).toBeLessThan(labels.indexOf('community:earlier'));
  const earlier = screen.getByRole('button', { name: 'community:earlier' });
  expect(earlier.querySelector('svg')).toBeNull();
  fireEvent.click(earlier);
  expect(navigate).toHaveBeenCalledWith('community-new-view');
  const consumer = consumerEvidence(undefined, officialShellViewIds);
  expect(consumer.navigation(true, false, kernel.slots.list('views'), ['community-new-view']).transitions[0]).toMatchObject({
    target: 'community-new-view', committed: 'community-new-view',
  });
  expect(consumer.navigation(true, true, kernel.slots.list('views'), ['community-new-view']).transitions[0].committed).toBeNull();
  if (surface === 'mobile') {
    act(() => useViewStore.setState({ currentView: 'community-new-view' as CurrentView }));
    expect(screen.getByRole('button', { name: 'community:earlier' })).toHaveAttribute('aria-current', 'page');
  }
  await act(() => kernel.unload('community.default-nav'));
  expect(screen.queryByRole('button', { name: 'community:earlier' })).toBeNull();
  expect(consumer.navigation(true, false, kernel.slots.list('views'), ['community-new-view']).transitions[0].committed).toBe('chat-v2');
});

it('rejects a different plugin claiming an official view key', async () => {
  await expect(kernel.install(defineUiPlugin({ meta: { id: 'community.colliding-view' }, apply(ctx) {
    ctx.ui.views.register({ id: 'chat-v2', titleKey: 'collision', component: () => null });
  } }))).rejects.toThrow('already provided');
  expect(kernel.slots.get('views', 'chat-v2')?.origin).toBe('builtin');
});
