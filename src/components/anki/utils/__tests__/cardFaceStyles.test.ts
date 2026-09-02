import { describe, expect, it } from 'vitest';

import { buildCardFaceCss } from '../cardFaceStyles';

describe('buildCardFaceCss surfaceColor（移动端 WebView iframe 白底修复）', () => {
  it('传入 surfaceColor 时注入 html/body 显式背景', () => {
    const css = buildCardFaceCss('', { surfaceColor: 'rgb(23, 23, 23)' });
    expect(css).toContain('html, body { background: rgb(23, 23, 23); }');
  });

  it('未传或为 null 时不注入背景（保持透明行为）', () => {
    expect(buildCardFaceCss('')).not.toContain('html, body { background:');
    expect(buildCardFaceCss('', { surfaceColor: null })).not.toContain('html, body { background:');
  });

  it('模板自带 .card 背景不受影响（模板样式仍在输出中）', () => {
    const css = buildCardFaceCss('.card { background: #fff; }', { surfaceColor: 'rgb(23, 23, 23)' });
    expect(css).toContain('.card { background: #fff; }');
    // 显式背景声明在暗色兜底之前、模板样式之后注入
    expect(css.indexOf('.card { background: #fff; }')).toBeLessThan(
      css.indexOf('html, body { background: rgb(23, 23, 23); }'),
    );
  });

  it('与 darkMode 组合时前景兜底与显式背景同时存在', () => {
    const css = buildCardFaceCss('', { darkMode: true, surfaceColor: 'rgb(23, 23, 23)' });
    expect(css).toContain('color-scheme: dark');
    expect(css).toContain('html, body { background: rgb(23, 23, 23); }');
  });
});
