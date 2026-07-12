import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Block } from '@/features/chat/core/types';
import { markWorkbenchBlockRestored } from '@/features/chat/utils/workbenchBlockRemap';

const mocks = vi.hoisted(() => ({
  activate: vi.fn(),
  hasRun: vi.fn<(runId: string) => boolean>(),
  revertRun: vi.fn<(runId: string) => Promise<boolean>>(),
  handleBridgeRequest: vi.fn(),
}));

vi.mock('@/features/workbench', () => ({
  workbenchBus: { activate: mocks.activate },
  stageManager: {
    revertRun: mocks.revertRun,
    handleBridgeRequest: mocks.handleBridgeRequest,
  },
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

function createAgentActBlock(
  undoToken: string,
  undoDurability: 'persistent' | 'session',
  overrides: Partial<Block> = {},
): Block {
  return createBlock({
    toolName: 'workbench_act',
    toolInput: { typeId: 'todo', windowId: 'win-todo' },
    toolOutput: {
      result: {
        status: 'completed',
        windowId: 'win-todo',
        typeId: 'todo',
        beforeRevision: 'rev-1',
        afterRevision: 'rev-2',
        results: [{ index: 0, name: 'focusItem', handled: true, verified: true }],
        verified: true,
        failedConditions: [],
        undoToken,
        undoDurability,
        observation: { revision: 'rev-2' },
      },
    },
    ...overrides,
  });
}

describe('WorkbenchOpsBlock undo semantics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasRun.mockReturnValue(false);
    mocks.revertRun.mockResolvedValue(true);
    mocks.handleBridgeRequest.mockResolvedValue({
      correlationId: 'undo-response',
      ok: true,
      data: { reverted: true },
    });
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

  it('shows persistent undo durability and consumes its token even after restore', async () => {
    const block = createAgentActBlock('acr-undo:persisted-1', 'persistent', {
      id: 'persistent-act-block',
      toolCallId: 'persistent-act-call',
    });
    markWorkbenchBlockRestored(block.id);

    render(<WorkbenchOpsBlock block={block} />);

    expect(screen.getByTestId('workbench-agent-act-receipt')).toHaveTextContent(
      '操作后状态已验证',
    );
    expect(screen.getByTestId('workbench-undo-durability')).toHaveTextContent(
      '应用重启后仍可恢复',
    );
    const button = screen.getByTestId('workbench-ops-undo');
    expect(button).toBeEnabled();
    fireEvent.click(button);

    await waitFor(() => {
      expect(mocks.handleBridgeRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'revert_run',
          args: { undoToken: 'acr-undo:persisted-1' },
        }),
      );
      expect(button).toHaveTextContent('已撤销可恢复更改');
    });
    expect(mocks.revertRun).not.toHaveBeenCalled();
  });

  it('marks a restored session-only undo token as expired', () => {
    const block = createAgentActBlock('acr-run:session-1', 'session', {
      id: 'session-act-block',
      toolCallId: 'session-act-call',
    });
    markWorkbenchBlockRestored(block.id);

    render(<WorkbenchOpsBlock block={block} />);

    const button = screen.getByTestId('workbench-ops-undo');
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('blocks.workbenchOps.undoExpired');
    expect(mocks.handleBridgeRequest).not.toHaveBeenCalled();
  });
});
