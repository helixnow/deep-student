import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupMemoryHost, type MemoryHost } from './support.ts';
import type { MemoryServiceImpl } from '../src/service.ts';
import type { MemoryDecisionCompletion, MemoryWriteOutput, SmartWriteOutput } from '../api.ts';
import type { LlmRawPrompt } from '../../llm/api.ts';

let current: MemoryHost | undefined;
afterEach(async () => { vi.restoreAllMocks(); await current?.dispose(); current = undefined; });
function service(host: MemoryHost): MemoryServiceImpl {
  return host.host.ctx.memory as unknown as MemoryServiceImpl;
}

/** Post-write category refresh and semantic dedup share the role; pin fact decisions only. */
const CATEGORY_PROMPT_PREFIX = '你是一个用户画像聚合器';
const isCategoryPrompt = (prompt: string) => prompt.startsWith(CATEGORY_PROMPT_PREFIX);
const isFactPrompt = (prompt: string) => prompt.startsWith('你是一个记忆管理助手');
function factDecisionRole(handler: (prompt: string) => string | Promise<string>) {
  return (prompt: string) => {
    if (isCategoryPrompt(prompt)) return '- 摘要';
    if (prompt.startsWith('你是记忆库的去重审查员')) return '{"action":"keep"}';
    return handler(prompt);
  };
}
function factDecisionCalls(host: MemoryHost) {
  return host.memoryDecision!.calls.filter(call => isFactPrompt(call.prompt));
}

async function seed(host: MemoryHost, title: string, content = '我喜欢图解'): Promise<MemoryWriteOutput> {
  return host.host.invoke('memory_write', { title, content }) as Promise<MemoryWriteOutput>;
}
function hit(host: MemoryHost, note: MemoryWriteOutput): void {
  host.retrieval.responder = request => ({
    capabilitySnapshot: {} as never,
    plan: { queryModality: 'text', topK: request.topK, routes: [], imageFallbackChain: [] },
    result: { hits: [{
      hit: { identity: { resourceId: note.resourceId, chunkIndex: 0, pageIndex: null, timeRange: null },
        embeddingId: '', text: '我喜欢图解', title: null, resourceType: 'note', sourceId: null,
        folderId: null, blobHash: null, imageUrl: null, rawScore: null, metadata: null },
      rrfScore: 1, normalizedScore: null, rerankScore: null, provenance: [],
    }], failures: [] }, queryDerivations: [],
  });
}
async function smart(host: MemoryHost, extra: { idempotencyKey?: string } = {}): Promise<SmartWriteOutput> {
  return host.host.invoke('memory_write_smart', {
    title: '偏好', content: '我偏好思维导图', memoryType: 'fact', ...extra,
  }) as Promise<SmartWriteOutput>;
}

