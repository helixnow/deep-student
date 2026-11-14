import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupMemoryHost, type MemoryHost } from './support.ts';
import type { MemoryWriteOutput, SmartWriteOutput } from '../api.ts';
import type { MemoryServiceImpl } from '../src/service.ts';
import { localDate } from '../src/daily-log.ts';
import { buildPromotionPrompt, promotionFingerprint, PROMOTION_LAST_FINGERPRINT_KEY } from '../src/evolution.ts';
import { emptyProfile } from '../src/learner-profile.ts';
import { getConfigValue } from '../repository/config.ts';

let current: MemoryHost | undefined;
afterEach(async () => { await current?.dispose(); current = undefined; });
async function setup() { current = await setupMemoryHost(); return current; }

describe('post-write side effects', () => {
  it('memory_write_triggers_immediate_index_and_post_write_profile_refresh', async () => {
    const host = await setup();
    const written = await host.host.invoke('memory_write', {
      title: 'Immediate', content: 'write then search', folderPath: '工作',
    }) as MemoryWriteOutput;
    expect(host.index.indexed).toContain(written.resourceId);
    await vi.waitFor(() => {
      expect(host.db.get<{ index_state: string }>(
        'SELECT index_state FROM resources WHERE id = ?1', [written.resourceId])?.index_state)
        .toBe('indexed');
    });

    await vi.waitFor(() => {
      const profile = host.db.get<{ id: string; data: string }>(
        `SELECT n.id AS id, r.data AS data FROM notes n JOIN resources r ON r.id = n.resource_id
         WHERE n.title = '__user_profile__' AND n.deleted_at IS NULL`);
      expect(profile).toBeDefined();
      expect(profile!.data).toContain('## 工作');
      expect(profile!.data).toContain('- write then search');
    });

    // The profile note is a system note and must not enter the index.
    const profileResource = host.db.get<{ resource_id: string }>(
      "SELECT resource_id FROM notes WHERE title = '__user_profile__'");
    expect(host.db.get<{ index_state: string }>(
      'SELECT index_state FROM resources WHERE id = ?1', [profileResource!.resource_id])?.index_state)
      .toBe('disabled');
  });

  it('update_delete_smart_and_batch_paths_trigger_the_same_index_hooks', async () => {
    const host = await setup();
    const created = await host.host.invoke('memory_write', {
      title: 'Hooks', content: 'one',
    }) as MemoryWriteOutput;
    const updated = await host.host.invoke('memory_update_by_id', {
      noteId: created.noteId, content: 'one two',
    }) as MemoryWriteOutput;
    expect(host.index.indexed).toContain(updated.resourceId);

    const smart = await host.host.invoke('memory_write_smart', {
      title: 'Smart hook', content: 'smart fact', memoryType: 'fact',
    }) as SmartWriteOutput;
    expect(host.index.indexed).toContain(smart.resourceId!);

    const batch = await host.host.invoke('memory_write_batch', {
      items: [
        { title: 'Batch A', content: 'alpha' },
        { title: 'Batch B', content: 'beta' },
      ],
      defaultMemoryType: 'study',
    }) as { results: Array<{ resourceId?: string | null }> };
    for (const item of batch.results) {
      expect(host.index.indexed).toContain(item.resourceId);
    }

    const resourceId = updated.resourceId;
    await host.host.invoke('memory_delete', { noteId: created.noteId });
    expect(host.index.deleted).toContain(resourceId);
    await vi.waitFor(() => {
      expect(host.db.get<{ index_state: string }>(
        'SELECT index_state FROM resources WHERE id = ?1', [resourceId])?.index_state)
        .toBe('disabled');
    });
  });

  it('mark_pending_failure_warns_instead_of_failing_the_write', async () => {
    const host = await setup();
    host.repos.indexStates.markPending = () => { throw new Error('index unavailable'); };
    const written = await host.host.invoke('memory_write', {
      title: 'Still written', content: 'index failure must not fail the write',
    }) as MemoryWriteOutput;
    expect(written.noteId).toMatch(/^note_/);
    expect(host.warnings.some(message =>
      message.includes('[Memory] Failed to mark pending for indexing: index unavailable'))).toBe(true);
    expect(host.db.get<{ id: string }>('SELECT id FROM notes WHERE id = ?1', [written.noteId]))
      .toBeDefined();
  });
});

