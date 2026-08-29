/**
 * 命令面板移动端触控/缩放契约（源码断言）：
 * vitest 配置里 `css: false`，jsdom 量不到真实计算值，
 * 因此对样式表源码做契约断言，锁住 390px 宽下的硬指标。
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(
  resolve(process.cwd(), 'src/command-palette/styles/command-palette.css'),
  'utf-8',
);

/** 取出某个 @media 块的内容（按大括号配平截取） */
function mediaBlock(header: string): string {
  const start = css.indexOf(header);
  expect(start).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced media block: ${header}`);
}

describe('命令面板移动端触控契约', () => {
  const narrowViewportBlocks = css
    .split('@media')
    .filter((chunk) => chunk.trimStart().startsWith('(width < 768px)'));

  it('窄视口下输入框字号不低于 iOS 自动缩放阈值 16px', () => {
    const inputRule = narrowViewportBlocks
      .join('\n')
      .match(/\.command-palette-input\s*\{[^}]*\}/);
    expect(inputRule).not.toBeNull();
    expect(inputRule![0]).toMatch(/font-size:\s*16px/);
  });

  it('窄视口下结果行触控高度 ≥44px（不依赖 pointer: coarse）', () => {
    expect(narrowViewportBlocks.join('\n')).toMatch(
      /\.command-palette-item\s*\{[^}]*min-height:\s*44px/,
    );
  });

  it('窄视口下关闭/返回/模式按钮触控目标 ≥44px', () => {
    const joined = narrowViewportBlocks.join('\n');
    const touchTargetRule = joined.match(
      /\.command-palette-back-btn,\s*\n\s*\.command-palette-close-btn,\s*\n\s*\.command-palette-mode-btn\s*\{[^}]*\}/,
    );
    expect(touchTargetRule).not.toBeNull();
    expect(touchTargetRule![0]).toMatch(/width:\s*44px/);
    expect(touchTargetRule![0]).toMatch(/height:\s*44px/);
  });

  it('粗指针下同样保留 44px 触控目标与常显收藏按钮', () => {
    const coarse = mediaBlock('@media (pointer: coarse)');
    expect(coarse).toMatch(/\.command-palette-item\s*\{[^}]*min-height:\s*44px/);
    expect(coarse).toMatch(/\.command-palette-item-favorite\s*\{[^}]*opacity:\s*1/);
  });

  it('收藏按钮聚焦时必须显形，避免「不可见但可 Tab 到」的键盘陷阱', () => {
    expect(css).toContain('.command-palette-item-favorite:focus-visible');
  });
});
