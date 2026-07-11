/**
 * Chat V2 - WorkbenchOpsBlock 单元测试（ACR R1-09 / R2-05）
 *
 * 覆盖：
 * - blockRegistry 注册 + onAbort
 * - running / success / partial 三态渲染
 * - 撤销按钮条件（仅 frontend + completed/partial + 账本存活）
 * - 账本过期失效态
 * - data-run-id 与 resolveWorkbenchRunId
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import type { Block } from '@/features/chat/core/types';
import type { AcrReceipt } from '@/features/workbench';
import { blockRegistry } from '@/features/chat/registry';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; applied?: number; total?: number }) => {
      const dict: Record<string, string> = {
        'blocks.workbenchOps.title': 'Desktop Ops',
        'blocks.workbenchOps.openTarget': 'Open target window',
        'blocks.workbenchOps.undo': 'Undo',
        'blocks.workbenchOps.undoApplied': 'Reversible changes undone',
        'blocks.workbenchOps.undoUnavailable': 'Not undoable',
        'blocks.workbenchOps.undone': 'Undone',
        'blocks.workbenchOps.undoFailed': 'Undo failed',
        'blocks.workbenchOps.undoExpired': 'Undo expired',
        'blocks.workbenchOps.steps': 'Steps',
        'blocks.workbenchOps.done': 'Done',
        'blocks.workbenchOps.pending': 'Not done',
        'blocks.workbenchOps.target': 'Target',
        'blocks.workbenchOps.noTarget': 'No target window',
        'blocks.workbenchOps.message': 'Note',
        'blocks.workbenchOps.applied': `Applied ${options?.applied ?? 0}/${options?.total ?? 0}`,
        'blocks.workbenchOps.status.running': 'Running',
        'blocks.workbenchOps.status.success': 'Completed',
        'blocks.workbenchOps.status.partial': 'Partial',
        'blocks.workbenchOps.status.cancelled': 'Cancelled',
        'blocks.workbenchOps.status.error': 'Failed',
        'blocks.mcpTool.unknownTool': 'Unknown Tool',
      };
      if (dict[key]) return dict[key];
      if (options?.defaultValue) return options.defaultValue;
      return key;
    },
  }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

const mockActivate = vi.fn(() => true);
const mockRevertRun = vi.fn(async () => true);
const mockHasRun = vi.fn((_id: string) => true);
const mockPresenceSubscribe = vi.fn((selector: (s: { byWindow: Record<string, never> }) => unknown) =>
  selector({ byWindow: {} })
);

vi.mock('@/features/workbench', () => ({
  workbenchBus: {
    activate: (...args: unknown[]) => mockActivate(...args),
  },
  stageManager: {
    revertRun: (...args: unknown[]) => mockRevertRun(...args),
  },
  usePresenceStore: (selector: (s: { byWindow: Record<string, never> }) => unknown) =>
    mockPresenceSubscribe(selector),
}));

vi.mock('@/features/workbench/agent/ledger', () => ({
  runLedger: {
    hasRun: (id: string) => mockHasRun(id),
    record: vi.fn(),
    revertRun: vi.fn(async () => true),
    sealRun: vi.fn(),
  },
}));

vi.mock('@/features/chat/utils/toolDisplayName', () => ({
  getReadableToolName: (name: string) => name.replace(/^builtin-/, ''),
}));

vi.mock('@/features/chat/components/ui/TextShimmer', () => ({
  TextShimmer: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="text-shimmer">{children}</span>
  ),
}));

vi.mock('@/components/ui/PulseDot', () => ({
  PulseDot: () => <span data-testid="pulse-dot" />,
}));

// mocks 之后导入（触发注册）
import { WorkbenchOpsBlock } from '@/features/chat/plugins/blocks/workbenchOpsBlock';

function createReceipt(overrides?: Partial<AcrReceipt>): AcrReceipt {
  return {
    status: 'completed',
    mode: 'frontend',
    applied: 1,
    totalOps: 1,
    entityIds: [],
    done: ['Opened note'],
    undone: [],
    ...overrides,
  };
}

function createBlock(overrides?: Partial<Block>): Block {
  return {
    id: 'wb-ops-1',
    type: 'workbench_ops',
    status: 'success',
    messageId: 'msg-1',
    toolName: 'builtin-workbench_open_app',
    toolCallId: 'call-1',
    toolInput: { typeId: 'note', instanceKey: 'note-42' },
    ...overrides,
  };
}

describe('WorkbenchOpsBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasRun.mockReturnValue(true);
  });

  it('should be registered in blockRegistry with keep-content onAbort', async () => {
    await import('@/features/chat/plugins/blocks/workbenchOpsBlock');
    expect(blockRegistry.has('workbench_ops')).toBe(true);
    expect(blockRegistry.get('workbench_ops')?.onAbort).toBe('keep-content');
  });

  it('renders running state with progress steps', () => {
    const block = createBlock({
      status: 'running',
      content: 'Focusing window\nApplying op 1',
      toolOutput: undefined,
    });

    render(<WorkbenchOpsBlock block={block} />);

    expect(screen.getByTestId('workbench-ops-block')).toHaveAttribute('data-status', 'running');
    expect(screen.getByTestId('workbench-ops-steps')).toBeInTheDocument();
    expect(screen.getByText('Focusing window')).toBeInTheDocument();
    expect(screen.getByText('Applying op 1')).toBeInTheDocument();
    expect(screen.queryByTestId('workbench-ops-undo')).not.toBeInTheDocument();
  });

  it('renders success receipt and shows undo for frontend completed when ledger alive', () => {
    const receipt = createReceipt({ status: 'completed', mode: 'frontend' });
    const block = createBlock({
      status: 'success',
      toolOutput: { result: receipt },
    });

    render(<WorkbenchOpsBlock block={block} />);

    expect(screen.getByTestId('workbench-ops-block')).toHaveAttribute('data-status', 'success');
    expect(screen.getByTestId('workbench-ops-block')).toHaveAttribute('data-run-id', 'call-1');
    expect(screen.getByTestId('workbench-ops-receipt')).toBeInTheDocument();
    expect(screen.getByText('Opened note')).toBeInTheDocument();
    expect(screen.getByText('Applied 1/1')).toBeInTheDocument();
    const undo = screen.getByTestId('workbench-ops-undo');
    expect(undo).toBeInTheDocument();
    expect(undo).not.toBeDisabled();
    expect(screen.getByTestId('workbench-ops-open')).toBeInTheDocument();
  });

  it('shows not undoable when no reversible ledger entry exists', () => {
    mockHasRun.mockReturnValue(false);
    const receipt = createReceipt({ status: 'completed', mode: 'frontend' });
    const block = createBlock({
      status: 'success',
      toolOutput: { result: receipt },
    });

    render(<WorkbenchOpsBlock block={block} />);

    const undo = screen.getByTestId('workbench-ops-undo');
    expect(undo).toBeDisabled();
    expect(undo).toHaveTextContent('Not undoable');
  });

  it('prefers block.id as runId when only block.id is in the ledger', () => {
    mockHasRun.mockImplementation((id: string) => id === 'wb-ops-1');
    const receipt = createReceipt({ status: 'completed', mode: 'frontend' });
    const block = createBlock({
      id: 'wb-ops-1',
      toolCallId: 'call-llm',
      status: 'success',
      toolOutput: { result: receipt },
    });

    render(<WorkbenchOpsBlock block={block} />);

    expect(screen.getByTestId('workbench-ops-block')).toHaveAttribute('data-run-id', 'wb-ops-1');
  });

  it('keeps terminal steps summary when content lines exist', () => {
    const receipt = createReceipt();
    const block = createBlock({
      status: 'success',
      content: 'Opened note window\nApplied insert',
      toolOutput: { result: receipt },
    });

    render(<WorkbenchOpsBlock block={block} />);

    expect(screen.getByTestId('workbench-ops-steps')).toBeInTheDocument();
    expect(screen.getByText('Opened note window')).toBeInTheDocument();
  });

  it('renders partial done/undone columns and keeps undo for frontend', () => {
    const receipt = createReceipt({
      status: 'partial',
      mode: 'frontend',
      done: ['Added node A'],
      undone: ['Delete node B'],
      message: 'User took over',
    });
    const block = createBlock({
      status: 'success',
      toolOutput: { result: receipt },
    });

    render(<WorkbenchOpsBlock block={block} />);

    expect(screen.getByTestId('workbench-ops-block')).toHaveAttribute('data-status', 'partial');
    expect(screen.getByText('Added node A')).toBeInTheDocument();
    expect(screen.getByText('Delete node B')).toBeInTheDocument();
    expect(screen.getByText(/User took over/)).toBeInTheDocument();
    expect(screen.getByTestId('workbench-ops-undo')).toBeInTheDocument();
  });

  it('hides undo button when receipt mode is backend', () => {
    const receipt = createReceipt({ status: 'completed', mode: 'backend' });
    const block = createBlock({
      status: 'success',
      toolOutput: { result: receipt },
    });

    render(<WorkbenchOpsBlock block={block} />);

    expect(screen.queryByTestId('workbench-ops-undo')).not.toBeInTheDocument();
    expect(screen.getByTestId('workbench-ops-header')).toContainElement(
      screen.getByTestId('workbench-ops-open')
    );
    expect(screen.queryByTestId('workbench-ops-footer-actions')).not.toBeInTheDocument();
  });

  it('calls workbenchBus.activate when opening target', () => {
    const receipt = createReceipt();
    const block = createBlock({
      toolOutput: { result: receipt },
    });

    render(<WorkbenchOpsBlock block={block} />);
    fireEvent.click(screen.getByTestId('workbench-ops-open'));

    expect(mockActivate).toHaveBeenCalledWith(
      expect.objectContaining({
        typeId: 'note',
        instanceKey: 'note-42',
        action: 'focus',
        fallbackLaunch: expect.objectContaining({
          typeId: 'note',
          instanceKey: 'note-42',
        }),
      })
    );
  });

  it('calls stageManager.revertRun and disables undo after success', async () => {
    mockHasRun.mockImplementation((id: string) => id === 'run-abc');
    const receipt = createReceipt({ status: 'completed', mode: 'frontend' });
    const block = createBlock({
      toolCallId: 'run-abc',
      toolOutput: { result: receipt },
    });

    render(<WorkbenchOpsBlock block={block} />);
    fireEvent.click(screen.getByTestId('workbench-ops-undo'));

    await waitFor(() => {
      expect(mockRevertRun).toHaveBeenCalledWith('run-abc');
    });

    await waitFor(() => {
      const btn = screen.getByTestId('workbench-ops-undo');
      expect(btn).toBeDisabled();
      expect(btn).toHaveTextContent('Reversible changes undone');
    });
  });
});
