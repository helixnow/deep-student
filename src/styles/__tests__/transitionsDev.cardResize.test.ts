import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('transitions-dev card resize hook', () => {
  const css = readFileSync(
    resolve(process.cwd(), 'src/styles/transitions-dev.css'),
    'utf-8'
  );

  it('keeps the portable width and height resize transition with reduced-motion support', () => {
    expect(css).toContain('.t-resize {');
    expect(css).toContain('width  var(--resize-dur) var(--resize-ease)');
    expect(css).toContain('height var(--resize-dur) var(--resize-ease)');
    // will-change: width/height 是布局属性，声明 will-change 换不来合成器
    // 加速、只多占图层内存——合入 main 时 CSS 已删掉该行，这里不再断言。
    expect(css).not.toContain('will-change: width, height;');

    const reducedMotion = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reducedMotion).toContain('.t-resize { transition: none !important; }');
  });
});
