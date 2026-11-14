// boundary-allow cross-plugin-impl: R2 需要安装真实 L24 chatanki 插件，验证它经公开 review@1 消费 scoped 快照；L24 尚未提供测试宿主工厂。
// 边界：本用例的 `cards` 是测试对象且 `anki` 是空替身，只证明真实 review 快照被 L24
// 工具读取，不证明真实 Anki 装配、ownership 或 CAS；这些由 L16 合并后的真实 anki 服务用例覆盖。
import chatanki from '../../chatanki/index.ts';
import { afterEach, expect, it } from 'vitest';
import type { AnkiCard, ChatAnkiCardRepository, ToolExecutionContext } from '../../chatanki/api.ts';
import { createTestHost } from '../../../kernel/testing.ts';
import { toWireJson } from '../../../kernel/json.ts';
import review from '../index.ts';
import { mistakesFixture } from './storage.ts';

const fixtures: ReturnType<typeof mistakesFixture>[] = [];
const hosts: Awaited<ReturnType<typeof createTestHost>>[] = [];

async function setup() {
  const fixture = mistakesFixture();
  fixtures.push(fixture);
  const host = await createTestHost({
    plugins: [review, chatanki],
    provide: {
      storage: fixture.storage,
      settings: {},
      llm: {},
      anki: {},
    },
  });
  hosts.push(host);
  return { ...fixture, host };
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});

function insertOwnedCard(
  db: ReturnType<typeof mistakesFixture>['db'],
  documentId: string,
  taskId: string,
  cardId: string,
  sessionId: string,
): void {
  db.run(`INSERT INTO document_tasks (
    id, document_id, original_document_name, segment_index,
    content_segment, status, source_session_id, anki_generation_options_json
  ) VALUES (?1, ?2, 'test.md', 0, 'segment', 'Completed', ?3, '{}')`, [taskId, documentId, sessionId]);
  db.run(`INSERT INTO anki_cards (
    id, task_id, front, back, source_type, source_id
  ) VALUES (?1, ?2, ?3, ?4, 'document', ?5)`, [cardId, taskId, `front-${cardId}`, `back-${cardId}`, documentId]);
}

function executionContext(cards: ChatAnkiCardRepository, sessionId: string): ToolExecutionContext {
  return {
    sessionId,
    messageId: 'message-l24',
    blockId: 'block-l24',
    cards,
    emitToolCallStart: () => undefined,
    emitToolCallEnd: () => undefined,
    emitToolCallError: () => undefined,
    saveToolBlock: () => undefined,
    warn: () => undefined,
  };
}

it('l24_chatanki_get_cards_consumes_the_published_review_scoped_snapshots', async () => {
  const { db, host } = await setup();
  const cardId = 'card-l24-review';
  const sessionId = 'session-l24-review';
  insertOwnedCard(db, 'doc-l24-review', 'task-l24-review', cardId, sessionId);
  const enqueued = host.ctx.review.enqueueCardsForSession([cardId], sessionId, 'doc-l24-review');
  expect(enqueued.enqueued).toBe(1);
  const now = new Date().toISOString();
  const card: AnkiCard = {
    id: cardId,
    task_id: 'task-l24-review',
    front: 'front',
    back: 'back',
    text: null,
    tags: [],
    images: [],
    is_error_card: false,
    error_content: null,
    created_at: now,
    updated_at: now,
    extra_fields: {},
    template_id: null,
  };
  const cards = {
    isDocumentOwnedBySession: (documentId: string, owner: string) =>
      documentId === 'doc-l24-review' && owner === sessionId,
    getCardsForDocumentForSession: (documentId: string, owner: string) =>
      documentId === 'doc-l24-review' && owner === sessionId ? [card] : null,
  } as unknown as ChatAnkiCardRepository;

  const result = await host.ctx.chatankiTools.execute(
    { id: 'call-l24', name: 'chatanki_get_cards', arguments: { documentId: 'doc-l24-review' } },
    executionContext(cards, sessionId),
  );
  expect(result.success).toBe(true);
  const output = result.output as { status: string; cards: Array<Record<string, unknown>> };
  expect(output.status).toBe('ok');
  expect(output.cards).toHaveLength(1);
  const reviewState = output.cards[0]!.reviewState as Record<string, unknown>;
  expect(reviewState.cardStateId).toBe(enqueued.states[0]!.id);
  expect(reviewState.ankiCardId).toBe(cardId);
  expect(reviewState.reviewVersion).toBe(0n);
  expect(toWireJson(reviewState)).toMatchObject({ reviewVersion: 0 });
});
