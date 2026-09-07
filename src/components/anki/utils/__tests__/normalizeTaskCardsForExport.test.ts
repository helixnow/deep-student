import { describe, expect, it } from 'vitest';
import type { AnkiCard } from '@/types';
import { selectTaskExportCards } from '../normalizeTaskCardsForExport';

/**
 * 回归（2026-09-07 排查）：卡片 fields/extra_fields 经 Rust HashMap IPC
 * 序列化，键序随随机种子逐次响应变化。旧实现用 JSON.stringify 比对字段，
 * 同内容不同键序即误判"确有编辑"，且快照 updated_at 缺省恒新于 DB，
 * 导致陈旧块快照在导出时静默覆盖 DB 权威卡（A9 修复方向被反转）。
 */
describe('selectTaskExportCards', () => {
  const makeCard = (
    id: string,
    fields: Record<string, string>,
    updatedAt: string,
  ): AnkiCard =>
    ({
      id,
      front: fields.Front ?? '',
      back: fields.Back ?? '',
      tags: [],
      images: [],
      extra_fields: fields,
      updated_at: updatedAt,
    }) as unknown as AnkiCard;

  it('字段内容相同但键序不同 → 不视为编辑，DB 权威卡胜出', () => {
    // 同一份字段的两种键序（模拟 HashMap 两次独立序列化）
    const dbCard = makeCard(
      'card-1',
      { Front: '正面', Back: '背面', Extra: '附加' },
      '2026-09-01T10:00:00Z',
    );
    const snapshotCard = makeCard(
      'card-1',
      { Back: '背面', Extra: '附加', Front: '正面' },
      '2026-09-07T09:00:00Z',
    );

    const merged = selectTaskExportCards([snapshotCard], [dbCard]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe(dbCard);
  });

  it('字段内容真实不同 → 视为编辑，编辑副本胜出', () => {
    const dbCard = makeCard(
      'card-1',
      { Front: '正面', Back: '背面' },
      '2026-09-01T10:00:00Z',
    );
    const snapshotCard = makeCard(
      'card-1',
      { Front: '正面（已编辑）', Back: '背面' },
      '2026-09-07T09:00:00Z',
    );

    const merged = selectTaskExportCards([snapshotCard], [dbCard]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe(snapshotCard);
  });
});
