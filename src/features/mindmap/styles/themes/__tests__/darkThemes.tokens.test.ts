import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StyleRegistry } from '../../../registry/StyleRegistry';
import {
  builtinThemes,
  colorfulDarkTheme,
  colorfulTheme,
  darkTheme,
  defaultDarkTheme,
  defaultTheme,
  getThemeFontMetrics,
  minimalDarkTheme,
  minimalTheme,
  paperDarkTheme,
  paperTheme,
} from '../index';
import { DARK_SAFE_PALETTE } from '../palettes';

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
    builtinThemes.forEach(t => StyleRegistry.register(t));
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

  it.each([
    ['default', 'default-dark'],
    ['minimal', 'minimal-dark'],
    ['colorful', 'colorful-dark'],
    ['paper', 'paper-dark'],
  ])('resolves %s → %s under html.dark', (lightId, darkId) => {
    document.documentElement.classList.add('dark');
    expect(StyleRegistry.get(lightId)?.id).toBe(darkId);
  });

  it('does not remap dark id or *-dark ids', () => {
    document.documentElement.classList.add('dark');
    expect(StyleRegistry.get('dark')?.id).toBe('dark');
    expect(StyleRegistry.get('default-dark')?.id).toBe('default-dark');
  });

  it('keeps default→default-dark mapping (visual inequivalence)', () => {
    document.documentElement.classList.add('dark');
    const resolved = StyleRegistry.get('default');
    // default under dark must be the dedicated variant, not the CSS-var defaultTheme object
    expect(resolved).toBe(defaultDarkTheme);
    expect(resolved).not.toBe(defaultTheme);
  });

  it('hidden dark variants are excluded from getAll()', () => {
    const visibleIds = StyleRegistry.getAll().map(t => t.id);
    expect(visibleIds).toEqual(expect.arrayContaining(['default', 'dark', 'minimal', 'colorful', 'paper']));
    expect(visibleIds).not.toEqual(
      expect.arrayContaining(['default-dark', 'minimal-dark', 'colorful-dark', 'paper-dark']),
    );
  });
});

describe('StyleRegistry.subscribe', () => {
  beforeEach(() => {
    StyleRegistry.clear();
    document.documentElement.classList.remove('dark');
  });

  afterEach(() => {
    document.documentElement.classList.remove('dark');
    StyleRegistry.clear();
  });

  it('notifies on html.dark toggle and stops after unsubscribe', async () => {
    const listener = vi.fn();
    const unsubscribe = StyleRegistry.subscribe(listener);

    document.documentElement.classList.add('dark');
    // MutationObserver 回调是微任务，等待一轮
    await Promise.resolve();
    expect(listener).toHaveBeenCalled();

    const callsBefore = listener.mock.calls.length;
    unsubscribe();
    document.documentElement.classList.remove('dark');
    await Promise.resolve();
    expect(listener.mock.calls.length).toBe(callsBefore);
  });

  it('notifies on register / unregister / clear', () => {
    const listener = vi.fn();
    const unsubscribe = StyleRegistry.subscribe(listener);

    StyleRegistry.register(defaultTheme);
    expect(listener).toHaveBeenCalledTimes(1);
    StyleRegistry.unregister('default');
    expect(listener).toHaveBeenCalledTimes(2);
    StyleRegistry.clear();
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
  });

  it('isDarkMode reflects html.dark', () => {
    expect(StyleRegistry.isDarkMode()).toBe(false);
    document.documentElement.classList.add('dark');
    expect(StyleRegistry.isDarkMode()).toBe(true);
  });
});