describe('R5-M1 fact write through production commands', () => {
  it('uses internal-dedup retrieval, calls the decision role, and applies UPDATE/APPEND/NONE', async () => {
    let event = 'UPDATE';
    let target = '';
    current = await setupMemoryHost({ memoryDecision: factDecisionRole(() => JSON.stringify({
      event, target_note_id: target, confidence: 0.9, reason: '模型判定',
    })) });
    const original = await seed(current, '旧偏好');
    target = original.noteId;
    hit(current, original);
    for (const nextEvent of ['UPDATE', 'APPEND', 'NONE']) {
      event = nextEvent;
      // A content UPDATE can change the note's resource; retrieval returns the live identity.
      hit(current, { ...original, resourceId: current.db.pluck<string>(
        'SELECT resource_id FROM notes WHERE id=?1', [original.noteId])! });
      const output = await smart(current);
      expect(output.event).toBe(event);
      expect(output.noteId).toBe(original.noteId);
      expect(factDecisionCalls(current).at(-1)!.prompt).toContain(`[ID: ${original.noteId}]`);
    }
    expect(service(current).read(original.noteId)!.content).toBe('我偏好思维导图\n\n我偏好思维导图');
    expect(current.retrieval.requests[0]).toMatchObject({ queryText: '我偏好思维导图', topK: 45 });
    // internal_dedup must never increment _hits or _last_hit.
    expect(service(current).getTags(original.noteId).some(tag => tag.startsWith('_hits:')
      || tag.startsWith('_last_hit:'))).toBe(false);
  });

  it('low confidence returns NONE without mutating, and a foreign target degrades to ADD', async () => {
    let confidence = 0.5;
    let target = '';
    current = await setupMemoryHost({ memoryDecision: () => JSON.stringify({
      event: 'DELETE', target_note_id: target, confidence, reason: '矛盾',
    }) });
    const original = await seed(current, '原记忆');
    target = original.noteId;
    hit(current, original);
    const low = await smart(current);
    expect(low).toMatchObject({ noteId: original.noteId, event: 'NONE', downgraded: true });
    expect(service(current).read(original.noteId)!.content).toBe('我喜欢图解');
    expect(current.db.pluck<number>("SELECT COUNT(*) FROM memory_audit_log WHERE operation='write_smart'"))
      .toBe(0);
    confidence = 0.9;
    target = 'note_outside_candidates';
    const foreign = await smart(current);
    expect(foreign).toMatchObject({ event: 'ADD', reason: '矛盾（target_note_id 不在候选集中，降级为 ADD）' });
    expect(service(current).read(original.noteId)).not.toBeNull();
  });

  it('does not call LLM for no hits, and distinguishes index-not-ready from retrieval failure', async () => {
    current = await setupMemoryHost({ memoryDecision: factDecisionRole(() => { throw new Error('must not call LLM'); }) });
    for (const name of ['A', 'B', 'C']) await seed(current, name);
    const skipped = await service(current).writeSmart(null, '自动偏好', '我偏好表格',
      'fact', null, 'readiness-auto', 'auto_extract');
    expect(skipped).toMatchObject({ event: 'SKIPPED', noteId: '' });
    expect(skipped.reason).toContain('活跃记忆 3 条');
    const explicit = await smart(current);
    expect(explicit.event).toBe('ADD');
    expect(service(current).getTags(explicit.noteId)).toContain('_needs_dedup_review');
    current.retrieval.responder = () => { throw new Error('retrieval offline'); };
    const degraded = await service(current).writeSmart(null, '偏好', '我偏好图解',
      'fact', null, null, 'auto_extract');
    expect(degraded).toMatchObject({ event: 'ADD', confidence: 1 });
    expect(current.warnings.some(message => message.includes('Similar search failed')
      && message.includes('retrieval offline'))).toBe(true);
    expect(factDecisionCalls(current)).toHaveLength(0);
  });

  it('a missing L02 role fails loudly on similar hits and clears the reservation', async () => {
    current = await setupMemoryHost();
    const original = await seed(current, '原记忆');
    hit(current, original);
    await expect(smart(current, { idempotencyKey: 'missing-role' }))
      .rejects.toThrow('L02 service does not expose callMemoryDecisionRawPrompt');
    expect(current.db.pluck<number>(
      "SELECT COUNT(*) FROM memory_write_idempotency WHERE idempotency_key='missing-role'" )).toBe(0);
    expect(current.db.pluck<number>("SELECT COUNT(*) FROM notes WHERE title='偏好'" )).toBe(0);
  });

  it('resolves the decision role from the llm plugin\'s llmRawPrompt service, not the llm manager', async () => {
    const role = {
      callMemoryDecisionRawPrompt: vi.fn(async (prompt: string) => ({ assistant_message: isCategoryPrompt(prompt) ? '- 摘要'
        : JSON.stringify({ event: 'NONE', target_note_id: null, confidence: 0.9, reason: '模型判定' }) }) as never),
    } satisfies Pick<LlmRawPrompt, 'callMemoryDecisionRawPrompt'> & MemoryDecisionCompletion;
    current = await setupMemoryHost({ services: { llm: role } });
    const original = await seed(current, '原记忆');
    hit(current, original);
    await expect(smart(current)).rejects.toThrow('L02 service does not expose callMemoryDecisionRawPrompt');
    expect(role.callMemoryDecisionRawPrompt).not.toHaveBeenCalled();
    await current.dispose();

    current = await setupMemoryHost({ services: { llmRawPrompt: role } });
    hit(current, await seed(current, '原记忆'));
    await expect(smart(current)).resolves.toMatchObject({ event: 'NONE' });
    expect(role.callMemoryDecisionRawPrompt.mock.calls.filter(([prompt]) => isFactPrompt(prompt))).toHaveLength(1);
  });

  it('records actual model failures, opens the process breaker, and recovers after cooldown', async () => {
    let failing = true;
    current = await setupMemoryHost({ memoryDecision: factDecisionRole(() => {
      if (failing) throw new Error('model down');
      return '{"event":"NONE","confidence":1,"reason":"已存在"}';
    }) });
    const original = await seed(current, '原记忆');
    hit(current, original);
    const now = Date.now();
    for (let index = 0; index < 5; index += 1) {
      const output = await smart(current);
      expect(output.event).toBe('ADD');
      expect(output.confidence).toBe(0.6); // command serializer follows Rust's f32 JSON output
      expect(output.reason).toBe('LLM 决策失败（LLM 调用失败: model down），降级为新增');
    }
    const skipped = await service(current).writeSmart(null, '自动', '我偏好图解',
      'fact', null, null, 'auto_extract');
    expect(skipped.event).toBe('SKIPPED');
    expect(factDecisionCalls(current)).toHaveLength(5);
    expect((await smart(current)).reason).toContain('熔断冷却中');
    expect(current.db.pluck<number>(
      "SELECT COUNT(*) FROM memory_audit_log WHERE event='DECISION_UNAVAILABLE'" )).toBe(1);
    failing = false;
    vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60 * 1000);
    expect((await smart(current)).event).toBe('NONE');
    expect(current.db.all<{ event: string }>(
      "SELECT event FROM memory_audit_log WHERE operation='decision_breaker' ORDER BY id"))
      .toEqual([{ event: 'OPEN' }, { event: 'CLOSE' }]);
  });

  it('fences a lease reclaimed during awaited decision before any note mutation', async () => {
    let resolve!: (response: string) => void;
    let entered!: () => void;
    const inDecision = new Promise<void>(done => { entered = done; });
    current = await setupMemoryHost({ memoryDecision: factDecisionRole(() => {
      entered();
      return new Promise<string>(done => { resolve = done; });
    }) });
    hit(current, await seed(current, '原记忆'));
    const pending = smart(current, { idempotencyKey: 'decision-lease' });
    await inDecision;
    current.db.run("UPDATE memory_write_idempotency SET reason='replacement-owner' WHERE idempotency_key='decision-lease'");
    resolve('{"event":"ADD","confidence":1,"reason":"新记忆"}');
    await expect(pending).rejects.toThrow('memory.idempotency.lease_lost');
    expect(current.db.pluck<number>("SELECT COUNT(*) FROM notes WHERE title='偏好'" )).toBe(0);
    expect(current.db.pluck<string>(
      "SELECT reason FROM memory_write_idempotency WHERE idempotency_key='decision-lease'" )).toBe('replacement-owner');
  });
});