function serviceOf(host: MemoryHost): MemoryServiceImpl {
  return host.host.ctx.memory as unknown as MemoryServiceImpl;
}

function categoryPrompt(category: string, facts: readonly string[]): string {
  return `你是一个用户画像聚合器。请将以下关于用户的原子事实聚合为**结构化的分类摘要**。

## 分类: ${category}

## 原子事实列表
${facts.map((fact, i) => `${i + 1}. ${fact}`).join('\n')}

## 要求
1. 生成 Markdown 格式的结构化摘要
2. 合并相关事实，消除冗余
3. 如果事实之间有矛盾，以编号较大（较新）的为准
4. 保持简洁，每条不超过一行
5. 不要添加原子事实中没有的信息

## 输出格式
直接输出 Markdown 内容，不要包裹代码块。`;
}

const PROMOTION_REPLY = JSON.stringify({
  weak_points_add: [{ subject: '数学', knowledge_point: '二次函数', error_pattern: '配方时符号处理错误', evidence_count: 3, last_seen: '2026-07-08' }],
  weak_points_remove: [], goals_add: [], goals_remove: [], recent_status: '近两天集中练习二次函数',
});
const isPromotionPrompt = (prompt: string) => prompt.startsWith('你是学习者画像的策展人');

describe('spawn_post_write_maintenance LLM passes (service.rs:726-790)', () => {
  it('category_refresh_writes_the_member_tagged_system_summary_like_category_manager', async () => {
    const prompts: string[] = [];
    current = await setupMemoryHost({ memoryDecision: prompt => { prompts.push(prompt); return '- 喜欢早起学习'; } });
    const host = current;
    const written = await host.host.invoke('memory_write', {
      title: '作息', content: '喜欢早起学习', folderPath: '偏好',
    }) as MemoryWriteOutput;
    await serviceOf(host).spawnPostWriteMaintenance();

    expect(prompts.length).toBeGreaterThan(0);
    for (const prompt of prompts) expect(prompt).toBe(categoryPrompt('偏好', ['喜欢早起学习']));
    expect(serviceOf(host).listCategorySummariesWithMembers()).toEqual([
      { category: '偏好', content: '- 喜欢早起学习', memberIds: [written.noteId] },
    ]);
    const note = host.db.get<{ tags: string; folder: string; index_state: string }>(
      `SELECT n.tags AS tags, f.title AS folder, r.index_state AS index_state FROM notes n
       JOIN folder_items fi ON fi.item_type = 'note' AND fi.item_id = n.id
       JOIN folders f ON f.id = fi.folder_id JOIN resources r ON r.id = n.resource_id
       WHERE n.title = '__cat_path:%E5%81%8F%E5%A5%BD__' AND n.deleted_at IS NULL`);
    expect(note).toEqual({ tags: JSON.stringify(['_system', `_member:${written.noteId}`]), folder: '__system__', index_state: 'disabled' });
    expect(serviceOf(host).getProfile()).toEqual([{ category: '偏好', content: '- 喜欢早起学习' }]);
  });

  it('privacy_mode_sends_nothing_to_the_model', async () => {
    const prompts: string[] = [];
    current = await setupMemoryHost({ memoryDecision: prompt => { prompts.push(prompt); return PROMOTION_REPLY; } });
    const service = serviceOf(current);
    await current.host.invoke('memory_get_or_create_root_folder', {});
    service.setPrivacyMode(true);
    service.appendDailyLog(localDate(), '二次函数配方又错了');
    await current.host.invoke('memory_write', { title: '作息', content: '喜欢早起学习', folderPath: '偏好' });
    await service.spawnPostWriteMaintenance();
    expect(prompts).toEqual([]);
    expect(service.listCategorySummariesWithMembers()).toEqual([]);
  });

  it('frequency_off_still_runs_the_evolution_cycle_on_the_24h_interval', async () => {
    current = await setupMemoryHost();
    const { host, db } = current;
    await host.invoke('memory_get_or_create_root_folder', {});
    const service = serviceOf(current);
    service.setAutoExtractFrequency('off');
    const frequent = service.write(null, '高频偏好', '喜欢图解', 'create');
    db.run('UPDATE notes SET tags = ?1 WHERE id = ?2', [JSON.stringify(['_type:fact', '_hits:5']), frequent.noteId]);
    await service.spawnPostWriteMaintenance();
    expect(JSON.parse(db.pluck<string>('SELECT tags FROM notes WHERE id = ?1', [frequent.noteId]) ?? '[]'))
      .toContain('_important');
  });

  it('promotion_pass_merges_recent_daily_logs_and_records_the_fingerprint_once', async () => {
    const prompts: string[] = [];
    current = await setupMemoryHost({
      memoryDecision: prompt => { prompts.push(prompt); return isPromotionPrompt(prompt) ? PROMOTION_REPLY : '- 摘要'; },
    });
    const service = serviceOf(current);
    await current.host.invoke('memory_get_or_create_root_folder', {});
    const date = localDate();
    service.appendDailyLog(date, '二次函数配方又错了');
    const log = service.dailyLogSnapshot(date)!;
    const logs = [{ date, noteId: log.noteId, content: log.content }];
    const fingerprint = promotionFingerprint(logs);

    await current.host.invoke('memory_write', { title: '作息', content: '喜欢早起学习', folderPath: '偏好' });
    await service.spawnPostWriteMaintenance();

    expect(prompts.filter(isPromotionPrompt)).toEqual([buildPromotionPrompt(logs, emptyProfile())]);
    const profile = service.loadProfile()!;
    expect(profile.version).toBe(1);
    expect(profile.weak_points.map(point => point.knowledge_point)).toEqual(['二次函数']);
    expect(profile.recent_status).toBe('近两天集中练习二次函数');
    expect(profile.last_promotion_fingerprint).toBe(fingerprint);
    expect(getConfigValue(current.db, PROMOTION_LAST_FINGERPRINT_KEY)).toBe(fingerprint);
    expect(current.infos).toContain('[Evolution] Promotion pass applied: logs=1, new_version=Some(1)');
  });

  it('llm_failures_warn_with_the_rust_text_and_roll_the_promotion_throttle_back', async () => {
    let promotionCalls = 0;
    current = await setupMemoryHost({
      memoryDecision: prompt => {
        if (isPromotionPrompt(prompt)) promotionCalls += 1;
        throw new Error('model down');
      },
    });
    const service = serviceOf(current);
    await current.host.invoke('memory_get_or_create_root_folder', {});
    service.appendDailyLog(localDate(), '二次函数配方又错了');
    await current.host.invoke('memory_write', { title: '作息', content: '喜欢早起学习', folderPath: '偏好' });
    await service.spawnPostWriteMaintenance();

    expect(current.warnings).toContain("[CategoryManager] Failed to refresh category '偏好': Category summary LLM call failed: model down");
    expect(current.warnings).toContain('[Evolution] Promotion pass failed (non-fatal): Promotion LLM call failed: model down');
    const afterFirst = promotionCalls;
    expect(afterFirst).toBeGreaterThan(0);
    await service.spawnPostWriteMaintenance();
    expect(promotionCalls).toBe(afterFirst + 1);
    expect(service.loadProfile()).toBeNull();
  });
});
