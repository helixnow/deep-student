import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreApi } from 'zustand';

import type { Block, ChatStore } from '@/features/chat/core/types';
import { markWorkbenchBlockRestored } from '@/features/chat/utils/workbenchBlockRemap';

const mocks = vi.hoisted(() => ({
  activate: vi.fn(),
  hasRun: vi.fn<(runId: string, sessionId?: string) => boolean>(),
  revertRun: vi.fn<(runId: string, sessionId?: string) => Promise<boolean>>(),
  handleBridgeRequest: vi.fn(),
}));

vi.mock('@/features/workbench', () => ({
  workbenchBus: { activate: mocks.activate },
  stageManager: {
    revertRun: mocks.revertRun,
    hasReversibleRun: mocks.hasRun,
    handleBridgeRequest: mocks.handleBridgeRequest,
  },
  makeAcrSessionRunId: (sessionId: string, toolCallId: string) =>
    `acr3:${new TextEncoder().encode(sessionId).byteLength}:${sessionId}:${toolCallId}`,
  usePresenceStore: (selector: (state: { byWindow: Record<string, never> }) => unknown) =>
    selector({ byWindow: {} }),
}));

import { WorkbenchOpsBlock } from '../workbenchOpsBlock';

function scopedRunId(sessionId: string, toolCallId: string): string {
  return `acr3:${new TextEncoder().encode(sessionId).byteLength}:${sessionId}:${toolCallId}`;
}

function createStore(sessionId = 'session-a'): StoreApi<ChatStore> {
  return {
    getState: () => ({ sessionId }) as ChatStore,
  } as unknown as StoreApi<ChatStore>;
}

