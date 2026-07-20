import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('chat v2 composer panel sizing contract', () => {
  const overlaySource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/input-bar/ComposerPanelOverlay.tsx'),
    'utf-8'
  );
  const inputBarSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/input-bar/InputBarUI.tsx'),
    'utf-8'
  );
  const skillSelectorSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/skills/components/SkillSelector.tsx'),
    'utf-8'
  );
  const mcpPanelSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/plugins/chat/McpPanel.tsx'),
    'utf-8'
  );
  const composerPanelSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/input-bar/ComposerPanel/ComposerPanel.tsx'),
    'utf-8'
  );

  it('uses a wide anchored tray for complex composer panels instead of composer-width popovers', () => {
    expect(overlaySource).toContain("widthMode?: 'anchor' | 'wide'");
    expect(overlaySource).toContain('preferredWidth');
    expect(inputBarSource).toContain('widthMode="wide"');
    expect(inputBarSource).toContain('heightMode="available"');
  });

  it('lets skill and MCP panels fill the available tray height with internal scroll regions', () => {
    expect(skillSelectorSource).toContain('flex min-h-0 flex-1 gap-3 overflow-hidden');
    // 禁固定高度 h-[240px]；menu 变体的 min-h-[240px]（最小可视高度保障）不在此列
    expect(skillSelectorSource).not.toMatch(/(?<!min-)h-\[240px\]/);
    // menu 变体：AppMenuSubContent 只有 max-height（不定高），列表不能用 h-full
    // 百分比取高（会按内容撑高、失去滚动），必须走 flex stretch
    expect(skillSelectorSource).toContain('fullHeight={!isMenuVariant}');
    expect(composerPanelSource).toContain("'flex min-h-0 flex-col gap-3'");
    expect(composerPanelSource).toContain("fillHeight && 'h-full'");
    expect(mcpPanelSource).toContain('<ComposerPanel.Root fillHeight className="overflow-hidden">');
    expect(mcpPanelSource).toContain('className="flex-1 min-h-0"');
  });
});
