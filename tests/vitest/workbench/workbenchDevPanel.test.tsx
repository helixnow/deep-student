import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const diagnosticsMock = vi.hoisted(() => vi.fn());

vi.mock('@/features/workbench/agent/stageManager', () => ({
  stageManager: {
    getDiagnostics: diagnosticsMock,
  },
}));

import { WorkbenchDevPanel } from '@/features/workbench/components/WorkbenchDevPanel';
import { useWindowStore } from '@/features/workbench/core/windowStore';
import type { WorkbenchWindow } from '@/features/workbench/core/types';

function makeWindow(overrides: Partial<WorkbenchWindow> & { id: string }): WorkbenchWindow {
  return {
    typeId: 'note',
    instanceKey: null,
    title: overrides.id,
    frame: { x: 0, y: 0, w: 600, h: 400 },
    restoreFrame: null,
    displayMode: 'floating',
    minimized: false,
    zIndex: 10,
    createdAt: 1,
    lastFocusedAt: 1,
    ...overrides,
  };
}

const EMPTY_STORE = {
  windows: {},
  focusStack: [] as string[],
  lifecycles: {},
  launchPayloads: {},
  tilingRatios: {},
};

describe('WorkbenchDevPanel (mock store data)', () => {
  beforeEach(() => {
    useWindowStore.setState({ ...EMPTY_STORE });
    diagnosticsMock.mockReturnValue({
      transactions: [],
      leases: [],
      cancelling: 0,
      orphanDraining: 0,
      undoInFlight: 0,
    });
  });

  afterEach(() => {
    cleanup();
    useWindowStore.setState({ ...EMPTY_STORE });
  });

  it('renders standalone with an empty store', () => {
    render(<WorkbenchDevPanel />);
    expect(screen.getByTestId('workbench-dev-panel')).toBeInTheDocument();
    expect(screen.getByText('暂无窗口')).toBeInTheDocument();
    expect(screen.getByText('（空）')).toBeInTheDocument();
    expect(screen.getByText('尚未保存', { exact: false })).toBeInTheDocument();
  });

  it('lists windows with derived lifecycles, weight budget and focus stack', () => {
    useWindowStore.setState({
      ...EMPTY_STORE,
      windows: {
        a: makeWindow({ id: 'a', title: '笔记 A', zIndex: 11 }),
        b: makeWindow({ id: 'b', title: '教材 B', zIndex: 12 }),
        c: makeWindow({ id: 'c', title: '冻结 C', zIndex: 10 }),
        d: makeWindow({ id: 'd', title: '最小化 D', zIndex: 9, minimized: true }),
      },
      focusStack: ['a', 'b'],
      lifecycles: { c: 'frozen' },
    });

    render(<WorkbenchDevPanel />);

    const panel = screen.getByTestId('workbench-dev-panel');
    expect(panel).toBeInTheDocument();

    // 窗口列表按 zIndex 降序，lifecycle 派生：b=focused（栈顶）、a=visible、c=frozen（显式）、d=background（最小化）
    expect(screen.getByText('笔记 A').closest('li')).toHaveAttribute('data-lifecycle', 'visible');
    expect(screen.getByText('教材 B').closest('li')).toHaveAttribute('data-lifecycle', 'focused');
    expect(screen.getByText('冻结 C').closest('li')).toHaveAttribute('data-lifecycle', 'frozen');
    expect(screen.getByText('最小化 D').closest('li')).toHaveAttribute('data-lifecycle', 'background');

    // 预算：4 窗中 frozen 不计，未注册应用 weight 兜底 1 → 3 / 12
    expect(screen.getByText('3 / 12')).toBeInTheDocument();

    // 焦点栈：最近聚焦在前
    expect(screen.getByText('教材 B › 笔记 A')).toBeInTheDocument();
  });

  it('shows snapshot save time when workbench:snapshot-saved is dispatched', () => {
    render(<WorkbenchDevPanel />);
    expect(screen.getByText('尚未保存', { exact: false })).toBeInTheDocument();

    fireEvent(
      window,
      new CustomEvent('workbench:snapshot-saved', { detail: { at: Date.now() } }),
    );

    expect(screen.queryByText('尚未保存', { exact: false })).not.toBeInTheDocument();
  });

  it('invokes onClose from the close button', () => {
    const onClose = vi.fn();
    render(<WorkbenchDevPanel onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: '关闭面板' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows ACR 3.0 transactions, leases and bounded-drain diagnostics', () => {
    diagnosticsMock.mockReturnValue({
      transactions: [
        {
          runId: 'acr3:9:session-a:call-1',
          sessionId: 'session-a',
          correlationId: 'corr-1',
          kind: 'apply_ops',
          windowId: 'win-note',
          state: 'orphan-draining',
          ownsLease: true,
        },
      ],
      leases: [
        {
          windowId: 'win-note',
          runId: 'acr3:9:session-a:call-1',
          sessionId: 'session-a',
        },
      ],
      cancelling: 0,
      orphanDraining: 1,
      undoInFlight: 1,
    });

    render(<WorkbenchDevPanel />);

    expect(screen.getByTestId('wb-hud-acr-transactions')).toHaveTextContent('transactions 1');
    expect(screen.getByTestId('wb-hud-acr-leases')).toHaveTextContent('leases 1');
    expect(screen.getByTestId('wb-hud-acr-cancelling')).toHaveTextContent('cancelling 0');
    expect(screen.getByTestId('wb-hud-acr-orphans')).toHaveTextContent('orphan-draining 1');
    expect(screen.getByTestId('wb-hud-acr-undo-in-flight')).toHaveTextContent('undo-in-flight 1');
    expect(screen.getByTestId('wb-hud-acr-transaction-list')).toHaveTextContent(
      'apply_ops/orphan-draining',
    );
  });
});
