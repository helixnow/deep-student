/**
 * 思维导图界面去冗余 — source 守卫（2026-10）
 *
 * - 「隐藏已完成」只在工具栏「学习」组出现一次，更多菜单不再重复同一开关；
 * - 背诵状态条进度只用「进度条 + 已揭示/总数」表达，不再叠加百分比与剩余数；
 * - 结构选择面板不再在底部复述标题（「选择不同结构可改变导图的布局方式」）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(path.join(process.cwd(), p), 'utf8');

describe('mind map chrome has no duplicated entries or restated text', () => {
  it('exposes hide-completed once (toolbar learning group, not the more menu)', () => {
    const source = read('src/features/mindmap/MindMapContentView.tsx');
    expect(source).toContain('onClick={() => setHideCompleted(!hideCompleted)}');
    expect(source).not.toContain('onCheckedChange={setHideCompleted}');
  });

  it('recite status bar states progress once', () => {
    const source = read('src/features/mindmap/components/shared/ReciteStatusBar.tsx');
    expect(source).not.toContain("recite.remaining");
    expect(source).not.toMatch(/Math\.round\(\(progress\.revealed \/ progress\.total\) \* 100\)/);
    expect(source).toContain('{progress.revealed}/{progress.total}');
  });

  it('structure selector drops the footer that restates its title', () => {
    expect(read('src/features/mindmap/components/mindmap/StructureSelector.tsx')).not.toContain("t('structure.hint')");
  });
});
