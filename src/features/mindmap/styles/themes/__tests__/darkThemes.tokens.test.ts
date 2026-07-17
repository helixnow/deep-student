import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StyleRegistry } from '../../../registry/StyleRegistry';
import {
  colorfulDarkTheme,
  colorfulTheme,
  darkTheme,
  defaultDarkTheme,
  defaultTheme,
  minimalDarkTheme,
  minimalTheme,
} from '../index';

/** 收集主题对象中所有字符串颜色字段（不含 palette 品牌色） */
function collectStructuralColorStrings(theme: {
  node?: Record<string, Record<string, unknown>>;
  edge?: Record<string, unknown>;
  canvas?: Record<string, unknown>;
}): string[] {
  const values: string[] = [];
  const pushColor = (v: unknown) => {
    if (typeof v === 'string') values.push(v);
  };

  for (const level of Object.values(theme.node ?? {})) {
    pushColor(level.background);
    pushColor(level.foreground);
    pushColor(level.border);
    pushColor(level.shadow);
  }
  if (theme.edge) {
    pushColor(theme.edge.stroke);
  }
  if (theme.canvas) {
    pushColor(theme.canvas.background);
    pushColor(theme.canvas.gridColor);
  }
  return values;
}

describe('StyleRegistry dark theme resolution', () => {
  beforeEach(() => {
    StyleRegistry.clear();
    StyleRegistry.register(defaultTheme);
    StyleRegistry.register(defaultDarkTheme);
    StyleRegistry.register(minimalTheme);
    StyleRegistry.register(minimalDarkTheme);
    StyleRegistry.register(colorfulTheme);
    StyleRegistry.register(colorfulDarkTheme);
    StyleRegistry.register(darkTheme);
    document.documentElement.classList.remove('dark');
  });

  afterEach(() => {
    document.documentElement.classList.remove('dark');
    StyleRegistry.clear();
  });

  it('returns light theme when html.dark is absent', () => {
    const theme = StyleRegistry.get('default');
    expect(theme?.id).toBe('default');
  });

  it('resolves default → default-dark under html.dark', () => {
    document.documentElement.classList.add('dark');
    const theme = StyleRegistry.get('default');
    expect(theme?.id).toBe('default-dark');
  });

  it('resolves minimal → minimal-dark under html.dark', () => {
    document.documentElement.classList.add('dark');
    const theme = StyleRegistry.get('minimal');
    expect(theme?.id).toBe('minimal-dark');
  });

  it('resolves colorful → colorful-dark under html.dark', () => {
    document.documentElement.classList.add('dark');
    const theme = StyleRegistry.get('colorful');
    expect(theme?.id).toBe('colorful-dark');
    expect(theme).toBe(colorfulDarkTheme);
  });

  it('does not remap dark id or *-dark ids', () => {
    document.documentElement.classList.add('dark');
    expect(StyleRegistry.get('dark')?.id).toBe('dark');
    expect(StyleRegistry.get('default-dark')?.id).toBe('default-dark');
  });

  it('keeps default→default-dark mapping (visual inequivalence)', () => {
    document.documentElement.classList.add('dark');
    const resolved = StyleRegistry.get('default');
    const lightDefault = StyleRegistry.get('default-dark'); // already dark id
    // default under dark must be the dedicated variant, not the CSS-var defaultTheme object
    expect(resolved).toBe(defaultDarkTheme);
    expect(resolved).not.toBe(defaultTheme);
    expect(lightDefault).toBe(defaultDarkTheme);
  });
});

describe('Dark themes use CSS variable tokens', () => {
  const darkThemes = [defaultDarkTheme, minimalDarkTheme, darkTheme, colorfulDarkTheme];

  it.each(darkThemes.map((t) => [t.id, t] as const))(
    '%s structural colors reference var()/hsl(var(--…)) and avoid legacy hex canvases',
    (_id, theme) => {
      const colors = collectStructuralColorStrings(theme);

      expect(colors.length).toBeGreaterThan(0);

      for (const color of colors) {
        // brand gradient on colorful-dark root is allowed; everything else must be tokenized
        const isBrandGradient =
          theme.id === 'colorful-dark' &&
          color.startsWith('linear-gradient') &&
          color.includes('#667eea');

        if (isBrandGradient) continue;
        if (color === 'transparent') continue;

        expect(color).toMatch(/var\(/);
        expect(color).not.toMatch(/#191919|#1a1a1a|#1A202C|#2a2a2a|#252525/i);
        expect(color).not.toMatch(/rgba\(\s*255\s*,\s*255\s*,\s*255/i);
      }
    },
  );

  it('minimalDark root is dark-coordinated (not white-on-black flash)', () => {
    const root = minimalDarkTheme.node!.root;
    expect(root.background).not.toMatch(/#fff|#ffffff|white/i);
    expect(root.background).toMatch(/var\(/);
    expect(root.foreground).toMatch(/var\(/);
    expect(root.foreground).not.toMatch(/#000|#000000/i);
  });

  it('defaultDark canvas/edge use mm or foreground tokens', () => {
    expect(defaultDarkTheme.canvas?.background).toBe('var(--mm-bg)');
    expect(defaultDarkTheme.edge?.stroke).toContain('var(--foreground)');
    expect(defaultDarkTheme.node?.root.background).toBe('var(--mm-bg-elevated)');
  });
});

describe('Light themes pixel-equivalence guard', () => {
  it('default / minimal light themes keep prior hardcoded or token values unchanged by dark migration', () => {
    // default already tokenized — must remain identical
    expect(defaultTheme.node?.root.background).toBe('var(--mm-bg-elevated)');
    expect(defaultTheme.canvas?.background).toBe('var(--mm-bg)');

    // minimal light keeps intentional black/white root (亮色不回归)
    expect(minimalTheme.node?.root.background).toBe('#000000');
    expect(minimalTheme.node?.root.foreground).toBe('#FFFFFF');
    expect(minimalTheme.canvas?.background).toBe('#FFFFFF');
  });
});
