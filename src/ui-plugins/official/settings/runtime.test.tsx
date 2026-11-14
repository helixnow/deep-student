import React, { Suspense, useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';
import { defineUiPlugin, UiKernel } from '@/ui-kernel/kernel';
import { UiKernelProvider, useSlot } from '@/ui-kernel/react';
import type { SettingsSection, SettingsSectionPropsFactories } from '@/ui-kernel/contracts/settings';
import settingsPlugin from './index';
import { settingsNavigation } from './navigation';
import { SectionContent } from './SectionContent';

vi.mock('@/command-palette/components/ShortcutSettings', () => ({
  ShortcutSettings: () => <p>shortcut section body</p>,
}));

const t = ((key: string) => key) as TFunction;
const getProps = new Proxy({}, { get: () => () => ({}) }) as SettingsSectionPropsFactories;

function Harness({ initialTab = 'plugins', isMobile = false }: { initialTab?: string; isMobile?: boolean }) {
  const entries = useSlot<SettingsSection>('settings.sections');
  const [activeTab, setActiveTab] = useState(initialTab);
  const navigation = settingsNavigation(entries, t, { isMobile });
  const entry = entries.find((item) => item.key === activeTab);
  return <>
    <p>settings shell remains mounted</p>
    <nav>{navigation.sidebarNavItems.map((item) =>
      <button key={item.value} onClick={() => setActiveTab(item.value)}>{item.label}</button>)}</nav>
    <Suspense fallback={<p>pending section</p>}>
      {entry && <SectionContent entry={entry} getProps={getProps} isMobile={isMobile} t={t} />}
    </Suspense>
  </>;
}

describe('settings slot consumer lifecycle', () => {
  it('keeps the mobile hidden-plugin deep link message and hidden-but-renderable shortcuts', async () => {
    const kernel = new UiKernel();
    await kernel.install(settingsPlugin, { origin: 'builtin' });
    const first = render(<UiKernelProvider kernel={kernel}><Harness isMobile /></UiKernelProvider>);
    expect(screen.queryByRole('button', { name: 'settings:tabs.plugins' })).toBeNull();
    expect(screen.getByText('settings:plugins.mobile_hidden')).toBeInTheDocument();
    first.unmount();
    const second = render(<UiKernelProvider kernel={kernel}><Harness isMobile initialTab="shortcuts" /></UiKernelProvider>);
    expect(screen.queryByRole('button', { name: 'settings:tabs.shortcuts' })).toBeNull();
    expect(await screen.findByText('shortcut section body')).toBeInTheDocument();
    second.unmount();
    await kernel.dispose();
  });

  it('reacts to community registration/unload and isolates a crashing community section', async () => {
    // Resolve the real shared boundary before exercising rendering, not Vitest's cold transform latency.
    await import('@/components/ErrorBoundary');
    const kernel = new UiKernel();
    await kernel.install(settingsPlugin, { origin: 'builtin' });
    const view = render(<UiKernelProvider kernel={kernel}><Harness initialTab="community-test" /></UiKernelProvider>);
    const section: SettingsSection = {
      id: 'community-test', group: 'community', order: 180, titleKey: 'community:test',
      component: () => { throw new Error('community render failure'); },
      navigation: { order: 190, legacyGroup: 5, icon: () => null,
        mobileDescriptionKey: 'community:description', mobileAccent: 'var(--settings-nav-accent-blue)' },
    };
    await act(async () => kernel.install(defineUiPlugin({ meta: { id: 'community.test' },
      apply: (ctx) => ctx.ui.settings.register(section) }), { origin: 'community' }));
    expect(kernel.slots.get<SettingsSection>('settings.sections', section.id)?.origin).toBe('community');
    fireEvent.click(screen.getByRole('button', { name: 'community:test' }));
    await waitFor(() => expect(screen.queryByText('pending section')).toBeNull());
    expect(screen.getByText('settings shell remains mounted')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'settings:tabs.api_config' })).toBeInTheDocument();
    // The real shared ErrorBoundary renders its existing retry UI rather than losing the shell.
    expect(screen.getAllByRole('button').length).toBeGreaterThan(18);
    await act(async () => { await kernel.unload('community.test'); });
    expect(screen.queryByRole('button', { name: 'community:test' })).toBeNull();
    expect(kernel.slots.list('settings.sections')).toHaveLength(17);
    // Other plugins' navigation must survive a crashing same-id replacement of the official plugin.
    await act(async () => kernel.install(defineUiPlugin({ meta: { id: 'community.sibling' },
      apply: (ctx) => ctx.ui.settings.register({ ...section, id: 'sibling', titleKey: 'community:sibling', component: () => null }) }),
    { origin: 'community' }));
    // Same owner id is not provenance. Omitted origin must default to community.
    await act(async () => kernel.install(defineUiPlugin({ meta: { id: 'dstu.ui.settings' },
      apply: (ctx) => ctx.ui.settings.register(section) })));
    const replacement = kernel.slots.get<SettingsSection>('settings.sections', section.id)!;
    expect(replacement.owner).toBe('dstu.ui.settings');
    expect(replacement.origin).toBe('community');
    await waitFor(() => expect(screen.queryByText('pending section')).toBeNull());
    expect(screen.getByText('settings shell remains mounted')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'community:sibling' })).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(3);
    view.unmount();
    await kernel.dispose();
  });

  it('uses only install provenance: builtin errors propagate and same-component community replacements isolate', async () => {
    await import('@/components/ErrorBoundary');
    const kernel = new UiKernel();
    const CrashingSection = () => { throw new Error('section failure'); };
    const section: SettingsSection = {
      id: 'test', group: 'test', order: 10, titleKey: 'test:section', component: CrashingSection,
    };
    const plugin = defineUiPlugin({ meta: { id: 'dstu.ui.settings' },
      apply: (ctx) => ctx.ui.settings.register(section) });
    await kernel.install(plugin, { origin: 'builtin' });
    const builtin = kernel.slots.get<SettingsSection>('settings.sections', 'test')!;
    const content = SectionContent({ entry: builtin, getProps, isMobile: false, t }) as React.ReactElement;
    // No internal boundary is inserted for builtin contributions, even for a non-table component.
    expect(content.type).toBe(CrashingSection);
    const propagated = vi.fn();
    class HostBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
      state = { failed: false };
      static getDerivedStateFromError() { return { failed: true }; }
      componentDidCatch(error: Error) { propagated(error); }
      render() { return this.state.failed ? <p>outer host failure</p> : this.props.children; }
    }
    const builtinView = render(<HostBoundary><Suspense>{content}</Suspense></HostBoundary>);
    expect(propagated).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'section failure' }));
    expect(screen.getByText('outer host failure')).toBeInTheDocument();
    builtinView.unmount();
    await kernel.install(plugin, { origin: 'community' });
    const community = kernel.slots.get<SettingsSection>('settings.sections', 'test')!;
    expect(community.owner).toBe(builtin.owner);
    expect(community.value.component).toBe(builtin.value.component);
    expect(community.origin).toBe('community');
    const view = render(<UiKernelProvider kernel={kernel}><Harness initialTab="test" /></UiKernelProvider>);
    await waitFor(() => expect(screen.queryByText('pending section')).toBeNull());
    expect(screen.getByText('settings shell remains mounted')).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    view.unmount();
    await kernel.dispose();
  });
});
