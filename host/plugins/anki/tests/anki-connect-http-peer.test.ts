/**
 * WP-157: production command entry → real fetch / net probe → deterministic AnkiConnect
 * peer on the hard-coded 127.0.0.1:8765. No global fetch or net stubs in this file.
 *
 * Expected strings are the Rust Display of each branch (reqwest 0.11.27 / hyper 0.14.32,
 * `anki_connect_service.rs` + `cmd/anki_connect.rs:180-410`). The port is production's
 * fixed address, so this file needs 8765 to be free; it never stops another listener.
 */
import net from 'node:net';
import { constants } from 'node:os';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnkiCard } from '../../../../contracts/ipc/generated/_shared.ts';
import { startAnkiConnectPeer, type AnkiConnectPeer } from './anki-connect-peer.ts';
import { createAnkiTestEnv, type AnkiTestEnv } from './env.ts';

// Rust io::Error Display prints the host's raw errno (Linux 111, macOS 61).
const ECONNREFUSED = constants.errno.ECONNREFUSED;
let peer: AnkiConnectPeer;
let env: AnkiTestEnv;

beforeAll(async () => {
  try {
    peer = await startAnkiConnectPeer();
  } catch (error) {
    throw new Error(
      `127.0.0.1:8765 is not available for the deterministic AnkiConnect peer (${(error as Error).message}). `
      + 'Production hard-codes this address; run this file where no Anki/AnkiConnect or other listener owns the port.',
    );
  }
  env = await createAnkiTestEnv();
}, 120_000);

afterAll(async () => {
  await env?.dispose();
  await peer?.stop();
});

beforeEach(() => {
  peer.reset();
  vi.restoreAllMocks();
});

const VERSION_BODY = '{"action":"version","version":6}';
const posts = () => peer.requests.filter((request) => request.method === 'POST');
const actions = () => peer.requests.map((request) => request.action);

function card(overrides: Partial<AnkiCard> = {}): AnkiCard {
  return {
    front: 'Q1',
    back: 'A1',
    text: null,
    tags: [],
    images: [],
    id: 'w157-card-1',
    task_id: 'w157-task-1',
    is_error_card: false,
    error_content: null,
    created_at: '2026-01-01T00:00:00+00:00',
    updated_at: '2026-01-01T00:00:00+00:00',
    extra_fields: {},
    template_id: null,
    ...overrides,
  };
}

function validation(message: string) {
  return { error_type: 'Validation', message };
}

describe('peer lifecycle', () => {
  it('start / reset / stop: records raw requests, reset clears them, stop releases 8765', async () => {
    const response = await fetch(peer.url, { method: 'POST', body: VERSION_BODY });
    expect(await response.text()).toBe('{"result":6,"error":null}');
    expect(peer.requests).toMatchObject([{ seq: 0, method: 'POST', path: '/', body: VERSION_BODY, action: 'version' }]);
    peer.reset({ version: 5 });
    expect(peer.requests).toEqual([]);
    expect(peer.connections).toBe(0);

    const second = await startAnkiConnectPeer({ port: 0 });
    await second.stop();
    const refused = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      const socket = net.connect({ host: second.host, port: second.port });
      socket.once('connect', () => { socket.destroy(); resolve(null); });
      socket.once('error', resolve);
    });
    expect(refused?.code).toBe('ECONNREFUSED');
    await expect(startAnkiConnectPeer()).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });
});