function renderBlock(block: Block, sessionId = 'session-a') {
  return render(<WorkbenchOpsBlock block={block} store={createStore(sessionId)} />);
}

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
    renderBlock(createBlock());

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
    mocks.hasRun.mockImplementation(
      (runId, sessionId) =>
        runId === scopedRunId('session-a', 'restored-block-id') && sessionId === 'session-a',
    );

    renderBlock(block);

    const button = screen.getByTestId('workbench-ops-undo');
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('blocks.workbenchOps.undoExpired');
    expect(mocks.revertRun).not.toHaveBeenCalled();
  });

  it('rechecks the session-scoped run and reports LRU expiry before reverting', async () => {
    let ledgerAlive = true;
    const expectedRunId = scopedRunId('session-a', 'tool-call-id');
    mocks.hasRun.mockImplementation(
      (runId, sessionId) => ledgerAlive && runId === expectedRunId && sessionId === 'session-a',
    );

    renderBlock(createBlock());
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

  it('uses the session-scoped runId and describes successful undo conservatively', async () => {
    const expectedRunId = scopedRunId('session-a', 'tool-call-id');
    mocks.hasRun.mockImplementation(
      (runId, sessionId) => runId === expectedRunId && sessionId === 'session-a',
    );

    renderBlock(createBlock());
    fireEvent.click(screen.getByTestId('workbench-ops-undo'));

    await waitFor(() => {
      expect(mocks.revertRun).toHaveBeenCalledWith(expectedRunId, 'session-a');
      expect(screen.getByTestId('workbench-ops-undo')).toHaveTextContent(
        '已撤销可恢复更改'
      );
    });
  });

  it('allows retry after a partial rollback while the ledger remains reversible', async () => {
    const expectedRunId = scopedRunId('session-a', 'tool-call-id');
    mocks.hasRun.mockImplementation(
      (runId, sessionId) => runId === expectedRunId && sessionId === 'session-a',
    );
    mocks.revertRun
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    renderBlock(createBlock());
    const button = screen.getByTestId('workbench-ops-undo');
    fireEvent.click(button);

    await waitFor(() => {
      expect(button).toBeEnabled();
      expect(button).toHaveTextContent('部分撤销，重试');
      expect(button).not.toHaveTextContent('已撤销');
    });

    fireEvent.click(button);

    await waitFor(() => {
      expect(mocks.revertRun).toHaveBeenNthCalledWith(1, expectedRunId, 'session-a');
      expect(mocks.revertRun).toHaveBeenNthCalledWith(2, expectedRunId, 'session-a');
      expect(button).toBeDisabled();
      expect(button).toHaveTextContent('已撤销可恢复更改');
    });
  });

  it('disables retry when a partial rollback exhausts the ledger', async () => {
    let ledgerAlive = true;
    const expectedRunId = scopedRunId('session-a', 'tool-call-id');
    mocks.hasRun.mockImplementation(
      (runId, sessionId) =>
        ledgerAlive && runId === expectedRunId && sessionId === 'session-a',
    );
    mocks.revertRun.mockImplementationOnce(async () => {
      ledgerAlive = false;
      return false;
    });

    renderBlock(createBlock());
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

    renderBlock(block);

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
          args: {
            undoToken: 'acr-undo:persisted-1',
            approvalRiskCeiling: 'high',
          },
          runId: expect.stringMatching(
            new RegExp(`^${scopedRunId('session-a', 'persistent-act-call')}:undo:`),
          ),
          sessionId: 'session-a',
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

    renderBlock(block);

    const button = screen.getByTestId('workbench-ops-undo');
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('blocks.workbenchOps.undoExpired');
    expect(mocks.handleBridgeRequest).not.toHaveBeenCalled();
  });

  it('isolates identical toolCallId values by session', () => {
    const block = createBlock({ toolCallId: 'duplicate-call' });
    const sessionARun = scopedRunId('session-a', 'duplicate-call');
    const sessionBRun = scopedRunId('session-b', 'duplicate-call');
    mocks.hasRun.mockImplementation(
      (runId, sessionId) => runId === sessionARun && sessionId === 'session-a',
    );

    const first = renderBlock(block, 'session-a');
    expect(screen.getByTestId('workbench-ops-block')).toHaveAttribute('data-run-id', sessionARun);
    expect(screen.getByTestId('workbench-ops-undo')).toBeEnabled();
    first.unmount();

    renderBlock(block, 'session-b');
    expect(screen.getByTestId('workbench-ops-block')).toHaveAttribute('data-run-id', sessionBRun);
    expect(screen.getByTestId('workbench-ops-undo')).toBeDisabled();
    expect(mocks.hasRun).toHaveBeenCalledWith(sessionBRun, 'session-b');
  });

  it('renders RESULT_UNKNOWN as a non-retryable warning without undo', () => {
    renderBlock(createBlock({
      status: 'error',
      error: '{"code":"RESULT_UNKNOWN","retryable":false}',
      toolOutput: {
        code: 'RESULT_UNKNOWN',
        resultUnknown: true,
        retryable: false,
      },
    }));

    expect(screen.getByTestId('workbench-ops-block')).toHaveAttribute('data-status', 'unknown');
    expect(screen.getByTestId('workbench-result-unknown')).toBeInTheDocument();
    expect(screen.queryByTestId('workbench-ops-undo')).not.toBeInTheDocument();
    expect(screen.queryByText(/\{"code":"RESULT_UNKNOWN"/)).not.toBeInTheDocument();
  });

  it('keeps persistent undo disabled when no session store is available', () => {
    render(<WorkbenchOpsBlock block={createAgentActBlock('acr-undo:no-session', 'persistent')} />);

    expect(screen.getByTestId('workbench-ops-undo')).toBeDisabled();
    expect(mocks.handleBridgeRequest).not.toHaveBeenCalled();
  });

  it('prevents a second undo request while the first request is in flight', async () => {
    let resolveUndo: ((value: unknown) => void) | undefined;
    mocks.handleBridgeRequest.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveUndo = resolve;
      }),
    );
    renderBlock(createAgentActBlock('acr-undo:single-flight', 'persistent'));

    const button = screen.getByTestId('workbench-ops-undo');
    fireEvent.click(button);
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(mocks.handleBridgeRequest).toHaveBeenCalledTimes(1);

    resolveUndo?.({ correlationId: 'undo-response', ok: true, data: { reverted: true } });
    await waitFor(() => expect(button).toHaveTextContent('已撤销可恢复更改'));
  });

  it('uses a fresh operation runId when persistent undo is retried', async () => {
    mocks.handleBridgeRequest
      .mockResolvedValueOnce({ correlationId: 'undo-1', ok: true, data: { reverted: false } })
      .mockResolvedValueOnce({ correlationId: 'undo-2', ok: true, data: { reverted: true } });
    renderBlock(createAgentActBlock('acr-undo:retry-operation', 'persistent'));

    const button = screen.getByTestId('workbench-ops-undo');
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveTextContent('部分撤销，重试'));
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveTextContent('已撤销可恢复更改'));

    const operationRunIds = mocks.handleBridgeRequest.mock.calls.map(
      ([request]) => (request as { runId: string }).runId,
    );
    expect(operationRunIds).toHaveLength(2);
    expect(operationRunIds[0]).not.toBe(operationRunIds[1]);
    expect(operationRunIds.every((id) => id.startsWith(
      `${scopedRunId('session-a', 'tool-call-id')}:undo:`,
    ))).toBe(true);
  });
});
