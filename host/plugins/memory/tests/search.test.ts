import { afterEach, describe, expect, it } from 'vitest';
import { setupMemoryHost, type MemoryHost } from './support.ts';
import type { MemoryServiceImpl } from '../src/service.ts';
import type { MemorySearchResult, MemoryWriteOutput } from '../api.ts';
import type { FusedRetrievalHit } from '../../vfs-index/api.ts';

let current: MemoryHost | undefined;
afterEach(async () => { await current?.dispose(); current = undefined; });
async function setup() { current = await setupMemoryHost(); return current; }
function serviceOf(host: MemoryHost['host']): MemoryServiceImpl {
  return host.ctx.memory as unknown as MemoryServiceImpl;
}

function insertLexicalUnit(host: MemoryHost, resourceId: string, text: string): void {
  const now = Date.now();
  host.db.run(
    `INSERT INTO vfs_index_units
       (id, resource_id, unit_index, text_content, text_source, text_required, text_state,
        mm_required, mm_state, created_at, updated_at)
     VALUES (?1, ?2, 0, ?3, 'native', 1, 'pending', 0, 'disabled', ?4, ?4)`,
    [`unit_${Math.random().toString(36).slice(2, 12)}`, resourceId, text, now],
  );
}

function fused(resourceId: string, text: string, score: number): FusedRetrievalHit {
  return {
    hit: {
      identity: { resourceId, chunkIndex: 0, pageIndex: null, timeRange: null },
      embeddingId: '', text, title: null, resourceType: 'note', sourceId: null,
      folderId: null, blobHash: null, imageUrl: null, rawScore: null, metadata: null,
    },
    rrfScore: score, normalizedScore: null, rerankScore: null, provenance: [],
  };
}