describe('Token-based themes use CSS variable tokens', () => {
  // paper / paper-dark 是 identity 主题（暖色纸感有意不跟随应用背景），单独断言
  const tokenThemes = [
    defaultTheme,
    defaultDarkTheme,
    minimalTheme,
    minimalDarkTheme,
    darkTheme,
    colorfulTheme,
    colorfulDarkTheme,
  ];

  it.each(tokenThemes.map((t) => [t.id, t] as const))(
    '%s structural colors reference var()/hsl(var(--…)) and avoid legacy hardcoded hex',
    (_id, theme) => {
      const colors = collectStructuralColorStrings(theme);

      expect(colors.length).toBeGreaterThan(0);

      for (const color of colors) {
        if (color === 'transparent') continue;

        expect(color).toMatch(/var\(/);
        expect(color).not.toMatch(/#191919|#1a1a1a|#1A202C|#2a2a2a|#252525|#FFFFFF|#000000|#E0E0E0|#F8F9FA|#667eea|#764ba2/i);
        expect(color).not.toMatch(/rgba\(/i);
      }
    },
  );

  it('colorful root gradient and shadow follow brand tokens (no AI-purple hex)', () => {
    for (const theme of [colorfulTheme, colorfulDarkTheme]) {
      expect(theme.node?.root.background).toBe('var(--brand-gradient)');
      expect(theme.node?.root.foreground).toBe('hsl(var(--primary-foreground))');
      expect(theme.node?.root.shadow).toContain('hsl(var(--primary)');
    }
  });

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

describe('Paper identity themes (intentionally non-tokenized)', () => {
  it('paper light keeps warm paper canvas and ink root', () => {
    expect(paperTheme.canvas?.background).toBe('#F6F1E4');
    expect(paperTheme.node?.root.background).toBe('#2F2A24');
  });

  it('paper-dark is warm-dark with no pure-white flashes', () => {
    const colors = collectStructuralColorStrings(paperDarkTheme);
    for (const color of colors) {
      expect(color).not.toMatch(/#fff\b|#ffffff|rgba\(\s*255\s*,\s*255\s*,\s*255/i);
    }
    // 画布是暖暗色而非应用 token（identity）
    expect(paperDarkTheme.canvas?.background).toBe('#201C15');
    // 根节点为宣纸底浓墨字（亮色反转），非纯白
    expect(paperDarkTheme.node?.root.background).toBe('#EFE6D2');
  });
});

describe('Light/dark pairs are structural mirrors (colors-only difference)', () => {
  const pairs = [
    [defaultTheme, defaultDarkTheme],
    [minimalTheme, minimalDarkTheme],
    [colorfulTheme, colorfulDarkTheme],
    [paperTheme, paperDarkTheme],
  ] as const;

  it.each(pairs.map(([l, d]) => [l.id, l, d] as const))(
    '%s and its dark variant share fontSize/padding/borderRadius/fontWeight/edge structure',
    (_id, light, dark) => {
      for (const level of ['root', 'branch', 'leaf'] as const) {
        const l = light.node![level];
        const d = dark.node![level];
        expect(d.fontSize).toBe(l.fontSize);
        expect(d.padding).toBe(l.padding);
        expect(d.borderRadius).toBe(l.borderRadius);
        expect(d.fontWeight).toBe(l.fontWeight);
      }
      expect(dark.edge?.type).toBe(light.edge?.type);
      expect(dark.edge?.strokeWidth).toBe(light.edge?.strokeWidth);
    },
  );
});

describe('Rainbow palettes', () => {
  it('every builtin theme ships a 7-color palette', () => {
    for (const theme of builtinThemes) {
      expect(theme.palette, `${theme.id} palette`).toBeDefined();
      expect(theme.palette!.length).toBe(7);
      for (const color of theme.palette!) {
        expect(color).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
    }
  });

  it('default-dark and explicit dark share the same dark-safe palette', () => {
    expect(defaultDarkTheme.palette).toBe(DARK_SAFE_PALETTE);
    expect(darkTheme.palette).toBe(DARK_SAFE_PALETTE);
  });
});

describe('getThemeFontMetrics', () => {
  it('reads authoritative metrics from the theme', () => {
    expect(getThemeFontMetrics(defaultTheme, true)).toMatchObject({
      fontSize: 18,
      lineHeight: 27,
      fontWeight: '600',
      paddingX: 40, // '10px 20px' → 左右 20+20
      paddingY: 20,
    });
    expect(getThemeFontMetrics(defaultTheme, false)).toMatchObject({
      fontSize: 15,
      paddingX: 24, // '6px 12px'
      paddingY: 12,
    });
  });

  it('falls back to defaultTheme metrics when theme is missing', () => {
    expect(getThemeFontMetrics(undefined, true).fontSize).toBe(18);
    expect(getThemeFontMetrics(null, false).fontSize).toBe(15);
  });

  it('parses single-value and four-value padding shorthands', () => {
    const theme = {
      ...defaultTheme,
      id: 'padding-test',
      node: {
        ...defaultTheme.node!,
        branch: { ...defaultTheme.node!.branch, padding: '1px 2px 3px 4px' },
        root: { ...defaultTheme.node!.root, padding: '8px' },
      },
    };
    expect(getThemeFontMetrics(theme, false)).toMatchObject({ paddingX: 6, paddingY: 4 });
    expect(getThemeFontMetrics(theme, true)).toMatchObject({ paddingX: 16, paddingY: 16 });
  });
});
