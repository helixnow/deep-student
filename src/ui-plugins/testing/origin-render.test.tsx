import React, { type ComponentType } from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { defineUiPlugin, UiKernel } from '../../ui-kernel/kernel';
import { UiPluginLoader } from '../../ui-kernel/loader';
import { UiKernelProvider, useOptionalSlot, useSlot } from '../../ui-kernel/react';
import { installOfficialUiPlugins } from '../official/install';

it('isolates a throwing same-id community replacement using the real loader, origin subscription and ErrorBoundary', async () => {
  const kernel = new UiKernel();
  const clicked = vi.fn();
  const builtins = [defineUiPlugin({
    meta: { id: 'dstu.ui.shell' },
    apply(ctx) { ctx.ui.nav.register({ id: 'same', viewId: 'same', labelKey: 'replacement label', icon: () => <span>builtin icon</span> }); },
  }), defineUiPlugin({
    meta: { id: 'dstu.ui.neighbor' },
    apply(ctx) { ctx.ui.nav.register({ id: 'neighbor', viewId: 'neighbor', labelKey: 'neighbor label' }); },
  })];
  await installOfficialUiPlugins(kernel, builtins);
  function Navigation() {
    const entries = useSlot<{ labelKey: string; icon?: ComponentType }>('nav');
    return <nav>{entries.map((entry) => {
      const Icon = entry.value.icon;
      const icon = Icon ? <Icon /> : null;
      return <button key={`${entry.owner}/${entry.id}`} onClick={clicked}>
        {entry.origin === 'builtin' ? icon : <ErrorBoundary name="community-icon" fallback={() => null}>{icon}</ErrorBoundary>}
        {entry.value.labelKey}
      </button>;
    })}</nav>;
  }
  const screen = render(<UiKernelProvider kernel={kernel}><Navigation /></UiKernelProvider>);
  expect(screen.getByText('builtin icon')).toBeTruthy();
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  const loader = new UiPluginLoader(kernel, {
    importModule: async () => ({ default: defineUiPlugin({
      meta: { id: 'dstu.ui.shell' },
      apply(ctx) {
        ctx.ui.nav.register({ id: 'same', viewId: 'same', labelKey: 'replacement label', icon: () => { throw new Error('community icon failed'); } });
      },
    }) }),
  });
  try {
    await act(async () => { await loader.sync([{ id: 'dstu.ui.shell', file: '/replacement/ui.js' }]); });
    expect(kernel.slots.list('nav').find((entry) => entry.owner === 'dstu.ui.shell')?.origin).toBe('community');
    expect(screen.queryByText('builtin icon')).toBeNull();
    expect(screen.getByRole('navigation')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'replacement label' }));
    expect(clicked).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'neighbor label' })).toBeTruthy();
    await act(async () => { await loader.sync([]); });
    expect(screen.queryByRole('button', { name: 'replacement label' })).toBeNull();
    expect(screen.getByRole('button', { name: 'neighbor label' })).toBeTruthy();
  } finally {
    screen.unmount();
    await loader.dispose();
    await kernel.dispose();
    errorLog.mockRestore();
  }
});

it('supports a synchronous official table only without Provider, not when a live slot becomes empty', async () => {
  const kernel = new UiKernel();
  const officialTable = [{ id: 'math', title: 'official math' }];
  function Content() {
    const entries = useOptionalSlot<{ title: string }>('markdown.codeBlocks');
    const rows = entries === undefined ? officialTable : entries.map((entry) => ({ id: entry.id, title: entry.value.title }));
    return <div>{rows.map((entry) => <span key={entry.id}>{entry.title}</span>)}</div>;
  }
  const screen = render(<Content />);
  expect(screen.getByText('official math')).toBeTruthy();
  screen.rerender(<UiKernelProvider kernel={kernel}><Content /></UiKernelProvider>);
  expect(screen.queryByText('official math')).toBeNull();
  const plugin = defineUiPlugin({ meta: { id: 'content' }, apply(ctx) {
    ctx.ui.contribute('markdown.codeBlocks', { id: 'math', key: 'math', value: { title: 'slot math' } });
  } });
  await act(async () => { await kernel.install(plugin); });
  expect(screen.getByText('slot math')).toBeTruthy();
  await act(async () => { await kernel.unload('content'); });
  expect(screen.queryByText('official math')).toBeNull();
  expect(screen.queryByText('slot math')).toBeNull();
  screen.rerender(<Content />);
  expect(screen.getByText('official math')).toBeTruthy();
  screen.unmount();
  await kernel.dispose();
});
