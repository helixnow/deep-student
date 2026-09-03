import { describe, expect, it } from 'vitest';

import {
  ankiTaskBadgeForCount,
  formatAnkiTaskWindowTitle,
} from '../ankiTaskSource';

describe('制卡任务角标与窗口标题同源换算', () => {
  it('计数为 0 时无角标、标题不带后缀', () => {
    expect(ankiTaskBadgeForCount(0)).toBeNull();
    expect(formatAnkiTaskWindowTitle('制卡任务', 0)).toBe('制卡任务');
  });

  it('计数大于 0 时角标为 count 型、标题带「· N」后缀', () => {
    expect(ankiTaskBadgeForCount(3)).toEqual({ kind: 'count', value: 3 });
    expect(formatAnkiTaskWindowTitle('制卡任务', 3)).toBe('制卡任务 · 3');
  });

  it('任意计数下标题后缀与角标严格一致（亮则同数、灭则无缀）', () => {
    for (const count of [0, 1, 2, 5, 42, 500]) {
      const badge = ankiTaskBadgeForCount(count);
      const title = formatAnkiTaskWindowTitle('Tasks', count);
      if (badge) {
        expect(title).toBe(`Tasks · ${badge.value}`);
      } else {
        expect(title).toBe('Tasks');
      }
    }
  });
});
