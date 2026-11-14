/**
 * Rust `agent_wiring/plugins.rs` `ResearchInsightHints::existence_hints`：chat 每轮的被动
 * 灵感提示。G3 chat 流式场景里 Rust 每轮写一条 `silence_no_match`（确定性 id），TS 缺失。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { insertInsightCardFixture } from '../repository/insight-cards.ts';
import type { InsightHintsService } from '../api.ts';
import { setupMemoryHost, type MemoryHost } from './support.ts';

let current: MemoryHost | undefined;
afterEach(async () => { await current?.dispose(); current = undefined; });

async function setup() {
  current = await setupMemoryHost();
  const hints = current.host.ctx.get('insightHints') as InsightHintsService;
  return { ...current, hints };
}

function events(db: MemoryHost['db']) {
  return db.all<{ id: string; insight_id: string | null; session_id: string | null; message_id: string | null;
    event_type: string; help_level: string }>(
    'SELECT id, insight_id, session_id, message_id, event_type, help_level FROM insight_events ORDER BY rowid');
}

const request = (userContent: string, userMessageId = 'msg_x5') =>
  ({ sessionId: 'sess_1', userMessageId, userContent });

describe('insightHints.existenceHints', () => {
  it('no candidate records one idempotent silence_no_match per user turn', async () => {
    const { hints, db } = await setup();
    expect(hints.existenceHints(request('  求这个积分的步骤  '))).toBeNull();
    expect(hints.existenceHints(request('求这个积分的步骤'))).toBeNull();
    expect(events(db)).toEqual([{
      id: 'iev_sess_1_msg_x5_none_silence_no_match', insight_id: null, session_id: 'sess_1',
      message_id: 'msg_x5', event_type: 'silence_no_match', help_level: 'none',
    }]);
  });

  it('a query under four chars returns before recall and writes nothing', async () => {
    const { hints, db } = await setup();
    expect(hints.existenceHints(request(' 你好呀 '))).toBeNull();
    expect(events(db)).toEqual([]);
  });

  it('disabled policy writes silence_user_disabled even for short input', async () => {
    const { hints, db, storage } = await setup();
    const main = storage.database('mistakes');
    main.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
    main.run("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('insight.recall.enabled', '0', 'now')");
    expect(hints.existenceHints(request('嗨'))).toBeNull();
    expect(events(db).map(row => `${row.id} ${row.help_level}`))
      .toEqual(['iev_sess_1_msg_x5_none_silence_user_disabled none']);
  });

  it('a match discloses only the title at existence level and bumps shown_count once', async () => {
    const { hints, db } = await setup();
    insertInsightCardFixture(db, {
      id: 'ic_hint', title: '导数结构识别 → 换元', situation: '被积函数次数太高', stuckPoint: '展开不现实',
      turningPoint: '秘密转折', rule: '秘密规则', validityConditions: '条件', createdAt: '2026-07-10T00:00:00+00:00',
    });
    expect(hints.existenceHints(request('被积函数次数太高'))).toBe('- [灵感] 导数结构识别 → 换元');
    expect(hints.existenceHints(request('被积函数次数太高'))).toBe('- [灵感] 导数结构识别 → 换元');
    expect(events(db).map(row => `${row.id} ${row.help_level}`))
      .toEqual(['iev_sess_1_msg_x5_ic_hint_shown_existence existence']);
    expect(db.pluck<number>("SELECT shown_count FROM insights WHERE id = 'ic_hint'")).toBe(1);
  });
});
