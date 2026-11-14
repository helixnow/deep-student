// fsrs_review_logs.state_before_json 的字节格式：Rust `serde_json::to_string(&FsrsStateBeforeSnapshot)`
// （fsrs_review_service.rs:2144-2145）。f64 整数值写 `92.0`，`Option` 的 None 写 `null`，键序 = 结构体声明序。
// 期望值来自 host/platform/serde-compat/tests/__fixtures__/rust-sampler 的真实 Rust 输出。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { FsrsReviewService } from '../src/review.ts';
import { decodeStateBeforeSnapshot, encodeStateBeforeSnapshot, stateBeforeSnapshot } from '../src/fsrs-types.ts';
import { mistakesFixture } from './storage.ts';

const RUST = (JSON.parse(readFileSync(join(import.meta.dirname,
  '../../../platform/serde-compat/tests/__fixtures__/serde-json-floats.json'), 'utf8')) as {
  fsrsStateBeforeSnapshot: string[];
}).fsrsStateBeforeSnapshot;

const fixtures: ReturnType<typeof mistakesFixture>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.dispose(); });

it('encodeStateBeforeSnapshot 与 Rust serde_json 原文逐字节一致', () => {
  expect(RUST.length).toBeGreaterThan(0);
  for (const rust of RUST) {
    const decoded = decodeStateBeforeSnapshot(rust);
    if (decoded === null) {
      // 第 4 例含 i64::MAX 等超出 JS 安全整数的值，Host 不可能持有，解码按设计拒绝。
      expect(rust).toContain('9223372036854775807');
      continue;
    }
    expect(encodeStateBeforeSnapshot(decoded)).toBe(rust);
  }
});

it('非有限 f64 写 null（serde_json ser.rs serialize_f64）', () => {
  const rust = RUST.find(text => text.includes('"stability":null,"difficulty":null,"elapsedDays":36500.0'))!;
  const decoded = JSON.parse(rust.replace(/9223372036854775807|-9223372036854775808/g, '0')) as ReturnType<typeof stateBeforeSnapshot>;
  const text = encodeStateBeforeSnapshot({ ...decoded, stability: Number.NaN, difficulty: Infinity });
  expect(text).toContain('"stability":null,"difficulty":null,"elapsedDays":36500.0,"scheduledDays":1e+16,');
});

it('rate 写入的 state_before_json 按 Rust f64 拼写（新卡 elapsedDays/scheduledDays 为 0.0）', () => {
  const fixture = mistakesFixture();
  fixtures.push(fixture);
  const { db } = fixture;
  db.run(`INSERT INTO document_tasks (id, document_id, original_document_name, segment_index, content_segment, status,
    anki_generation_options_json) VALUES ('t1', 'd1', 'test.md', 0, 'segment', 'Completed', '{}')`);
  db.run(`INSERT INTO anki_cards (id, task_id, front, back, source_type, source_id)
    VALUES ('c1', 't1', 'f', 'b', 'document', 'd1')`);
  const service = new FsrsReviewService(db);
  const stateId = service.enqueueCards(['c1']).states[0]!.id;
  const before = service.getCardState(stateId)!;
  const first = service.rate(stateId, 3, 250, null);
  const firstJson = db.pluck<string>('SELECT state_before_json FROM fsrs_review_logs WHERE id = ?1', [first.logId])!;
  expect(firstJson).toContain('"elapsedDays":0.0,"scheduledDays":0.0,');
  expect(firstJson).toBe(encodeStateBeforeSnapshot(stateBeforeSnapshot(before)));

  db.run('UPDATE fsrs_card_states SET stability = 92.0, difficulty = 5.0, desired_retention = 1.0 WHERE id = ?1', [stateId]);
  const second = service.rate(stateId, 3, 500, null);
  const secondJson = db.pluck<string>('SELECT state_before_json FROM fsrs_review_logs WHERE id = ?1', [second.logId])!;
  expect(secondJson).toContain('"stability":92.0,"difficulty":5.0,');
  expect(secondJson).toContain('"desiredRetention":1.0,');
  // 撤销仍能读回同一快照
  expect(service.undoLastReview(second.logId, stateId).changed).toBe(true);
});
