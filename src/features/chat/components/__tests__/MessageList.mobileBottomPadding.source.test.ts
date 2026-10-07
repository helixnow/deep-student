/**
 * 手机宽度下「回到底部」浮动按钮（约 48px 高，贴列表底）不能压住回答末行：
 * 列表视口在 <md 下的底部内边距要大于按钮占位，桌面端版心两侧有留白保持 pb-8。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(path.join(process.cwd(), 'src/features/chat/components/MessageList.tsx'), 'utf8');

describe('MessageList mobile bottom padding', () => {
  it('reserves room under the last line for the floating scroll-to-bottom button', () => {
    expect(source).toContain('viewportClassName="px-4 pb-16 pt-3 overscroll-contain md:px-8 md:pb-8 md:pt-4"');
  });
});
