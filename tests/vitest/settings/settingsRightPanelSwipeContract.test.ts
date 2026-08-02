import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readSource = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf-8');

describe('settings right panel swipe contract', () => {
  it('does not expose the contextual right panel through a left swipe', () => {
    const settingsSource = readSource('src/features/settings/components/Settings.tsx');

    expect(settingsSource).toContain('rightPanelSwipeEnabled={false}');
    expect(settingsSource).toContain('showSidebarAppNavigation={false}');
    expect(settingsSource).toContain('enableGesture={false}');
  });

  it('keeps the shared layout gesture enabled by default for other mobile pages', () => {
    const mobileLayoutSource = readSource('src/components/layout/MobileSlidingLayout.tsx');

    expect(mobileLayoutSource).toContain('rightPanelSwipeEnabled?: boolean;');
    expect(mobileLayoutSource).toContain('rightPanelSwipeEnabled = true');
    expect(mobileLayoutSource).toContain(
      "screenPosition === 'center' && rightPanelEnabled && rightPanelSwipeEnabled",
    );
  });
});
