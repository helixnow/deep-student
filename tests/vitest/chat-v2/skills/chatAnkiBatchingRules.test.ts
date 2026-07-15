import { describe, expect, it } from 'vitest';
import { chatAnkiSkill } from '@/features/chat/skills/builtin';

describe('ChatAnki batching rules', () => {
  it('allows only the explicit small-content path to skip ask_user', () => {
    const content = chatAnkiSkill.content ?? '';

    expect(content).toContain('`content` **少于 800 字**');
    expect(content).toContain('`maxCards <= 10`');
    expect(content).toContain('可跳过 `builtin-ask_user` 直接 run/start');
    expect(content).toContain('仍必须执行 `wait -> get_cards` 的完整验收循环');
    expect(content).toContain('参数有任何歧义时仍先 ask_user');
    expect(content).not.toContain('用户已明确时可跳过');
  });

  it('requires targets over 100 cards to run and verify in bounded batches', () => {
    const content = chatAnkiSkill.content ?? '';
    const run = chatAnkiSkill.embeddedTools?.find(
      (tool) => tool.name === 'builtin-chatanki_run',
    );
    const start = chatAnkiSkill.embeddedTools?.find(
      (tool) => tool.name === 'builtin-chatanki_start',
    );
    const runMaxCards = (run?.inputSchema as any)?.properties?.maxCards;
    const startMaxCards = (start?.inputSchema as any)?.properties?.maxCards;

    expect(content).toContain('单次硬上限是 100');
    expect(content).toContain('`resourceId` / `resourceIds` 子集');
    expect(content).toContain('每批 `maxCards <= 100`');
    expect(content).toContain('每批分别 `builtin-chatanki_wait`');
    expect(content).toContain('每批用 `builtin-chatanki_get_cards` 分页读回全部卡片');
    expect(content).toContain('汇总各批 documentId、生成数与修订数');
    expect(content).toContain('禁止一次塞入几十个 `resourceIds` 后不管');
    expect(content).toContain('明确目标超过 100 时不得原样传入');
    expect(content).toContain('已达 100 仍需更多时');
    expect(runMaxCards).toMatchObject({ type: 'integer', minimum: 1, maximum: 100 });
    expect(startMaxCards).toMatchObject({ type: 'integer', minimum: 1, maximum: 100 });
    expect(runMaxCards.description).toContain('超过 100 张时必须拆成多批');
    expect(startMaxCards.description).toContain('超过 100 张时必须拆成多批');
  });
});