describe('check_anki_connect_status (cmd/anki_connect.rs:180 → anki_connect_service.rs:308)', () => {
  it('success: port probe, GET probe, then POST version v6 → true', async () => {
    await expect(env.host.invoke('check_anki_connect_status')).resolves.toBe(true);
    expect(actions()).toEqual(['GET', 'version']);
    expect(posts()[0]).toMatchObject({ path: '/', body: VERSION_BODY });
    expect(posts()[0]!.headers['content-type']).toBe('application/json');
    expect(peer.connections).toBeGreaterThanOrEqual(2);
  });

  it('version rejection: v5 < MIN_VERSION 6', async () => {
    peer.reset({ version: 5 });
    await expect(env.host.invoke('check_anki_connect_status')).rejects.toMatchObject(validation(
      'AnkiConnect 插件版本过旧（API v5，需要 ≥ v6）。请在 Anki 中更新 AnkiConnect 插件（代码：2055492159）后重试',
    ));
  });

  it('non-u64 version result: warn and pass', async () => {
    peer.reset({ version: 'six' });
    const warn = vi.spyOn(env.host.ctx.logger, 'warn');
    await expect(env.host.invoke('check_anki_connect_status')).resolves.toBe(true);
    expect(warn).toHaveBeenCalledWith('⚠️ AnkiConnect version 返回非数字结果，跳过版本协商: Some(String("six"))');
  });

  it('remote error envelope', async () => {
    peer.reset({ faults: { version: { kind: 'reply', body: '{"result":null,"error":"boom"}' } } });
    await expect(env.host.invoke('check_anki_connect_status')).rejects.toMatchObject(validation('AnkiConnect错误: boom'));
  });

  it('bad response body: serde_json::from_str error + raw text', async () => {
    peer.reset({ faults: { version: { kind: 'reply', body: 'not json' } } });
    await expect(env.host.invoke('check_anki_connect_status')).rejects.toMatchObject(validation(
      '解析AnkiConnect响应失败: expected ident at line 1 column 2 - 响应内容: not json',
    ));
  });

  it('HTTP 500: status Display + body', async () => {
    peer.reset({ faults: { version: { kind: 'reply', status: 500, body: 'oops', contentType: 'text/plain' } } });
    await expect(env.host.invoke('check_anki_connect_status')).rejects.toMatchObject(validation(
      'AnkiConnect HTTP错误: 500 Internal Server Error - 内容: oops',
    ));
  });

  it('peer stopped: TcpStream probe refused before any HTTP', async () => {
    const offline = await startAnkiConnectPeer({ port: 0 });
    await offline.stop();
    await peer.stop();
    try {
      const warn = vi.spyOn(env.host.ctx.logger, 'warn');
      await expect(env.host.invoke('check_anki_connect_status')).rejects.toMatchObject({
        error_type: 'Validation',
        message: expect.stringMatching(new RegExp(`^端口8765无法访问: Connection refused \\(os error ${ECONNREFUSED}\\) \\n\\n这通常意味着：`)),
      });
      expect(warn).toHaveBeenCalledWith(`❌ 端口8765无法访问: Connection refused (os error ${ECONNREFUSED})`);
    } finally {
      peer = await startAnkiConnectPeer();
    }
  });
});

describe('get_anki_deck_names / anki_get_deck_names (cmd/anki_connect.rs:189,198 → service:439)', () => {
  it.each(['get_anki_deck_names', 'anki_get_deck_names'])('%s success: deckNames v6 without params', async (command) => {
    peer.reset({ decks: ['Default', 'W157::Sub'] });
    await expect(env.host.invoke(command)).resolves.toEqual(['Default', 'W157::Sub']);
    expect(peer.requests).toHaveLength(1);
    expect(peer.requests[0]).toMatchObject({ method: 'POST', body: '{"action":"deckNames","version":6}' });
  });

  it('empty deck list is success', async () => {
    peer.reset({ decks: [] });
    await expect(env.host.invoke('get_anki_deck_names')).resolves.toEqual([]);
  });

  it.each([
    ['remote error', { kind: 'reply', body: '{"result":null,"error":"collection is not available"}' }, 'AnkiConnect错误: collection is not available'],
    ['result null', { kind: 'reply', body: '{"result":null,"error":null}' }, 'AnkiConnect返回空结果'],
    ['result not string list', { kind: 'reply', body: '{"result":[1],"error":null}' }, '解析牌组列表失败: invalid type: integer `1`, expected a string'],
    ['bad JSON', { kind: 'reply', body: '{"result":' }, '解析AnkiConnect响应失败: error decoding response body: EOF while parsing a value at line 1 column 10'],
    ['HTTP 503 (body not read)', { kind: 'reply', status: 503, body: 'down' }, 'AnkiConnect HTTP错误: 503 Service Unavailable'],
  ] as const)('%s', async (_name, fault, message) => {
    peer.reset({ faults: { deckNames: fault } });
    await expect(env.host.invoke('get_anki_deck_names')).rejects.toMatchObject(validation(message));
  });

  // Disconnect branches: only the Rust-equal parts are asserted (Validation, Rust's own
  // prefix, the request reached the peer). The reqwest/hyper source text after the prefix
  // differs in TS (undici `fetch failed` / `other side closed`); see equivalence/README.md
  // "WP-157 正式失败" D1-D3. Not normalized away here, not asserted as TS text either.
  it('disconnect before headers: send() error under 请求牌组列表失败', async () => {
    peer.reset({ faults: { deckNames: { kind: 'disconnect', at: 'before-headers' } } });
    await expect(env.host.invoke('get_anki_deck_names')).rejects.toMatchObject({
      error_type: 'Validation', message: expect.stringMatching(/^请求牌组列表失败: /),
    });
    expect(actions()).toEqual(['deckNames']);
  });

  it('disconnect mid-body: body-read error under 解析AnkiConnect响应失败', async () => {
    peer.reset({ faults: { deckNames: { kind: 'disconnect', at: 'mid-body' } } });
    await expect(env.host.invoke('get_anki_deck_names')).rejects.toMatchObject({
      error_type: 'Validation', message: expect.stringMatching(/^解析AnkiConnect响应失败: request or response body error: /),
    });
  });
});

