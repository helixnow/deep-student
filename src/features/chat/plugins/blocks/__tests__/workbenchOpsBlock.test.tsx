import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Block } from '@/features/chat/core/types';
import { markWorkbenchBlockRestored } from '@/features/chat/utils/workbenchBlockRemap';

const mocks = vi.hoisted(() => ({
  activate: vi.fn(),
  hasRun: vi.fn<(runId: string) => boolean>(),
  revertRun: vi.fn<(runId: string) => Promise<boolean>>(),
}));

vi.mock('@/features/workbench', () => ({
  workbenchBus: { activate: mocks.activate },
  stageManager: { revertRun: mocks.revertRun },
  usePresenceStore: (selector: (state: { byWindow: Record<string, never> }) => unknown) =>
    selector({ byWindow: {} }),
}));

vi.mock('@/features/workbench/agent/ledger', () => ({
  runLedger: { hasRun: mocks.hasRun },
}));

import { WorkbenchOpsBlock } from '../workbenchOpsBlock';

function createBlock(overrides: Partial<Block> = {}): Block {
  return {
    id: 'block-id',
    messageId: 'message-id',
    type: 'workbench_ops',
    status: 'success',
    toolCallId: 'tool-call-id',
    toolName: 'workbench_note',
    toolInput: {},
    toolOutput: {
      result: {
        status: 'completed',
        mode: 'frontend',
        applied: 2,
        totalOps: 2,
        entityIds: [],
        done: ['write one', 'write two'],
        undone: [],
      },
    },
    ...overrides,
  };
}

describe('WorkbenchOpsBlock undo semantics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasRun.mockReturnValue(false);
    mocks.revertRun.mockResolvedValue(true);
  });

  it('does not enable undo when the ledger has no reversible entry', () => {
    render(<WorkbenchOpsBlock block={createBlock()} />);

    const button = screen.getByTestId('workbench-ops-undo');
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('不可撤销');
    expect(mocks.revertRun).not.toHaveBeenCalled();
  });

  it('forces restored sessions to expired even when the same runId is live in memory', () => {
    const block = createBlock({
      id: 'restored-block-id',
      toolCallId: 'restored-block-id',
    });
    markWorkbenchBlockRestored(block.id);
    mocks.hasRun.mockImplementation((runId) => runId === 'restored-block-id');

    render(<WorkbenchOpsBlock block={block} />);

    const button = screen.getByTestId('workbench-ops-undo');
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('blocks.workbenchOps.undoExpired');
    expect(mocks.revertRun).not.toHaveBeenCalled();
  });

  it('rechecks both runId candidates and reports LRU expiry before reverting', async () => {
    let ledgerAlive = true;
    mocks.hasRun.mockImplementation((runId) => ledgerAlive && runId === 'block-id');

    render(<WorkbenchOpsBlock block={createBlock()} />);
    const button = screen.getByTestId('workbench-ops-undo');
    expect(button).toBeEnabled();

    ledgerAlive = false;
    fireEvent.click(button);

    await waitFor(() => {
      expect(button).toBeDisabled();
      expect(button).toHaveTextContent('blocks.workbenchOps.undoExpired');
    });
    expect(mocks.revertRun).not.toHaveBeenCalled();
  });

  it('uses the live fallback runId and describes successful undo conservatively', async () => {
    mocks.hasRun.mockImplementation((runId) => runId === 'block-id');

    render(<WorkbenchOpsBlock block={createBlock()} />);
    fireEvent.click(screen.getByTestId('workbench-ops-undo'));

    await waitFor(() => {
      expect(mocks.revertRun).toHaveBeenCalledWith('block-id');
      expect(screen.getByTestId('workbench-ops-undo')).toHaveTextContent(
        '已撤销可恢复更改'
      );
    });
  });

  it('allows retry after a partial rollback while the ledger remains reversible', async () => {
    let fallbackOnly = false;
    mocks.hasRun.mockImplementation((runId) =>
      fallbackOnly ? runId === 'block-id' : runId === 'tool-call-id'
    );
    mocks.revertRun
      .mockImplementationOnce(async () => {
        fallbackOnly = true;
        return false;
      })
      .mockResolvedValueOnce(true);

    render(<WorkbenchOpsBlock block={createBlock()} />);
    const button = screen.getByTestId('workbench-ops-undo');
    fireEvent.click(button);

    await waitFor(() => {
      expect(button).toBeEnabled();
      expect(button).toHaveTextContent('部分撤销，重试');
      expect(button).not.toHaveTextContent('已撤销');
    });

    fireEvent.click(button);

    await waitFor(() => {
      expect(mocks.revertRun).toHaveBeenNthCalledWith(1, 'tool-call-id');
      expect(mocks.revertRun).toHaveBeenNthCalledWith(2, 'block-id');
      expect(button).toBeDisabled();
      expect(button).toHaveTextContent('已撤销可恢复更改');
    });
  });

  it('disables retry when a partial rollback exhausts the ledger', async () => {
    let ledgerAlive = true;
    mocks.hasRun.mockImplementation(
      (runId) => ledgerAlive && runId === 'tool-call-id'
    );
    mocks.revertRun.mockImplementationOnce(async () => {
      ledgerAlive = false;
      return false;
    });

    render(<WorkbenchOpsBlock block={createBlock()} />);
    const button = screen.getByTestId('workbench-ops-undo');
    fireEvent.click(button);

    await waitFor(() => {
      expect(button).toBeDisabled();
      expect(button).toHaveTextContent('撤销未完全完成（无法重试）');
      expect(button).not.toHaveTextContent('已撤销');
    });
  });
});
