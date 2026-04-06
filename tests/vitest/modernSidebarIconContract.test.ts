import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('modern sidebar icon contract', () => {
  const sidebarSource = readFileSync(resolve(process.cwd(), 'src/components/ModernSidebar.tsx'), 'utf-8');

  it('keeps navigation icon stroke width stable across selected states', () => {
    expect(sidebarSource).toContain('<Icon className="size-[18px]" strokeWidth={2} />');
    expect(sidebarSource).toContain('<StudySettingsIcon className="size-[18px]" strokeWidth={2} />');
    expect(sidebarSource).not.toContain('strokeWidth={isActive ? 2.3 : 2}');
    expect(sidebarSource).not.toContain("strokeWidth={currentView === 'settings' ? 2.3 : 2}");
  });
});
