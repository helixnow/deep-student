import React, { Suspense } from 'react';
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appRegistry } from '../../../core/appRegistry';
import type { AppWindowProps } from '../../../core/types';
import { hasIllustratedAppIcon } from '../../../icons/appIcons';
import { hasWorkbenchAppIcon } from '../../../components/WorkbenchAppIcon';
import { NOTEBOOK_APP_TYPE_ID, notebookAppDefinition, registerNotebookApp } from '../register';
import zhWorkbench from '@/locales/zh-CN/workbench.json';
import enWorkbench from '@/locales/en-US/workbench.json';
import { resetWindowStoreForTests, useWindowStore } from '../../../core/windowStore';
import { isWindowDirty } from '../../../core/windowCloseGuard';
import type { NotebookHostStateChange } from '../hostLifecycle';

const consumer = vi.hoisted(() => ({ onHostStateChange: undefined as NotebookHostStateChange | undefined }));
vi.mock('@/features/ink', () => ({
  LazyNotebookPage: ({ isActive, onHostStateChange }: { isActive?: boolean; onHostStateChange?: NotebookHostStateChange }) => {
    consumer.onHostStateChange = onHostStateChange;
    return <div data-testid="notebook-page" data-active={String(isActive)} />;
  },
}));

beforeEach(() => { resetWindowStoreForTests(); consumer.onHostStateChange = undefined; });

function windowProps(overrides: Partial<AppWindowProps> = {}): AppWindowProps {
  return {
    windowId: 'notebook-window',
    instanceKey: null,
    launchPayload: undefined,
    isActive: true,
    isVisible: true,
    onTitleChange: vi.fn(),
    requestClose: vi.fn(),
    ...overrides,
  };
}

describe('notebook workbench application', () => {
  it('registers an independently launchable single-instance application with its own icon', () => {
    expect(NOTEBOOK_APP_TYPE_ID).toBe('notebook');
    expect(appRegistry.get('notebook')).toBe(notebookAppDefinition);
    expect(notebookAppDefinition).toMatchObject({
      nameKey: 'workbench:apps.notebook', showInLauncher: true, instanceMode: 'single', memoryWeight: 2,
    });
    expect(notebookAppDefinition.defaultFrame).toEqual({ w: 1100, h: 760 });
    expect(notebookAppDefinition.minSize).toEqual({ w: 480, h: 420 });
    expect(hasIllustratedAppIcon('notebook')).toBe(true);
    expect(hasWorkbenchAppIcon('notebook')).toBe(true);
    expect(zhWorkbench.apps.notebook).toBe('手写笔记');
    expect(enWorkbench.apps.notebook).toBe('Handwritten Notes');
  });

  it('registers idempotently without creating another application', () => {
    const register = vi.spyOn(appRegistry, 'register');
    registerNotebookApp();
    registerNotebookApp();
    expect(register).not.toHaveBeenCalled();
    expect(appRegistry.list().filter((app) => app.typeId === 'notebook')).toHaveLength(1);
    register.mockRestore();
  });

  it('lazy-loads the shared notebook page and propagates window focus rather than visibility', async () => {
    const App = notebookAppDefinition.render;
    const props = windowProps();
    const { rerender } = render(<Suspense fallback={null}><App {...props} /></Suspense>);
    expect(await screen.findByTestId('notebook-page')).toHaveAttribute('data-active', 'true');
    expect(props.onTitleChange).toHaveBeenLastCalledWith('手写笔记');

    rerender(<Suspense fallback={null}><App {...props} isActive={false} isVisible /></Suspense>);
    expect(screen.getByTestId('notebook-page')).toHaveAttribute('data-active', 'false');
    rerender(<Suspense fallback={null}><App {...props} /></Suspense>);
    expect(screen.getByTestId('notebook-page')).toHaveAttribute('data-active', 'true');
  });

  it('forwards the optional host lifecycle callback and blocks close until a reported writing session saves', async () => {
    const App = notebookAppDefinition.render;
    const windowId = useWindowStore.getState().openWindow({ typeId: 'notebook' });
    render(<Suspense fallback={null}><App {...windowProps({ windowId })} /></Suspense>);
    await screen.findByTestId('notebook-page');
    expect(consumer.onHostStateChange).toBeTypeOf('function');
    await expect(notebookAppDefinition.canClose!(null)).resolves.toBe(false);

    let dirty = true;
    const flush = vi.fn(async () => { dirty = false; return true; });
    act(() => consumer.onHostStateChange!({ writing: true, busy: false, isDirty: () => dirty, flush }));
    expect(isWindowDirty(windowId)).toBe(true);
    expect(notebookAppDefinition.canSuspend!(null)).toBe(false);
    await expect(notebookAppDefinition.canClose!(null)).resolves.toBe(true);
    expect(flush).toHaveBeenCalledTimes(1);

    act(() => consumer.onHostStateChange!({ writing: false, busy: false, isDirty: () => false, flush }));
    expect(isWindowDirty(windowId)).toBe(false);
    expect(notebookAppDefinition.canSuspend!(null)).toBe(true);
  });
});
