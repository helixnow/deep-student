import { describe, expect, it, vi } from 'vitest';

import {
  isWorkbenchBlockRestored,
  markWorkbenchBlockRestored,
  remapWorkbenchBlockType,
  resolveWorkbenchRunId,
} from '../workbenchBlockRemap';

describe('workbenchBlockRemap', () => {
  it('keeps toolCallId/blockId dual candidates and selects the live ledger entry', () => {
    const hasRun = vi.fn((runId: string) => runId === 'block-id');

    expect(
      resolveWorkbenchRunId(
        { id: 'block-id', toolCallId: 'tool-call-id' },
        hasRun
      )
    ).toBe('block-id');
    expect(hasRun.mock.calls.map(([runId]) => runId)).toEqual([
      'tool-call-id',
      'block-id',
    ]);
  });

  it('falls back to the authoritative toolCallId when neither candidate is live', () => {
    expect(
      resolveWorkbenchRunId(
        { id: 'block-id', toolCallId: 'tool-call-id' },
        () => false
      )
    ).toBe('tool-call-id');
  });

  it('marks restored blocks by id without relying on toolOutput identity', () => {
    const blockId = 'restored-marker-block';
    const originalOutput = { result: { status: 'completed' } };
    const clonedOutput = structuredClone(originalOutput);

    markWorkbenchBlockRestored(blockId);

    expect(clonedOutput).toEqual(originalOutput);
    expect(isWorkbenchBlockRestored(blockId)).toBe(true);
    expect(isWorkbenchBlockRestored('different-block')).toBe(false);
  });

  it('bounds restored block markers and evicts the oldest id', () => {
    for (let index = 0; index <= 1000; index += 1) {
      markWorkbenchBlockRestored(`lru-restored-${index}`);
    }

    expect(isWorkbenchBlockRestored('lru-restored-0')).toBe(false);
    expect(isWorkbenchBlockRestored('lru-restored-1000')).toBe(true);
  });

  it('remaps persisted delegated tools to workbench_ops', () => {
    expect(remapWorkbenchBlockType('mcp_tool', 'note_append')).toBe('workbench_ops');
  });
});
