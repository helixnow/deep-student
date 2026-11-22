/**
 * 思维导图界面去冗余 — source 守卫（2026-10 / Wave 2 壳层拆解同步）
 *
 * - 「隐藏已完成」只在工具栏「学习」组出现一次，更多菜单不再重复同一开关；
 * - 壳层主文件与工具栏模块共同受守卫约束，杜绝拆分后回流重复入口；
 * - 工具栏图标去重：样式统一使用 Palette（不再用 Gear），导图视图切换与结构选择不再撞车；
 * - 背诵状态条进度只用「进度条 + 已揭示/总数」表达，不再叠加百分比与剩余数；
 * - 结构选择面板不再在底部复述标题（「选择不同结构可改变导图的布局方式」）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(path.join(process.cwd(), p), 'utf8');

describe('mind map chrome has no duplicated entries or restated text', () => {
  it('exposes hide-completed once (toolbar learning group, not the more menu)', () => {
    const contentViewSource = read('src/features/mindmap/MindMapContentView.tsx');
    const toolbarSource = read('src/features/mindmap/components/shell/MindMapToolbar.tsx');

    const matches = toolbarSource.match(/onClick=\{\(\) => setHideCompleted\(!hideCompleted\)\}/g) ?? [];
    expect(matches).toHaveLength(1);
    expect(toolbarSource).not.toContain('onCheckedChange={setHideCompleted}');
    expect(contentViewSource).not.toContain('onCheckedChange={setHideCompleted}');
    expect(contentViewSource).not.toContain('onClick={() => setHideCompleted(!hideCompleted)}');
  });

  it('uses distinct toolbar icons for style (Palette) and mindmap view switcher (TreeStructure)', () => {
    const toolbarSource = read('src/features/mindmap/components/shell/MindMapToolbar.tsx');
    expect(toolbarSource).toContain('<Palette size={16} />');
    expect(toolbarSource).not.toContain('<Gear');
    expect(toolbarSource).toContain('<TreeStructure className="mm-view-switcher-icon');
  });

  it('recite status bar states progress once', () => {
    const source = read('src/features/mindmap/components/shared/ReciteStatusBar.tsx');
    expect(source).not.toContain('recite.remaining');
    expect(source).not.toMatch(/Math\.round\(\(progress\.revealed \/ progress\.total\) \* 100\)/);
    expect(source).toContain('{progress.revealed}/{progress.total}');
  });

  it('structure selector drops the footer that restates its title and removes dead PresetItem store hook', () => {
    const source = read('src/features/mindmap/components/mindmap/StructureSelector.tsx');
    expect(source).not.toContain("t('structure.hint')");
    const presetItemBlock = source.slice(
      source.indexOf('const PresetItem:'),
      source.indexOf('const CategorySection:'),
    );
    expect(presetItemBlock).not.toContain('useMindMapIsActive');
  });

  it('uses valid mindmap i18n keys instead of nonexistent common:on/off or chatV2 selectionToolbar keys', () => {
    const styleSource = read('src/features/mindmap/components/toolbar/StylePanel.tsx');
    const formatSource = read('src/features/mindmap/components/toolbar/FormatBar.tsx');
    const outlineMenuSource = read('src/features/mindmap/views/outline/OutlineNodeMenu.tsx');

    expect(styleSource).not.toContain("t('common:on'");
    expect(styleSource).not.toContain("t('common:off'");
    expect(styleSource).toContain("t('style.checkboxOn'");
    expect(styleSource).toContain("t('style.checkboxOff'");
    expect(formatSource).not.toContain('chatV2:selectionToolbar.addAsContext');
    expect(outlineMenuSource).not.toContain('chatV2:selectionToolbar.addAsContext');
  });
});