describe('get_anki_model_names (cmd/anki_connect.rs:204 → service:481)', () => {
  it('success: modelNames v6', async () => {
    await expect(env.host.invoke('get_anki_model_names')).resolves.toEqual(['Basic', 'Cloze']);
    expect(peer.requests[0]).toMatchObject({ body: '{"action":"modelNames","version":6}' });
  });

  it.each([
    ['remote error', { kind: 'reply', body: '{"result":null,"error":"boom"}' }, 'AnkiConnect错误: boom'],
    ['result object', { kind: 'reply', body: '{"result":{},"error":null}' }, '解析笔记类型列表失败: invalid type: map, expected a sequence'],
    ['HTTP 404', { kind: 'reply', status: 404, body: '' }, 'AnkiConnect HTTP错误: 404 Not Found'],
  ] as const)('%s', async (_name, fault, message) => {
    peer.reset({ faults: { modelNames: fault } });
    await expect(env.host.invoke('get_anki_model_names')).rejects.toMatchObject(validation(message));
  });
});

describe('create_anki_deck (cmd/anki_connect.rs:213 → service:1590)', () => {
  it('success: createDeck {deck} then the deck is listed', async () => {
    await expect(env.host.invoke('create_anki_deck', { deckName: 'W157::新牌组' })).resolves.toBeNull();
    expect(peer.requests[0]).toMatchObject({ body: '{"action":"createDeck","version":6,"params":{"deck":"W157::新牌组"}}' });
    await expect(env.host.invoke('get_anki_deck_names')).resolves.toEqual(['Default', 'W157::新牌组']);
  });

  it('empty deck name is forwarded unchanged (no command-side validation)', async () => {
    await expect(env.host.invoke('create_anki_deck', { deckName: '' })).resolves.toBeNull();
    expect(peer.requests[0]!.body).toBe('{"action":"createDeck","version":6,"params":{"deck":""}}');
  });

  it('"already exists" remote error is success', async () => {
    peer.reset({ faults: { createDeck: { kind: 'reply', body: '{"result":null,"error":"deck already exists"}' } } });
    await expect(env.host.invoke('create_anki_deck', { deckName: 'Default' })).resolves.toBeNull();
  });

  it.each([
    ['other remote error', { kind: 'reply', body: '{"result":null,"error":"bad name"}' }, '创建牌组时出错: bad name'],
    ['HTTP 500', { kind: 'reply', status: 500, body: '' }, 'AnkiConnect HTTP错误: 500 Internal Server Error'],
    ['bad JSON', { kind: 'reply', body: 'not json' }, '解析AnkiConnect响应失败: error decoding response body: expected ident at line 1 column 2'],
  ] as const)('%s', async (_name, fault, message) => {
    peer.reset({ faults: { createDeck: fault } });
    await expect(env.host.invoke('create_anki_deck', { deckName: 'X' })).rejects.toMatchObject(validation(message));
  });
});

