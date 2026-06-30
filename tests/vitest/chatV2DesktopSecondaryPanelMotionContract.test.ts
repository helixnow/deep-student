import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('ChatV2 desktop secondary panel motion contract', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/features/chat/pages/ChatV2Page.tsx'),
    'utf-8'
  );

  it('animates the desktop secondary panel as a single translated shell', () => {
    expect(source).toContain('const desktopSecondaryPanelOpen = !isSmallScreen');
    expect(source).toContain("const DESKTOP_SECONDARY_PANEL_WIDTH = 'clamp(320px, 42vw, 720px)'");
    expect(source).toContain("const DESKTOP_SECONDARY_PANEL_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)'");
    expect(source).toContain('const desktopSecondaryPanelShellClassName = cn(');
    expect(source).toContain("desktopSecondaryPanelOpen ? 'translate-x-0 opacity-100' : 'pointer-events-none translate-x-full opacity-0'");
    expect(source).not.toContain('absolute inset-y-0 right-0 z-10');
    expect(source).toContain('width: desktopSecondaryPanelOpen ? DESKTOP_SECONDARY_PANEL_WIDTH : 0');
    expect(source).toContain('transitionTimingFunction: DESKTOP_SECONDARY_PANEL_EASING');
    expect(source).toContain('pointer-events-none translate-x-full opacity-0');
  });
});
