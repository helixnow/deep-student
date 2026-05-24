import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const messageItemSource = readFileSync(
  resolve(process.cwd(), 'src/features/chat/components/MessageItem.tsx'),
  'utf-8'
);

const messageActionsSource = readFileSync(
  resolve(process.cwd(), 'src/features/chat/components/message/MessageActions.tsx'),
  'utf-8'
);

describe('MessageItem mobile actions source', () => {
  it('uses compact mobile message actions instead of the full inline action row', () => {
    expect(messageItemSource).toContain('compactMobile');
  });

  it('keeps mobile assistant metadata on a single lightweight row', () => {
    expect(messageItemSource).toContain('第一行：移动端 = 时间/AI标识(左) + 精简操作(右)');
    expect(messageItemSource).not.toContain('第二行（移动端）：模型名称(左) + AI 标识(右)');
  });

  it('does not render compact token usage in the mobile-specific branch', () => {
    const mobileBranch = messageItemSource.slice(
      messageItemSource.indexOf('{isSmallScreen && !isUser && ('),
      messageItemSource.indexOf('{!isSmallScreen && (')
    );

    expect(mobileBranch).not.toContain('TokenUsageDisplay');
  });

  it('routes secondary mobile actions through the more menu', () => {
    expect(messageActionsSource).toContain('if (compactMobile)');
    expect(messageActionsSource).toContain('<DotsThree');
    expect(messageActionsSource).toContain('width={compactMobile ? 168 : 188}');
  });

  it('keeps the compact mobile affordances visually tighter', () => {
    expect(messageActionsSource).toContain('!h-9 !w-9 rounded-full');
    expect(messageActionsSource).toContain('width={compactMobile ? 168 : 188}');
    expect(messageItemSource).toContain('text-[10px] leading-none text-muted-foreground/45');
  });
});
