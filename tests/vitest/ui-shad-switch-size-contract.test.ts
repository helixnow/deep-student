import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('shared switch size contract', () => {
  const switchSource = readFileSync(
    resolve(process.cwd(), 'src/components/ui/shad/Switch.tsx'),
    'utf-8'
  );
  const advancedPanelSource = readFileSync(
    resolve(process.cwd(), 'src/chat-v2/plugins/chat/AdvancedPanel.tsx'),
    'utf-8'
  );
  const apisTabSource = readFileSync(
    resolve(process.cwd(), 'src/features/settings/components/ApisTab.tsx'),
    'utf-8'
  );

  it('supports explicit switch sizes instead of relying on transform scaling hacks', () => {
    expect(switchSource).toContain("size?: 'sm' | 'default'");
    expect(switchSource).toContain("data-size={size}");
    expect(switchSource).toContain("size === 'sm'");
    expect(switchSource).not.toContain("import './Switch.css';");
  });

  it('replaces scale-75 switch overrides in dense panels with the shared small size', () => {
    expect(advancedPanelSource).toContain('size="sm"');
    expect(advancedPanelSource).not.toContain('scale-75');
    expect(apisTabSource).toContain('size="sm"');
    expect(apisTabSource).not.toContain('scale-75');
  });
});