describe('memory_search', () => {
  it('memory_search_uses_lexical_route_without_te_and_ignores_bare_vector', async () => {
    const host = await setup();
    const written = await host.host.invoke('memory_write', {
      title: 'Lexical memory', content: 'profile planner lexical fallback',
    }) as MemoryWriteOutput;
    insertLexicalUnit(host, written.resourceId, 'profile planner lexical fallback');

    const service = serviceOf(host.host);
    const lexical = await service.searchForPurpose('planner lexical fallback', 5, 'internal_dedup');
    expect(lexical).toHaveLength(1);
    expect(lexical[0]!.noteId).toBe(written.noteId);
    expect(lexical[0]!.chunkText).toContain('planner lexical fallback');
    expect(lexical[0]!.score).toBeGreaterThan(0);

    // A bare vector carries no model/profile fingerprint and must not change the route.
    const compatibility = await service.searchWithEmbeddingForPurpose(
      'planner lexical fallback', [1.0, 2.0, 3.0], 5, 'internal_dedup');
    expect(compatibility).toHaveLength(1);
    expect(compatibility[0]!.noteId).toBe(written.noteId);

    expect(host.retrieval.requests).toHaveLength(2);
    expect(host.retrieval.requests[0]).toMatchObject({
      queryText: 'planner lexical fallback', queryModality: 'text', topK: 15,
      resourceTypes: ['note'], resourceIds: null,
    });
    expect(host.retrieval.requests[0]!.folderIds!.length).toBeGreaterThan(0);
  });

  it('memory_search_command_clamps_top_k_and_skips_privacy_mode', async () => {
    const host = await setup();
    const first = await host.host.invoke('memory_write', {
      title: 'Visible', content: 'visible token',
    }) as MemoryWriteOutput;
    const second = await host.host.invoke('memory_write', {
      title: 'Second', content: 'visible token',
    }) as MemoryWriteOutput;
    insertLexicalUnit(host, first.resourceId, 'visible token');
    insertLexicalUnit(host, second.resourceId, 'visible token');

    const result = await host.host.invoke('memory_search', { query: 'visible', topK: 500 }) as MemorySearchResult[];
    expect(result.length).toBeGreaterThan(0);
    // Post-write semantic dedup also retrieves (note content, topK=15). Assert the
    // command's query, not whichever background request happened to finish last.
    const commandRequests = host.retrieval.requests.filter(request => request.queryText === 'visible');
    expect(commandRequests).toHaveLength(1);
    expect(commandRequests[0]!.topK).toBe(300);

    // Settle the writes' maintenance before measuring privacy mode's no-I/O contract.
    await serviceOf(host.host).spawnPostWriteMaintenance();
    await host.host.invoke('memory_set_privacy_mode', { enabled: true });
    const requestsBefore = host.retrieval.requests.length;
    expect(await host.host.invoke('memory_search', { query: 'visible' })).toEqual([]);
    expect(host.retrieval.requests).toHaveLength(requestsBefore);
    expect(host.warnings.some(message => message.includes('Privacy mode enabled'))).toBe(true);
  });

  it('memory_search_dedupes_resources_and_filters_archived_and_deleted_notes', async () => {
    const host = await setup();
    const add = async (title: string): Promise<MemoryWriteOutput> =>
      host.host.invoke('memory_write', { title, content: `${title} keyword` }) as Promise<MemoryWriteOutput>;
    const active = await add('Active');
    const archived = await add('Archived');
    const removed = await add('Removed');
    host.db.run("UPDATE notes SET tags = '[\"_archived\"]' WHERE id = ?1", [archived.noteId]);
    host.db.run('UPDATE notes SET deleted_at = ?1 WHERE id = ?2',
      ['2026-01-01T00:00:00.000Z', removed.noteId]);

    host.retrieval.responder = () => ({
      capabilitySnapshot: {} as never,
      plan: { queryModality: 'text', topK: 15, routes: [], imageFallbackChain: [] },
      result: {
        hits: [
          fused(active.resourceId, 'keyword chunk one', 1),
          fused(active.resourceId, 'keyword chunk two', 0.9),
          fused(archived.resourceId, 'keyword archived', 0.8),
          fused(removed.resourceId, 'keyword removed', 0.7),
        ],
        failures: [],
      },
      queryDerivations: [],
    });
    const results = await host.host.invoke('memory_search', { query: 'keyword' }) as MemorySearchResult[];
    expect(results).toHaveLength(1);
    expect(results[0]!.noteId).toBe(active.noteId);
  });

  it('memory_search_applies_tag_weight_then_time_decay', async () => {
    const host = await setup();
    const base = await host.host.invoke('memory_write', { title: 'Base', content: 'decay keyword' }) as MemoryWriteOutput;
    const important = await host.host.invoke('memory_write', { title: 'Important', content: 'decay keyword' }) as MemoryWriteOutput;
    const old = await host.host.invoke('memory_write', { title: 'Old', content: 'decay keyword' }) as MemoryWriteOutput;
    host.db.run("UPDATE notes SET tags = '[\"_important\"]' WHERE id = ?1", [important.noteId]);
    host.db.run('UPDATE notes SET updated_at = ?1 WHERE id = ?2',
      ['2020-01-01T00:00:00.000Z', old.noteId]);
    host.db.run('UPDATE notes SET updated_at = ?1 WHERE id IN (?2, ?3)',
      [new Date().toISOString(), base.noteId, important.noteId]);
    const importantUpdatedAt = host.db.get<{ updated_at: string }>(
      'SELECT updated_at FROM notes WHERE id = ?1', [important.noteId])!.updated_at;

    host.retrieval.responder = () => ({
      capabilitySnapshot: {} as never,
      plan: { queryModality: 'text', topK: 15, routes: [], imageFallbackChain: [] },
      result: {
        hits: [
          fused(base.resourceId, 'base chunk', 1),
          fused(important.resourceId, 'important chunk', 1),
          fused(old.resourceId, 'old chunk', 1),
        ],
        failures: [],
      },
      queryDerivations: [],
    });
    const results = await host.host.invoke('memory_search', { query: 'decay', topK: 3 }) as MemorySearchResult[];
    expect(results.map(result => result.noteId)).toEqual([important.noteId, base.noteId, old.noteId]);
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
    expect(results[1]!.score).toBeGreaterThan(results[2]!.score);

    // User retrieval records ranked hit tags without touching updated_at.
    const tags = JSON.parse(host.db.get<{ tags: string }>('SELECT tags FROM notes WHERE id = ?1',
      [important.noteId])!.tags) as string[];
    expect(tags.some(tag => tag.startsWith('_hits:'))).toBe(true);
    expect(tags.some(tag => tag.startsWith('_last_hit:'))).toBe(true);
    const afterUpdatedAt = host.db.get<{ updated_at: string }>(
      'SELECT updated_at FROM notes WHERE id = ?1', [important.noteId])!.updated_at;
    expect(afterUpdatedAt).toBe(importantUpdatedAt);
  });
});
