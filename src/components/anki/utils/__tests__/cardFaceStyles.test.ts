import { describe, expect, it } from 'vitest';

import { buildCardFaceCss, CARD_FACE_STAGE_CSS } from '../cardFaceStyles';

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

describe('buildCardFaceCss stage（复习舞台：模板卡自然尺寸 + 纵向居中）', () => {
  it('未开启 stage 时不注入舞台样式', () => {
    expect(buildCardFaceCss('.card { color: red; }')).not.toContain(CARD_FACE_STAGE_CSS.trim());
  });

  it('开启 stage 时在模板样式之后注入舞台样式', () => {
    const css = buildCardFaceCss('.arch-card { max-width: 400px; margin: 0 auto; }', { stage: true });
    expect(css).toContain(CARD_FACE_STAGE_CSS);
    expect(css.indexOf('.arch-card')).toBeLessThan(css.indexOf(CARD_FACE_STAGE_CSS));
  });

  it('body 保持块级布局：不得改成 flex/grid（否则 margin:0 auto 的模板纸张缩成 fit-content 宽并出现双滚动条）', () => {
    const bodyRules = CARD_FACE_STAGE_CSS.match(/(^|\n)\s*body\s*\{[^}]*\}/g) ?? [];
    expect(bodyRules.length).toBeGreaterThan(0);
    for (const rule of bodyRules) {
      expect(rule).not.toMatch(/\bdisplay\s*:/);
      expect(rule).not.toMatch(/\bflex(-direction)?\s*:/);
      expect(rule).not.toMatch(/\bjustify-content\s*:/);
    }
    expect(CARD_FACE_STAGE_CSS).not.toMatch(/display\s*:\s*(inline-)?(flex|grid)/);
  });

  it('纵向居中走块容器 align-content：safe center 在后、center 作不支持 safe 的回退', () => {
    const center = CARD_FACE_STAGE_CSS.indexOf('align-content: center');
    const safeCenter = CARD_FACE_STAGE_CSS.indexOf('align-content: safe center');
    expect(center).toBeGreaterThan(-1);
    expect(safeCenter).toBeGreaterThan(center);
    expect(CARD_FACE_STAGE_CSS).toContain('min-height: 100vh');
  });
});
