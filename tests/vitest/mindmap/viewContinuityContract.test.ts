import { afterEach, describe, expect, it } from 'vitest';

import { takeOutlineCaret } from '@/features/mindmap/utils/outlineCaret';
import {
  captureOutlineResumePoint,
  prepareOutlineResume,
} from '@/features/mindmap/utils/viewContinuity';

afterEach(() => {
  takeOutlineCaret('node-a');
  document.body.replaceChildren();
});

describe('mind-map dual-view continuity behavior', () => {
  it('captures a real outline textarea node and caret', () => {
    const row = document.createElement('div');
    row.dataset.nodeId = 'node-a';
    const textarea = document.createElement('textarea');
    textarea.dataset.mmOutlineInput = 'true';
    textarea.value = 'abcdef';
    row.append(textarea);
    document.body.append(row);
    textarea.setSelectionRange(4, 4);

    expect(captureOutlineResumePoint(textarea)).toEqual({ nodeId: 'node-a', caret: 4 });
  });

  it('restores the caret only when the resumed node remains the focus target', () => {
    expect(prepareOutlineResume(null, { nodeId: 'node-a', caret: 3 })).toBe('node-a');
    expect(takeOutlineCaret('node-a')).toBe(3);

    expect(prepareOutlineResume('node-b', { nodeId: 'node-a', caret: 5 })).toBe('node-b');
    expect(takeOutlineCaret('node-a')).toBeNull();
  });

  it('ignores unrelated textareas and malformed outline rows', () => {
    const textarea = document.createElement('textarea');
    document.body.append(textarea);
    expect(captureOutlineResumePoint(textarea)).toBeNull();
    textarea.dataset.mmOutlineInput = 'true';
    expect(captureOutlineResumePoint(textarea)).toBeNull();
  });
});
