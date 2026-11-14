/**
 * Semantic dedup pass — orchestration half of `dstu-memory/src/memory/semantic_dedup.rs`
 * (`run_throttled`, `run_dedup_pass`, `process_candidate`, backlog/sample selection,
 * tag maintenance and the SEMANTIC_MERGE audit). The pure helpers are covered in
 * `evolution-profile.test.ts` against the Rust unit tests.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MemorySearchResult } from '../api.ts';
import type { MemoryServiceImpl } from '../src/service.ts';
import {
  buildDedupPrompt, createSemanticDedupHost, processCandidate, runSemanticDedupPass,
  runSemanticDedupThrottled, SemanticDedupThrottle, type SemanticDedupHost,
} from '../src/semantic-dedup.ts';
import { queryAuditLogs } from '../repository/audit.ts';
import { setupMemoryHost, type MemoryHost } from './support.ts';

let current: MemoryHost | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await current?.dispose();
  current = undefined;
});

const DEDUP_PROMPT_PREFIX = '你是记忆库的去重审查员';
const REVIEW = '_needs_dedup_review';

async function fixture(decide?: (prompt: string, signal?: AbortSignal) => string | Promise<string>) {
  current = await setupMemoryHost(decide === undefined ? {} : { memoryDecision: decide });
  await current.host.invoke('memory_get_or_create_root_folder', {});
  const service = current.host.ctx.memory as unknown as MemoryServiceImpl;
  const mh = current;
  // `write` refuses reserved `__` titles, so the title is set with the tags.
  const note = (title: string, content: string, tags: readonly string[]): string => {
    const written = service.write(null, 'placeholder', content, 'create');
    mh.db.run('UPDATE notes SET tags = ?1, title = ?2 WHERE id = ?3', [JSON.stringify(tags), title, written.noteId]);
    return written.noteId;
  };
  const tagsOf = (id: string): string[] =>
    JSON.parse(mh.db.pluck<string>('SELECT tags FROM notes WHERE id = ?1', [id]) ?? 'null') as string[];
  const deletedAt = (id: string): string | null =>
    mh.db.pluck<string | null>('SELECT deleted_at FROM notes WHERE id = ?1', [id]) ?? null;
  const host = (overrides: Partial<SemanticDedupHost> = {}): SemanticDedupHost =>
    ({ ...createSemanticDedupHost(service), ...overrides });
  return { mh, service, note, tagsOf, deletedAt, host };
}

function hit(noteId: string, score: number): MemorySearchResult {
  return { noteId, noteTitle: '', folderPath: '', chunkText: '', score, updatedAt: null };
}

const mergeReply = (keepId: string, content: string) =>
  `\`\`\`json\n${JSON.stringify({ action: 'merge', keep_note_id: keepId, merged_content: content })}\n\`\`\``;

describe('process_candidate (semantic_dedup.rs:246-430)', () => {
  it('merges into the keeper the model picks: keeper content updated, duplicate deleted, _hits/_used max, _important kept, audit written', async () => {
    const prompts: string[] = [];
    const f = await fixture(prompt => { prompts.push(prompt); return mergeReply(b, '  二次函数配方法掌握不牢，符号常出错  '); });
    const a = f.note('数学二次函数薄弱', '二次函数配方时符号常出错', ['_type:fact', REVIEW, '_hits:2', '_used:4']);
    const b = f.note('配方法掌握不牢', '配方法掌握不牢', ['_type:fact', '_hits:5', 'user', '_important']);
    const host = f.host({ searchForPurpose: async (query, topK, purpose) => {
      expect([query, topK, purpose]).toEqual(['二次函数配方时符号常出错', 5, 'internal_dedup']);
      return [hit(a, 1), hit(b, 0.9)];
    } });

    expect(await processCandidate(host, a, 0.35)).toEqual(['merged', true]);

    expect(prompts).toEqual([buildDedupPrompt(
      { id: a, title: '数学二次函数薄弱' }, '二次函数配方时符号常出错',
      { id: b, title: '配方法掌握不牢' }, '配方法掌握不牢', 200)]);
    expect(f.deletedAt(a)).not.toBeNull();
    expect(f.service.read(b)?.content).toBe('二次函数配方法掌握不牢，符号常出错');
    expect(f.tagsOf(b)).toEqual(['_type:fact', 'user', '_hits:5', '_used:4', '_important']);
    const audit = queryAuditLogs(f.mh.db, 10, 0, 'semantic_dedup', null, null);
    expect(audit.map(row => [row.operation, row.noteId, row.event, row.success])).toEqual([
      ['semantic_merge', b, 'SEMANTIC_MERGE', true],
      ['delete', a, 'DELETE', true],
      ['update', b, 'UPDATE', true],
    ]);
    expect(audit[0]).toMatchObject({
      title: '配方法掌握不牢', contentPreview: '二次函数配方法掌握不牢，符号常出错',
      reason: '语义合并：保留「配方法掌握不牢」，删除重复记忆「数学二次函数薄弱」',
      folder: null, confidence: null, sessionId: null, durationMs: null,
    });
    expect(f.mh.db.pluck<string>("SELECT extra_json FROM memory_audit_log WHERE operation = 'semantic_merge'"))
      .toBe(JSON.stringify({ deletedNoteId: a, deletedTitle: '数学二次函数薄弱' }));
    expect(f.mh.infos).toContain(`[SemanticDedup] Merged duplicate: kept '配方法掌握不牢' (${b}), deleted '数学二次函数薄弱' (${a})`);
  });

  it('keeping the reviewed note folds the other note into it and clears its review tag', async () => {
    const f = await fixture(() => mergeReply(a, '合并后'));
    const a = f.note('A', '内容A', [REVIEW, '_hits:1']);
    const b = f.note('B', '内容B', ['_hits:3', '_used:2']);
    const host = f.host({ searchForPurpose: async () => [hit(b, 0.5)] });
    expect(await processCandidate(host, a, 0.35)).toEqual(['merged', true]);
    expect(f.deletedAt(b)).not.toBeNull();
    expect(f.tagsOf(a)).toEqual(['_hits:3', '_used:2']);
  });

  it('a keep decision or a merge the guards reject is reviewed: tag removed, both notes stay (:362-369)', async () => {
    let reply = '{"action": "keep"}';
    const f = await fixture(() => reply);
    const b = f.note('B', '内容B', ['_type:fact']);
    // Rust skips only `hit.score < min_score`: a hit exactly at the f32 threshold is a candidate.
    const minScore = Math.fround(0.35);
    const host = f.host({ searchForPurpose: async () => [hit(b, minScore)] });
    for (const next of [
      '分析：两条各有价值。\n{"action": "keep"}',
      JSON.stringify({ action: 'merge', keep_note_id: 'n999', merged_content: '内容' }),
      JSON.stringify({ action: 'MERGE', keep_note_id: b, merged_content: '长'.repeat(201) }),
      JSON.stringify({ action: 'merge', keep_note_id: b, merged_content: ' \n ' }),
    ]) {
      reply = next;
      const a = f.note('A', '内容A', ['_type:fact', REVIEW]);
      expect(await processCandidate(host, a, minScore)).toEqual(['kept', true]);
      expect(f.tagsOf(a)).toEqual(['_type:fact']);
      expect(f.deletedAt(a)).toBeNull();
    }
    expect(f.deletedAt(b)).toBeNull();
    expect(queryAuditLogs(f.mh.db, 10, 0, 'semantic_dedup', null, null)).toEqual([]);
  });

  it('without an eligible similar note the review completes without a model call (:297-330)', async () => {
    const prompts: string[] = [];
    const f = await fixture(prompt => { prompts.push(prompt); return '{"action":"keep"}'; });
    const a = f.note('A', '内容A', ['_type:fact', REVIEW, 'keep-me']);
    const low = f.note('低分', '内容', ['_type:fact']);
    const study = f.note('学习', '内容', ['_type:study']);
    const archived = f.note('归档', '内容', ['_type:fact', '_archived']);
    const blank = f.note('空白', '\u3000 \n', ['_type:fact']);
    const system = f.note('__sys__', '内容', ['_type:fact']);
    const host = f.host({ searchForPurpose: async () => [
      hit(a, 1), hit(low, Math.fround(0.34)), hit(study, 0.9), hit(archived, 0.9),
      hit(blank, 0.9), hit(system, 0.9), hit('note_missing', 0.9),
    ] });
    expect(await processCandidate(host, a, Math.fround(0.35))).toEqual(['kept', false]);
    expect(prompts).toEqual([]);
    expect(f.tagsOf(a)).toEqual(['_type:fact', 'keep-me']);
  });

  it('archived and blank candidates are reviewed without a search; U+FEFF is not blank for Rust trim (:269-279)', async () => {
    const f = await fixture();
    const searched: string[] = [];
    const archived = f.note('归档', '内容', [REVIEW, '_archived']);
    const blank = f.note('空白', '\u3000\t\n', [REVIEW]);
    const bom = f.note('BOM', '历史内容', [REVIEW]);
    const base = f.host();
    const host = f.host({
      // Current writes reject invisible Unicode; simulate content read from an older note.
      read: id => { const value = base.read(id); return id === bom && value ? { ...value, content: '\uFEFF' } : value; },
      searchForPurpose: async query => { searched.push(query); return []; },
    });
    expect(await processCandidate(host, archived, 0.35)).toEqual(['kept', false]);
    expect(await processCandidate(host, blank, 0.35)).toEqual(['kept', false]);
    expect(searched).toEqual([]);
    expect(await processCandidate(host, bom, 0.35)).toEqual(['kept', false]);
    expect(searched).toEqual(['\uFEFF']);
    for (const id of [archived, blank, bom]) expect(f.tagsOf(id)).not.toContain(REVIEW);
  });

  it('system notes, unreadable candidates and failed searches are skipped with the review tag kept (:253-295, :316-322)', async () => {
    const f = await fixture(() => '{"action":"keep"}');
    const system = f.note('__daily_log_2026-07-01__', '内容', [REVIEW]);
    const a = f.note('A', '内容A', [REVIEW]);
    const b = f.note('B', '内容B', []);
    const base = f.host();

    expect(await processCandidate(f.host({ searchForPurpose: async () => { throw new Error('should not search'); } }), system, 0.35))
      .toEqual(['skipped', false]);
    expect(f.tagsOf(system)).toEqual([REVIEW]);
    expect(await processCandidate(base, 'note_missing', 0.35)).toEqual(['skipped', false]);

    const broken = f.host({ read: () => { throw new Error('database is locked'); } });
    expect(await processCandidate(broken, a, 0.35)).toEqual(['skipped', false]);
    expect(f.mh.warnings).toContain(`[SemanticDedup] Failed to read candidate ${a}: database is locked`);

    const noSearch = f.host({ searchForPurpose: async () => { throw new Error('retrieval down'); } });
    expect(await processCandidate(noSearch, a, 0.35)).toEqual(['skipped', false]);
    expect(f.mh.warnings).toContain(`[SemanticDedup] Similar search failed for ${a}: retrieval down`);
    expect(f.tagsOf(a)).toEqual([REVIEW]);

    const flaky = f.host({
      read: id => { if (id === 'note_flaky') throw new Error('io'); return base.read(id); },
      searchForPurpose: async () => [hit('note_flaky', 0.9), hit(b, 0.8)],
    });
    expect(await processCandidate(flaky, a, 0.35)).toEqual(['kept', true]);
    expect(f.mh.warnings).toContain('[SemanticDedup] Failed to read similar note note_flaky: io');
  });

  it('model failures, missing provider and unparsable replies are llm_failed and keep the tag (:332-360)', async () => {
    let fail: (() => string) = () => { throw new Error('model down'); };
    const f = await fixture(() => fail());
    const a = f.note('A', '内容A', [REVIEW]);
    const b = f.note('B', '内容B', []);
    const host = f.host({ searchForPurpose: async () => [hit(b, 0.9)] });

    expect(await processCandidate(host, a, 0.35)).toEqual(['llm_failed', true]);
    expect(f.mh.warnings).toContain(`[SemanticDedup] LLM call failed for ${a}: model down`);

    const noProvider = f.host({
      searchForPurpose: async () => [hit(b, 0.9)],
      completion: () => { throw new Error('L02 service does not expose callMemoryDecisionRawPrompt'); },
    });
    expect(await processCandidate(noProvider, a, 0.35)).toEqual(['llm_failed', true]);
    expect(f.mh.warnings).toContain(`[SemanticDedup] LLM call failed for ${a}: L02 service does not expose callMemoryDecisionRawPrompt`);

    fail = () => '没有 JSON';
    expect(await processCandidate(host, a, 0.35)).toEqual(['llm_failed', true]);
    fail = () => '{"action": "delete"}';
    expect(await processCandidate(host, a, 0.35)).toEqual(['llm_failed', true]);
    expect(f.mh.warnings.filter(w => w === `[SemanticDedup] Failed to parse LLM response for ${a}`)).toHaveLength(2);
    expect(f.tagsOf(a)).toEqual([REVIEW]);
  });

  it('a model call still pending after 60 s times out, aborts the request and is llm_failed (:335-352)', async () => {
    let seen: AbortSignal | undefined;
    const f = await fixture((_prompt, signal) => { seen = signal; return new Promise<string>(() => undefined); });
    const a = f.note('A', '内容A', [REVIEW]);
    const b = f.note('B', '内容B', []);
    const host = f.host({ searchForPurpose: async () => [hit(b, 0.9)] });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let settled = false;
    const pending = processCandidate(host, a, 0.35);
    void pending.then(() => { settled = true; });
    for (let i = 0; i < 50 && seen === undefined; i += 1) await Promise.resolve();
    expect(seen?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(settled).toBe(false);
    expect(seen?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual(['llm_failed', true]);
    expect(seen?.aborted).toBe(true);
    expect(f.mh.warnings).toContain(`[SemanticDedup] LLM call timed out (60s) for ${a}`);
    expect(f.tagsOf(a)).toEqual([REVIEW]);
  });

  it('an update failure skips before deleting; a delete failure audits success=false and leaves the tags (:385-419)', async () => {
    const f = await fixture(() => mergeReply(b, '合并后'));
    const a = f.note('A', '内容A', [REVIEW, '_hits:9']);
    const b = f.note('B', '内容B', ['_hits:1']);
    const search = async () => [hit(b, 0.9)];

    const noUpdate = f.host({ searchForPurpose: search, updateById: () => { throw new Error('Note was modified'); } });
    expect(await processCandidate(noUpdate, a, 0.35)).toEqual(['skipped', true]);
    expect(f.mh.warnings).toContain(`[SemanticDedup] Failed to update keeper ${b} with merged content: Note was modified`);
    expect(f.deletedAt(a)).toBeNull();
    expect(queryAuditLogs(f.mh.db, 10, 0, null, 'semantic_merge', null)).toEqual([]);

    const noDelete = f.host({ searchForPurpose: search, delete: async () => { throw new Error('database is locked'); } });
    expect(await processCandidate(noDelete, a, 0.35)).toEqual(['skipped', true]);
    expect(f.mh.warnings).toContain(`[SemanticDedup] Merged content written but failed to delete duplicate ${a}: database is locked`);
    expect(f.service.read(b)?.content).toBe('合并后');
    expect(f.deletedAt(a)).toBeNull();
    expect(f.tagsOf(a)).toEqual([REVIEW, '_hits:9']);
    expect(f.tagsOf(b)).toEqual(['_hits:1']);
    const [merge] = queryAuditLogs(f.mh.db, 10, 0, null, 'semantic_merge', null);
    expect(merge).toMatchObject({
      source: 'semantic_dedup', success: false, noteId: b, title: 'B', event: 'SEMANTIC_MERGE',
      reason: '语义合并未完成：保留「B」内容已更新，但删除「A」失败：database is locked',
    });
  });

  it('trims model output like Rust without stripping invisible characters past the write validation', async () => {
    let merged = '\uFEFF合并后';
    const f = await fixture(() => mergeReply(b, merged));
    const a = f.note('A', '内容A', [REVIEW]);
    const b = f.note('B', '内容B', []);
    const host = f.host({ searchForPurpose: async () => [hit(b, 0.9)] });
    expect(await processCandidate(host, a, 0.35)).toEqual(['skipped', true]);
    expect(f.deletedAt(a)).toBeNull();
    expect(f.tagsOf(a)).toEqual([REVIEW]);
    expect(f.service.read(b)?.content).toBe('内容B');

    merged = '\u0085合并后\u0085';
    expect(await processCandidate(host, a, 0.35)).toEqual(['merged', true]);
    expect(f.service.read(b)?.content).toBe('合并后');
    expect(f.deletedAt(a)).not.toBeNull();
  });

  it('tag-only review preserves updated_at and a failed tag rewrite remains retryable', async () => {
    const f = await fixture();
    const a = f.note('A', '内容A', [REVIEW, 'user']);
    const before = f.service.read(a)?.updatedAt;
    const base = f.host();
    const broken = f.host({
      searchForPurpose: async () => [],
      deps: { ...base.deps, notes: { ...base.deps.notes,
        rewriteTagsWithoutTouchingUpdatedAtWithConn: () => { throw new Error('database is locked'); },
      } },
    });
    expect(await processCandidate(broken, a, 0.35)).toEqual(['kept', false]);
    expect(f.tagsOf(a)).toEqual([REVIEW, 'user']);
    expect(f.mh.warnings).toContain(`[SemanticDedup] Failed to remove review tag from ${a}: database is locked`);
    expect(await processCandidate(f.host({ searchForPurpose: async () => [] }), a, 0.35)).toEqual(['kept', false]);
    expect(f.tagsOf(a)).toEqual(['user']);
    expect(f.service.read(a)?.updatedAt).toBe(before);
  });

  it('the service adapter excludes deleted and out-of-root notes before search or model calls', async () => {
    const f = await fixture();
    const deleted = f.note('已删除', '内容', [REVIEW]);
    const outside = f.note('根外', '内容', [REVIEW]);
    await f.service.delete(deleted);
    f.mh.db.run('DELETE FROM folder_items WHERE item_id = ?1', [outside]);
    const search = vi.fn(async () => []);
    const host = f.host({ searchForPurpose: search });
    expect(await processCandidate(host, deleted, 0.35)).toEqual(['skipped', false]);
    expect(await processCandidate(host, outside, 0.35)).toEqual(['skipped', false]);
    expect(search).not.toHaveBeenCalled();
    expect(f.tagsOf(outside)).toEqual([REVIEW]);
  });
});

describe('run_dedup_pass (semantic_dedup.rs:162-242, 437-460)', () => {
  it('reviews the oldest _needs_dedup_review backlog first, ten per round', async () => {
    const f = await fixture();
    const ids: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const id = f.note(`积压 ${i}`, `内容 ${i}`, [REVIEW]);
      f.mh.db.run('UPDATE notes SET updated_at = ?1 WHERE id = ?2', [`2026-07-${String(20 - i).padStart(2, '0')}T00:00:00.000Z`, id]);
      ids.push(id);
    }
    const fresh = f.note('不在积压', '内容', []);
    const read: string[] = [];
    const base = f.host();
    const host = f.host({ read: id => { read.push(id); return base.read(id); }, searchForPurpose: async () => [] });
    expect(await runSemanticDedupPass(host)).toEqual({ reviewed: 10, merged: 0, llm_calls: 0 });
    expect(read).toEqual([...ids].reverse().slice(0, 10));
    expect(read).not.toContain(fresh);
    expect(f.tagsOf(ids[0]!)).toEqual([REVIEW]);
    expect(f.tagsOf(ids[11]!)).toEqual([]);
  });

  it('without backlog samples the most recent non-archived facts from list(None, 30, 0)', async () => {
    const f = await fixture();
    const fact = f.note('事实', '内容1', ['_type:fact']);
    f.note('学习', '内容2', ['_type:study']);
    f.note('归档', '内容3', ['_type:fact', '_archived']);
    const untyped = f.note('默认事实', '内容4', []);
    const read: string[] = [];
    const base = f.host();
    const listed: unknown[] = [];
    const host = f.host({
      read: id => { read.push(id); return base.read(id); },
      list: (folder, limit, offset) => { listed.push([folder, limit, offset]); return base.list(folder, limit, offset); },
      searchForPurpose: async () => [],
    });
    expect(await runSemanticDedupPass(host)).toEqual({ reviewed: 2, merged: 0, llm_calls: 0 });
    expect(listed).toEqual([[null, 30, 0]]);
    expect(new Set(read)).toEqual(new Set([fact, untyped]));
  });

  it('the LLM budget is min(semantic_merge_max_pairs, 10); 0 disables the pass', async () => {
    const f = await fixture(() => '{"action":"keep"}');
    const other = f.note('其它', '内容', []);
    for (let i = 0; i < 12; i += 1) f.note(`积压 ${i}`, `内容 ${i}`, [REVIEW]);
    const host = f.host({ searchForPurpose: async () => [hit(other, 0.9)] });

    f.service.config.set('evolution_semantic_merge_max_pairs', '2');
    expect(await runSemanticDedupPass(host)).toEqual({ reviewed: 2, merged: 0, llm_calls: 2 });
    f.service.config.set('evolution_semantic_merge_max_pairs', '50');
    expect(await runSemanticDedupPass(host)).toEqual({ reviewed: 10, merged: 0, llm_calls: 10 });

    f.service.config.set('evolution_semantic_merge_max_pairs', '0');
    const read: string[] = [];
    expect(await runSemanticDedupPass(f.host({ read: id => { read.push(id); return null; } })))
      .toEqual({ reviewed: 0, merged: 0, llm_calls: 0 });
    expect(read).toEqual([]);
  });

  it('two consecutive LLM failures end the round; a skipped candidate in between does not reset the count', async () => {
    const f = await fixture(() => { throw new Error('model down'); });
    const other = f.note('其它', '内容', []);
    const order = ['失败1', '__system__x', '失败2', '未处理'].map((title, i) => {
      const id = f.note(title, `内容 ${i}`, [REVIEW]);
      f.mh.db.run('UPDATE notes SET updated_at = ?1 WHERE id = ?2', [`2026-07-0${i + 1}T00:00:00.000Z`, id]);
      return id;
    });
    const read: string[] = [];
    const base = f.host();
    const host = f.host({ read: id => { read.push(id); return base.read(id); }, searchForPurpose: async () => [hit(other, 0.9)] });
    expect(await runSemanticDedupPass(host)).toEqual({ reviewed: 0, merged: 0, llm_calls: 2 });
    expect(read.filter(id => id !== other)).toEqual(order.slice(0, 3));
    expect(f.mh.warnings).toContain('[SemanticDedup] 2 consecutive LLM failures, ending round early');
  });

  it('privacy mode reads nothing', async () => {
    const f = await fixture();
    f.note('积压', '内容', [REVIEW]);
    f.service.setPrivacyMode(true);
    const read: string[] = [];
    expect(await runSemanticDedupPass(f.host({ read: id => { read.push(id); return null; } })))
      .toEqual({ reviewed: 0, merged: 0, llm_calls: 0 });
    expect(read).toEqual([]);
  });
});

describe('run_throttled (semantic_dedup.rs:108-159)', () => {
  it('runs every semantic_dedup_interval_minutes; aggressive uses a third with a 30 minute floor', async () => {
    const f = await fixture();
    let now = 1_800_000_000_000;
    const host = f.host({ nowMs: () => now });
    const throttle = new SemanticDedupThrottle();
    expect(await runSemanticDedupThrottled(host, 'balanced', throttle)).not.toBeNull();
    now += 360 * 60_000 - 1;
    expect(await runSemanticDedupThrottled(host, 'balanced', throttle)).toBeNull();
    now += 1;
    expect(await runSemanticDedupThrottled(host, 'off', throttle)).not.toBeNull();
    now += 120 * 60_000;
    expect(await runSemanticDedupThrottled(host, 'aggressive', throttle)).not.toBeNull();

    f.service.config.set('evolution_semantic_dedup_interval_minutes', '45');
    now += 30 * 60_000 - 1;
    expect(await runSemanticDedupThrottled(host, 'aggressive', throttle)).toBeNull();
    now += 1;
    expect(await runSemanticDedupThrottled(host, 'aggressive', throttle)).not.toBeNull();
  });

  it('a failed pass warns and rolls the timer back; a pass that reviewed something logs the counts', async () => {
    const f = await fixture();
    f.note('积压', '内容', [REVIEW]);
    let broken = true;
    const base = f.host();
    const host = f.host({
      nowMs: () => 1_800_000_000_000,
      getConfig: () => { if (broken) throw new Error('Folder not found: root'); return base.getConfig(); },
      searchForPurpose: async () => [],
    });
    const throttle = new SemanticDedupThrottle();
    expect(await runSemanticDedupThrottled(host, 'balanced', throttle)).toBeNull();
    expect(f.mh.warnings).toContain('[SemanticDedup] Throttled pass failed (non-fatal): Folder not found: root');
    expect(throttle.lastSemanticDedupMs).toBe(0);
    broken = false;
    expect(await runSemanticDedupThrottled(host, 'balanced', throttle)).toEqual({ reviewed: 1, merged: 0, llm_calls: 0 });
    expect(f.mh.infos).toContain('[SemanticDedup] Throttled pass: reviewed=1, merged=0, llm_calls=0');
  });
});

describe('spawn_post_write_maintenance runs the semantic dedup pass (service.rs:782-788)', () => {
  it('merges a backlog duplicate through the real search and L02 seams, then stays throttled', async () => {
    const prompts: string[] = [];
    const f = await fixture(prompt => {
      if (!prompt.startsWith(DEDUP_PROMPT_PREFIX)) return '- 摘要';
      prompts.push(prompt);
      return mergeReply(b, '二次函数配方法掌握不牢');
    });
    // Below evolution's high-frequency thresholds, so the earlier cycle leaves these tags alone.
    const a = f.note('数学二次函数薄弱', '二次函数配方时符号常出错', ['_type:fact', REVIEW, '_hits:2']);
    const b = f.note('配方法掌握不牢', '配方法掌握不牢', ['_type:fact', '_hits:1']);
    const resourceOf = (id: string) => f.mh.db.pluck<string>('SELECT resource_id FROM notes WHERE id = ?1', [id])!;
    f.mh.retrieval.responder = () => ({
      capabilitySnapshot: {} as never,
      plan: { queryModality: 'text', topK: 15, routes: [], imageFallbackChain: [] },
      result: {
        hits: ([[a, 1], [b, 0.95]] as const).map(([id, rrfScore]) => ({
          hit: {
            identity: { resourceId: resourceOf(id), chunkIndex: 0, pageIndex: null, timeRange: null },
            embeddingId: '', text: '', title: null, resourceType: 'note', sourceId: null,
            folderId: null, blobHash: null, imageUrl: null, rawScore: null, metadata: null,
          },
          rrfScore, normalizedScore: null, rerankScore: null, provenance: [],
        })),
        failures: [],
      },
      queryDerivations: [],
    });

    await f.service.spawnPostWriteMaintenance();

    expect(prompts).toHaveLength(1);
    expect(f.deletedAt(a)).not.toBeNull();
    expect(f.service.read(b)?.content).toBe('二次函数配方法掌握不牢');
    expect(f.tagsOf(b)).toEqual(['_type:fact', '_hits:2']);
    expect(queryAuditLogs(f.mh.db, 10, 0, 'semantic_dedup', 'semantic_merge', true)).toHaveLength(1);
    expect(f.mh.warnings.some(message => message.includes('semantic dedup skipped'))).toBe(false);
    expect(f.mh.warnings.some(message => message.includes('promotion pass skipped'))).toBe(false);

    f.note('再次积压', '内容', ['_type:fact', REVIEW]);
    await f.service.spawnPostWriteMaintenance();
    expect(prompts).toHaveLength(1);
  });

  it('privacy mode skips the pass', async () => {
    const prompts: string[] = [];
    const f = await fixture(prompt => { prompts.push(prompt); return '{"action":"keep"}'; });
    const a = f.note('A', '内容', [REVIEW]);
    f.service.setPrivacyMode(true);
    await f.service.spawnPostWriteMaintenance();
    expect(prompts).toEqual([]);
    expect(f.tagsOf(a)).toEqual([REVIEW]);
  });
});