describe('add_cards_to_anki_connect (cmd/anki_connect.rs:226 → service add_notes_to_anki_detailed)', () => {
  it('input validation fails before any connection', async () => {
    await expect(env.host.invoke('add_cards_to_anki_connect', { selectedCards: [], deckName: 'D', noteType: 'Basic' }))
      .rejects.toMatchObject(validation('没有选择任何卡片'));
    await expect(env.host.invoke('add_cards_to_anki_connect', { selectedCards: [card()], deckName: ' ', noteType: 'Basic' }))
      .rejects.toMatchObject(validation('牌组名称不能为空'));
    await expect(env.host.invoke('add_cards_to_anki_connect', { selectedCards: [card()], deckName: 'D', noteType: '' }))
      .rejects.toMatchObject(validation('笔记类型不能为空'));
    expect(peer.connections).toBe(0);
  });

  it('success: createDeck → probe → version → modelFieldNames → canAddNotes → addNotes', async () => {
    const report = await env.host.invoke('add_cards_to_anki_connect', {
      selectedCards: [card(), card({ id: 'w157-card-2', front: 'Q2', back: 'A2' })],
      deckName: 'W157',
      noteType: 'Basic',
    });
    expect(report).toEqual({ noteIds: [1_700_000_000_001, 1_700_000_000_002], added: 2, duplicates: 0, failed: 0, createdModels: [] });
    expect(actions()).toEqual(['createDeck', 'GET', 'version', 'modelFieldNames', 'canAddNotes', 'addNotes']);
    const addNotes = JSON.parse(posts().at(-1)!.body) as { params: { notes: unknown[] } };
    expect(addNotes.params.notes).toEqual([
      { deckName: 'W157', modelName: 'Basic', fields: { Front: 'Q1', Back: 'A1' }, tags: [] },
      { deckName: 'W157', modelName: 'Basic', fields: { Front: 'Q2', Back: 'A2' }, tags: [] },
    ]);
  });

  it('all duplicates: idempotent Ok with duplicates count', async () => {
    peer.reset({ existingNotes: ['Basic\u0000Q1'] });
    await expect(env.host.invoke('add_cards_to_anki_connect', { selectedCards: [card()], deckName: 'Default', noteType: 'Basic' }))
      .resolves.toEqual({ noteIds: [null], added: 0, duplicates: 1, failed: 0, createdModels: [] });
    expect(actions()).not.toContain('addNotes');
  });

  it('all cloze cards force note type Cloze', async () => {
    await env.host.invoke('add_cards_to_anki_connect', {
      selectedCards: [card({ front: '{{c1::x}}', back: '' })], deckName: 'Default', noteType: 'Basic',
    });
    expect(JSON.parse(posts().find((request) => request.action === 'modelFieldNames')!.body))
      .toEqual({ action: 'modelFieldNames', version: 6, params: { modelName: 'Cloze' } });
  });

  it('availability failure aborts after version (validation error, no notes sent)', async () => {
    peer.reset({ version: 5 });
    await expect(env.host.invoke('add_cards_to_anki_connect', { selectedCards: [card()], deckName: 'Default', noteType: 'Basic' }))
      .rejects.toMatchObject(validation(
        'AnkiConnect 插件版本过旧（API v5，需要 ≥ v6）。请在 Anki 中更新 AnkiConnect 插件（代码：2055492159）后重试',
      ));
    expect(actions()).toEqual(['createDeck', 'GET', 'version']);
  });

  it('createDeck failure is only logged; sync continues', async () => {
    peer.reset({ faults: { createDeck: { kind: 'reply', body: '{"result":null,"error":"bad"}' } } });
    await expect(env.host.invoke('add_cards_to_anki_connect', { selectedCards: [card()], deckName: 'Default', noteType: 'Basic' }))
      .resolves.toMatchObject({ added: 1 });
  });

  it('canAddNotes remote error → per-note addNote fallback with warning', async () => {
    peer.reset({ faults: { canAddNotes: { kind: 'reply', body: '{"result":null,"error":"nope"}' } } });
    await expect(env.host.invoke('add_cards_to_anki_connect', { selectedCards: [card()], deckName: 'Default', noteType: 'Basic' }))
      .resolves.toEqual({
        noteIds: [1_700_000_000_001], added: 1, duplicates: 0, failed: 0, createdModels: [],
        warnings: ['canAddNotes 预检不可用，已降级为逐条 addNote: AnkiConnect错误(canAddNotes): nope'],
      });
    expect(actions()).toEqual(['createDeck', 'GET', 'version', 'modelFieldNames', 'canAddNotes', 'addNote']);
  });

  it('addNotes remote error (no retry) → all failed → Err', async () => {
    peer.reset({ faults: { addNotes: { kind: 'reply', body: '{"result":null,"error":"locked"}' } } });
    await expect(env.host.invoke('add_cards_to_anki_connect', { selectedCards: [card()], deckName: 'Default', noteType: 'Basic' }))
      .rejects.toMatchObject(validation('所有卡片同步失败。请检查 Anki 中是否存在对应笔记类型、卡片字段是否为空'));
    expect(actions().filter((action) => action === 'addNotes')).toHaveLength(1);
  });

  it('addNotes HTTP 500 is retried once (default retry_times 1) then reported', async () => {
    peer.reset({ faults: { addNotes: { kind: 'reply', status: 500, body: '' } } });
    await expect(env.host.invoke('add_cards_to_anki_connect', { selectedCards: [card()], deckName: 'Default', noteType: 'Basic' }))
      .rejects.toMatchObject(validation('所有卡片同步失败。请检查 Anki 中是否存在对应笔记类型、卡片字段是否为空'));
    expect(actions().filter((action) => action === 'addNotes')).toHaveLength(2);
  });

  it('addNotes disconnect before headers is a retryable send() error (2 attempts)', async () => {
    peer.reset({ faults: { addNotes: { kind: 'disconnect', at: 'before-headers' } } });
    await expect(env.host.invoke('add_cards_to_anki_connect', { selectedCards: [card()], deckName: 'Default', noteType: 'Basic' }))
      .rejects.toMatchObject(validation('所有卡片同步失败。请检查 Anki 中是否存在对应笔记类型、卡片字段是否为空'));
    expect(actions().filter((action) => action === 'addNotes')).toHaveLength(2);
  });
});
