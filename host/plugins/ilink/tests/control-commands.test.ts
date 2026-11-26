import { describe, expect, it, vi } from 'vitest';
import {
  IlinkPhotoBatchAggregator,
  formatRemoteSlashHelp,
  isRemoteControlSlashCommand,
  parseRemoteSlashCommand,
} from '../src/bot.ts';

describe('iLink remote control slash commands', () => {
  it('parses expanded remote control commands and aliases consistently', () => {
    expect(parseRemoteSlashCommand('/stop')).toEqual({
      kind: 'stop',
      matchedToken: 'stop',
      args: '',
    });
    expect(parseRemoteSlashCommand('/cancel')).toEqual({
      kind: 'stop',
      matchedToken: 'cancel',
      args: '',
    });
    expect(parseRemoteSlashCommand('/clear 帮我讲讲泰勒展开')).toEqual({
      kind: 'new',
      matchedToken: 'clear',
      args: '帮我讲讲泰勒展开',
    });
    expect(parseRemoteSlashCommand('/compact 保留错题结论')).toEqual({
      kind: 'compact',
      matchedToken: 'compact',
      args: '保留错题结论',
    });
    expect(parseRemoteSlashCommand('/goal 把线性代数特征值弄懂')).toEqual({
      kind: 'goal',
      matchedToken: 'goal',
      args: '把线性代数特征值弄懂',
    });
    expect(parseRemoteSlashCommand('/help')?.kind).toBe('help');
    expect(isRemoteControlSlashCommand('普通消息 /compact')).toBe(false);
    expect(formatRemoteSlashHelp()).toContain('/goal');
  });

  it('cancels photo collection on /cancel and bypasses batching on /new, /compact, /goal, and /help', () => {
    const onBatch = vi.fn();
    const scope = { accountId: 'acc', peer: 'peer', sessionId: 'sess' };
    const aggregator = new IlinkPhotoBatchAggregator<number>({ onBatch });

    aggregator.push({ ...scope, messageId: 1, attachments: [101] });
    expect(aggregator.push({ ...scope, messageId: 2, text: '/cancel' }).kind).toBe('cancelled');
    expect(onBatch).not.toHaveBeenCalled();

    for (const [idx, cmd] of ['/help', '/new', '/compact', '/goal status'].entries()) {
      const scoped = { ...scope, sessionId: `s_${idx}` };
      aggregator.push({ ...scoped, messageId: 10 + idx, attachments: [200 + idx] });
      const res = aggregator.push({ ...scoped, messageId: 30 + idx, text: cmd });
      expect(res.kind).toBe('bypass');
      expect(res.batches).toHaveLength(1);
    }
    aggregator.dispose();
  });
});
