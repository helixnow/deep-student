import { describe, expect, it } from 'vitest';

import {
  extractChangeCoverageIssues,
  isChangeProducingTool,
  isRuntimeTool,
} from '../AgentTaskPanel';

describe('AgentTaskPanel file-manager result recognition', () => {
  it.each(['builtin-file_manager_commit', 'builtin-file_manager_restore'])(
    'recognizes %s as a runtime change',
    (toolName) => {
      expect(isChangeProducingTool(toolName)).toBe(true);
      expect(isRuntimeTool(toolName)).toBe(true);
    },
  );

  it('surfaces a partial batch manifest instead of treating the tool block as complete', () => {
    const issues = extractChangeCoverageIssues([
      {
        status: 'success',
        toolName: 'builtin-file_manager_commit',
        toolOutput: {
          complete: false,
          batch_manifest: {
            expectedItems: 2,
            observedItems: 2,
            coverageComplete: true,
            truncated: false,
            items: [
              { itemId: 'one', status: 'succeeded', attempts: 1 },
              { itemId: 'two', status: 'failed', attempts: 1, error: 'OCC conflict' },
            ],
          },
        },
      } as never,
    ]);

    expect(issues).toHaveLength(1);
    expect(issues[0].detail).toContain('batch-partial:1');
  });
});
