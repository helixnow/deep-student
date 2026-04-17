import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('settings single sidebar layout contract', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf-8');

  it('does not render the global ModernSidebar while the settings view is active on desktop', () => {
    expect(appSource).toContain("{!isSmallScreen && currentView !== 'settings' ? (");
  });
});
