import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 暗色阴影层次契约。
 *
 * --shadow-base 是纯黑色相基，投影强度由 --shadow-strength-* 承担。暗色主题
 * 背景 L≈9%~12%，沿用亮色的 0.04~0.10 alpha 等于没有阴影，浮层与底板完全
 * 糊在一起。本测试锁住：强度 token 存在、暗色确实抬高了每一档、配方不再
 * 内联写死 alpha，并且暗色仍然用黑基（白阴影是发光，与本体系的光照隐喻
 * 冲突）。
 */
describe('dark mode shadow elevation contract', () => {
  const themeSource = readFileSync(resolve(process.cwd(), 'src/styles/theme-colors.css'), 'utf-8');

  const blockOf = (selector: string) => {
    const start = themeSource.indexOf(`${selector} {`);
    expect(start, `theme-colors.css should contain a ${selector} block`).toBeGreaterThan(-1);
    return themeSource.slice(start, themeSource.indexOf('\n}', start));
  };

  const lightBlock = blockOf(':where(:root)');
  const darkBlock = blockOf(':root.dark');

  const strengths = (block: string) => {
    const map = new Map<string, number>();
    for (const match of block.matchAll(/(--shadow-strength-[a-z-]+):\s*([\d.]+);/g)) {
      map.set(match[1], Number.parseFloat(match[2]));
    }
    return map;
  };

  const lightStrengths = strengths(lightBlock);
  const darkStrengths = strengths(darkBlock);

  it('exposes a shadow strength scale in the light token block', () => {
    expect([...lightStrengths.keys()].sort()).toEqual([
      '--shadow-strength-content-elevated',
      '--shadow-strength-content-soft',
      '--shadow-strength-content-subtle',
      '--shadow-strength-floating',
      '--shadow-strength-panel',
      '--shadow-strength-pressed',
      '--shadow-strength-sheet',
      '--shadow-strength-soft',
    ]);
  });

  it('raises every shadow strength step in dark mode to a visible alpha', () => {
    expect(darkStrengths.size).toBe(lightStrengths.size);
    for (const [token, lightValue] of lightStrengths) {
      const darkValue = darkStrengths.get(token);
      expect(darkValue, `${token} must be re-tuned for dark mode`).toBeDefined();
      expect(darkValue!, `${token} must be stronger in dark mode`).toBeGreaterThan(lightValue);
      // 0.25 以下的黑色投影在 L≈9% 的底上肉眼不可见
      expect(darkValue!, `${token} must be visible on a near-black surface`).toBeGreaterThanOrEqual(0.25);
    }
  });

  it('keeps a black shadow base in both themes instead of flipping to a white glow', () => {
    expect(lightBlock).toMatch(/--shadow-base:\s*0 0% 0%;/);
    expect(darkBlock).toMatch(/--shadow-base:\s*0 0% 0%;/);
  });

  it('routes the shared shadow recipes through the strength scale', () => {
    const recipes = [
      '--shadow-shell-soft',
      '--shadow-shell-panel',
      '--shadow-shell-floating',
      '--shadow-shell-pressed',
      '--shadow-content-subtle',
      '--shadow-content-soft',
      '--shadow-content-elevated',
      '--mobile-sheet-shadow',
    ];

    for (const recipe of recipes) {
      const declaration = lightBlock.match(new RegExp(`${recipe}:\\s*([^;]+);`))?.[1] ?? '';
      expect(declaration, `${recipe} should be defined in the light token block`).not.toBe('');
      expect(declaration, `${recipe} should read its alpha from --shadow-strength-*`).toMatch(
        /hsl\(var\(--shadow-base\) \/ var\(--shadow-strength-[a-z-]+\)\)/,
      );
      expect(declaration, `${recipe} should not inline a hardcoded alpha`).not.toMatch(
        /var\(--shadow-base\)\s*\/\s*[\d.]+/,
      );
    }
  });
});
