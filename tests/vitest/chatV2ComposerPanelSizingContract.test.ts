import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('chat v2 composer panel sizing contract', () => {
  const overlaySource = readFileSync(
    resolve(process.cwd(), 'src/chat-v2/components/input-bar/ComposerPanelOverlay.tsx'),
    'utf-8'
  );
  const inputBarSource = readFileSync(
    resolve(process.cwd(), 'src/chat-v2/components/input-bar/InputBarUI.tsx'),
    'utf-8'
  );
  const skillSelectorSource = readFileSync(
    resolve(process.cwd(), 'src/chat-v2/skills/components/SkillSelector.tsx'),
    'utf-8'
  );
  const mcpPanelSource = readFileSync(
    resolve(process.cwd(), 'src/chat-v2/plugins/chat/McpPanel.tsx'),
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
    expect(skillSelectorSource).not.toContain('h-[240px]');
    expect(mcpPanelSource).toContain('flex h-full min-h-0 flex-col gap-2 overflow-hidden');
    expect(mcpPanelSource).toContain('className="flex-1 min-h-0"');
  });
});
