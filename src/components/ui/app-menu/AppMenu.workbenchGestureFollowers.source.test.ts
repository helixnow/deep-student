import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readSource = (relativePath: string) =>
  readFileSync(resolve(process.cwd(), relativePath), 'utf-8');

describe('portal overlay workbench drag follower contract', () => {
  const busSource = readSource('src/features/workbench/core/workbenchGestureFollowers.ts');
  const shellSource = readSource('src/features/workbench/components/WindowShell.tsx');
  const appMenuSource = readSource('src/components/ui/app-menu/AppMenu.tsx');
  const composerSource = readSource(
    'src/features/chat/components/input-bar/ComposerPanelOverlay.tsx',
  );

  it('uses settle rAF only; drag is a synchronous shell notification', () => {
    expect(busSource).toContain("const SETTLING_ATTR = 'data-wb-settling';");
    expect(busSource).toContain('attributeFilter: [SETTLING_ATTR]');
    expect(busSource).toContain('export function subscribeWorkbenchGestureFrames');
    expect(busSource).toContain(
      'Drag followers must be updated synchronously in the same task/frame;',
    );
    expect(shellSource).not.toMatch(
      /pointermove[^\n]{0,240}WorkbenchGestureFollowers|WorkbenchGestureFollowers[^\n]{0,240}requestAnimationFrame/,
    );
    expect(shellSource).toContain('markInteraction');
  });

  it('WindowShell notifies after each shell DOM write', () => {
    expect(shellSource).toContain(
      "notifyWorkbenchGestureFrame({ phase: 'drag', x: dx, y: dy });",
    );
    expect(shellSource).toContain(
      "notifyWorkbenchGestureFrame({ phase: 'release', x: releaseDx, y: releaseDy });",
    );
    expect(shellSource).toContain(
      "notifyWorkbenchGestureFrame({ phase: 'release', x: 0, y: 0 });",
    );
  });

  it('portal overlays consume the same-frame delta and re-anchor on release', () => {
    expect(appMenuSource).toContain('subscribeWorkbenchGestureFrames(handleGestureFrame)');
    expect(appMenuSource).toContain("--wb-follow-x'");
    expect(appMenuSource).toContain('updatePosition()');

    expect(composerSource).toContain('subscribeWorkbenchGestureFrames(handleGestureFrame)');
    expect(composerSource).toContain("--wb-follow-x'");
    expect(composerSource).toContain('updatePosition()');

    const appMenuCss = readSource('src/components/ui/app-menu/AppMenu.css');
    const composerCss = readSource(
      'src/features/chat/components/input-bar/ComposerPanelOverlay.css',
    );
    expect(appMenuCss).toContain("[data-wb-gesture-follow='drag']");
    expect(composerCss).toContain("[data-wb-gesture-follow='drag']");
  });
});
