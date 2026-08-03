import { describe, expect, it } from 'vitest';

import { getSidebarStudyRowClassName } from '../sessionSidebarStyles';

describe('getSidebarStudyRowClassName', () => {
  it('returns shared group header styling for section rows', () => {
    const className = getSidebarStudyRowClassName({
      variant: 'section',
      clickable: true,
    });

    expect(className).toContain('group/sidebar-section');
    expect(className).toContain('w-full');
    expect(className).toContain('min-h-[2.75rem]');
    expect(className).toContain('px-2.5');
    expect(className).toContain('py-1.5');
    expect(className).toContain('rounded-2xl');
    expect(className).toContain('hover:bg-[var(--sidebar-study-hover)]');
  });

  it('returns selected styling for the current session row', () => {
    const className = getSidebarStudyRowClassName({
      variant: 'session',
      selected: true,
    });

    expect(className).toContain('w-full');
    expect(className).toContain('min-h-[2.75rem]');
    expect(className).toContain('px-2.5');
    expect(className).toContain('py-1.5');
    expect(className).not.toContain('mx-1');
    expect(className).toContain('rounded-2xl');
    expect(className).toContain('bg-[var(--sidebar-study-selected)]');
    expect(className).toContain('text-foreground');
    expect(className).toContain('hover:bg-[var(--sidebar-study-selected)]');
  });
});
