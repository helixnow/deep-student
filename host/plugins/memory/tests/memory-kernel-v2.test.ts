import { afterEach, describe, expect, it } from 'vitest';
import { setupMemoryHost, type MemoryHost } from './support.ts';
import type { MemoryServiceImpl } from '../src/service.ts';
import type { MemoryInspectionView, MemoryProvider } from '../api.ts';
import { MemoryToolExecutor } from '../src/memory-tool-executor.ts';
import type { ExecutionContext, ToolExecutor } from '../../chat/api.ts';
import {
  MEMORY_KERNEL_PACING_RULE, MEMORY_KERNEL_PACING_RULE_EN, PromptBuilder,
} from '../../chat-pipeline/src/prompt-builder.ts';
import {
  buildHardRulesDelta, normalizeRuleScope, renderHardRules, renderedHardRulesCharCount, ruleCharLength,
} from '../src/hard-rules.ts';
import { PROFILE_HISTORY_KEEP, emptyPreferencesPatch, emptyProfileUpdate } from '../src/learner-profile.ts';

let current: MemoryHost | undefined;
afterEach(async () => { await current?.dispose(); current = undefined; });

async function setup() {
  current = await setupMemoryHost();
  return current;
}

function serviceOf(host: MemoryHost['host']): MemoryServiceImpl {
  return host.ctx.memory as unknown as MemoryServiceImpl;
}

function providerOf(host: MemoryHost['host']): MemoryProvider {
  return host.ctx.memoryProvider;
}

function makeToolCtx(sessionId = 'sess_m1'): ExecutionContext {
  return {
    session_id: sessionId,
    message_id: 'msg_1',
    block_id: 'blk_1',
    variant_id: null,
    cancellation_token: null,
    isCancelled: () => false,
    emitToolCallStart: () => {},
    emitToolCallEnd: () => {},
    emitToolCallError: () => {},
    saveToolBlock: () => {},
  } as unknown as ExecutionContext;
}

async function callTool(executor: ToolExecutor, name: string, args: unknown, sessionId = 'sess_m1') {
  return executor.execute({ id: `call_${name}`, name, arguments: args }, makeToolCtx(sessionId));
}

describe('RFC-001 M1: MemoryProvider, HardRules, Frozen <memory_kernel>, and History Rollback', () => {
  it('upserts, lists, filters by scope, and removes L1 HardRules via tools & IPC', async () => {
    const { host } = await setup();
    const service = serviceOf(host);
    const executor = new MemoryToolExecutor({
      service: () => service,
      llmAvailable: () => true,
      emit: () => {},
      log: { debug: () => {}, info: () => {}, warn: () => {} },
    });

    const addGlobal = await callTool(executor, 'builtin-memory_rule_upsert', {
      instruction: '每次回答结束后附带 1 道变式自测题，先不给答案',
      scope: 'global',
      pinned: true,
    });
    expect((addGlobal.output as Record<string, any>).success).toBe(true);
    const ruleId = (addGlobal.output as Record<string, any>).rule.id as string;

    const addMath = await callTool(executor, 'builtin-memory_rule_upsert', {
      instruction: '讲线代时必须先给几何直观再给代数证明',
      scope: 'subject:math',
    });
    expect((addMath.output as Record<string, any>).success).toBe(true);

    const listed = await callTool(executor, 'builtin-memory_rule_list', {});
    expect((listed.output as Record<string, any>).rules).toHaveLength(2);

    // Scope filtering: general session sees global rule only; math session sees both.
    const provider = providerOf(host);
    const generalSnap = provider.buildSessionSnapshot({ sessionId: 's1', memoryEnabled: true });
    expect(generalSnap.renderedKernel).toContain('每次回答结束后附带 1 道变式自测题');
    expect(generalSnap.renderedKernel).not.toContain('几何直观');

    const mathSnap = provider.buildSessionSnapshot({ sessionId: 's2', memoryEnabled: true, subject: 'math' });
    expect(mathSnap.renderedKernel).toContain('每次回答结束后附带 1 道变式自测题');
    expect(mathSnap.renderedKernel).toContain('几何直观');

    const removed = await callTool(executor, 'builtin-memory_rule_remove', { id: ruleId });
    expect((removed.output as Record<string, any>).removed).toBe(true);
    expect(service.loadHardRules().rules).toHaveLength(1);
  });

  it('rejects overflowing HardRules writes (Hermes hard-limit distillation pressure) and returns current_rules', async () => {
    const { host } = await setup();
    const service = serviceOf(host);
    // Tighten budget to minimum (800 chars) via MemoryProvider
    const budgeted = providerOf(host).mutateFromUser({ kind: 'set_budgets', rulesMaxChars: 800 });
    expect(budgeted.budgets.rulesMaxChars).toBe(800);

    const executor = new MemoryToolExecutor({
      service: () => service,
      llmAvailable: () => true,
      emit: () => {},
      log: { debug: () => {}, info: () => {}, warn: () => {} },
    });

    // Fill near 800 chars
    for (let i = 0; i < 4; i += 1) {
      const res = await callTool(executor, 'builtin-memory_rule_upsert', {
        instruction: `规则${i}：` + '请严格遵守详细推导并附带变式题与几何直觉解释'.repeat(7),
        scope: 'global',
      });
      expect((res.output as Record<string, any>).success).toBe(true);
    }

    // Next write must overflow and be rejected with full current_rules for in-turn condensation
    const overflow = await callTool(executor, 'builtin-memory_rule_upsert', {
      instruction: '溢出规则：' + '再来一条很长的互动约束规则用于触发预算拒绝机制'.repeat(7),
      scope: 'global',
    });
    const out = overflow.output as Record<string, any>;
    expect(out.success).toBe(false);
    expect(out.error).toContain('800 字符硬上限');
    expect(Array.isArray(out.current_rules)).toBe(true);
    expect(out.current_rules.length).toBe(4);
  });

  it('produces byte-stable <memory_kernel> in stableSystem and delivers mid-session edits via <memory_delta>', async () => {
    const { host } = await setup();
    const provider = providerOf(host);

    provider.mutateFromUser({
      kind: 'upsert_rule',
      input: {
        instruction: '回答末尾必须出 1 道自测题',
        scope: 'global',
        pinned: true,
      },
    });

    // Turn 1: freeze snapshot
    const frozen = provider.buildSessionSnapshot({ sessionId: 'sess_freeze', memoryEnabled: true });
    expect(frozen.renderedKernel).toContain('回答末尾必须出 1 道自测题');

    const turn1 = new PromptBuilder(null)
      .withMemoryKernel(frozen.renderedKernel)
      .withMemoryDelta(provider.buildSessionDelta({ sessionId: 'sess_freeze', memoryEnabled: true }, frozen))
      .buildSplit();
    expect(turn1.stableSystem).toContain('<memory_kernel>');
    expect(turn1.stableSystem).toContain('回答末尾必须出 1 道自测题');
    // Zero legacy per-turn profile duplication in turnVolatile!
    expect(turn1.turnVolatile).toBeNull();

    // Mid-session: user adds a brand-new rule
    provider.mutateFromUser({
      kind: 'upsert_rule',
      input: {
        instruction: '不要直接给最终答案，先给第一步提示',
        scope: 'global',
        pinned: true,
      },
    });

    // Turn 2: stableSystem stays byte-identical (Prompt Cache intact!), while turnVolatile carries <memory_delta>
    const delta = provider.buildSessionDelta({ sessionId: 'sess_freeze', memoryEnabled: true }, frozen);
    expect(delta).not.toBeNull();
    expect(delta).toContain('不要直接给最终答案，先给第一步提示');

    const turn2 = new PromptBuilder(null)
      .withMemoryKernel(frozen.renderedKernel)
      .withMemoryDelta(delta)
      .buildSplit();
    expect(turn2.stableSystem).toBe(turn1.stableSystem);
    expect(turn2.turnVolatile).toContain('<memory_delta>');
    expect(turn2.turnVolatile).toContain('不要直接给最终答案，先给第一步提示');
    expect(turn2.turnVolatile).not.toContain('<user_profile>');
    expect(turn2.turnVolatile).not.toContain('<learner_profile>');
  });

  it('bridges freshly written VFS preference notes into Turn-1 <memory_kernel> without throttled category refresh (U13 guarantee)', async () => {
    const { host } = await setup();
    const service = serviceOf(host);
    service.getOrCreateRootFolder();
    service.write('偏好', '自测偏好', '以后每次回答结束后都给我 1 道自测题', 'create');

    const snap = providerOf(host).buildSessionSnapshot({ sessionId: 'sess_u13', memoryEnabled: true });
    expect(snap.renderedKernel).toContain('## 用户已记录的核心记忆与互动偏好（请从第 1 轮起主动结合并严格遵循其中的互动要求）');
    expect(snap.renderedKernel).toContain('以后每次回答结束后都给我 1 道自测题');
  });

  it('allows personal learner profile and standing-instruction facts containing discipline keywords while still filtering pure knowledge/sensitive writes (Wave 6 U13 Defect 1)', async () => {
    const { host } = await setup();
    const bgRes = await host.invoke('memory_write_smart', {
      title: '学习背景与偏好',
      content: '我是大二工科生，理解抽象概念时最喜欢生活中的工程类比',
      memoryType: 'fact',
    }) as { event: string; noteId: string; isNew: boolean };
    expect(bgRes.event).toBe('ADD');
    expect(bgRes.isNew).toBe(true);
    expect(bgRes.noteId).toMatch(/\S/);

    const quizRes = await host.invoke('memory_write_smart', {
      title: '互动习惯',
      content: '每次讲完概念后请固定给我留 1 道自测小思考题',
      memoryType: 'fact',
    }) as { event: string; noteId: string; isNew: boolean };
    expect(quizRes.event).toBe('ADD');
    expect(quizRes.isNew).toBe(true);
    expect(quizRes.noteId).toMatch(/\S/);

    // Pure discipline knowledge and sensitive data must still be filtered.
    const pureKnowledge = await host.invoke('memory_write_smart', {
      title: '公式',
      content: '勾股定理 a^2 + b^2 = c^2',
      memoryType: 'fact',
    }) as { event: string; reason: string };
    expect(pureKnowledge.event).toBe('FILTERED');
    expect(pureKnowledge.reason).toContain('fact 类型只允许保存用户事实');

    const sensitive = await host.invoke('memory_write_smart', {
      title: '联系方式',
      content: '手机号 13812345678',
      memoryType: 'fact',
    }) as { event: string; reason: string };
    expect(sensitive.event).toBe('FILTERED');
    expect(sensitive.reason).toContain('敏感信息');
  });

  it('bridges VFS learner background and standing instructions into Turn-1 <memory_kernel> even when LearnerProfile already exists (Wave 6 U13 Defect 2)', async () => {
    const { host } = await setup();
    const service = serviceOf(host);
    const provider = providerOf(host);

    // Populate LearnerProfile first so hasLearnerProfile === true.
    const update = emptyProfileUpdate();
    update.recent_status = '正在复习线性代数期中考试';
    service.applyProfileUpdate(update, {
      source: 'handler',
      reason: 'seed learner profile',
      limitPolicy: 'reject',
    });

    // Save personal background & standing instruction via MemoryView smart write (outside 偏好 folder).
    const bgWrite = await host.invoke('memory_write_smart', {
      folderPath: '',
      title: '工科背景',
      content: '我是大二工科生，理解抽象概念时最喜欢生活中的工程类比',
      memoryType: 'fact',
    }) as { event: string; noteId: string };
    expect(bgWrite.event).toBe('ADD');

    const quizWrite = await host.invoke('memory_write_smart', {
      folderPath: '学习习惯',
      title: '课后自测',
      content: '每次讲完概念后请固定给我留 1 道自测小思考题',
      memoryType: 'fact',
    }) as { event: string; noteId: string };
    expect(quizWrite.event).toBe('ADD');

    // Stale and archived notes must stay excluded from the bridge.
    const staleNote = service.write('学习习惯', '旧习惯', '每次都要画三视图', 'create');
    current!.db.run(`UPDATE notes SET tags = '["_stale"]' WHERE id = ?`, [staleNote.noteId]);
    const archivedNote = service.write('学习习惯', '已归档偏好', '每次都用英文回答', 'create');
    current!.db.run(`UPDATE notes SET tags = '["_archived"]' WHERE id = ?`, [archivedNote.noteId]);

    const snap = provider.buildSessionSnapshot({ sessionId: 'sess_blank_turn1', memoryEnabled: true });
    expect(snap.renderedKernel).toContain('## 学习者长期画像');
    expect(snap.renderedKernel).toContain('正在复习线性代数期中考试');
    expect(snap.renderedKernel).toContain('## 用户已记录的核心记忆与互动偏好（请从第 1 轮起主动结合并严格遵循其中的互动要求）');
    expect(snap.renderedKernel).toContain('我是大二工科生，理解抽象概念时最喜欢生活中的工程类比');
    expect(snap.renderedKernel).toContain('每次讲完概念后请固定给我留 1 道自测小思考题');
    expect(snap.renderedKernel).not.toContain('每次都要画三视图');
    expect(snap.renderedKernel).not.toContain('每次都用英文回答');
    expect(snap.includedLegacyNoteIds).toContain(bgWrite.noteId);
    expect(snap.includedLegacyNoteIds).toContain(quizWrite.noteId);
    expect(snap.includedLegacyNoteIds).not.toContain(staleNote.noteId);
    expect(snap.includedLegacyNoteIds).not.toContain(archivedNote.noteId);
  });

  it('keeps 10 learner profile history versions (including mastery reflux) and supports IPC rollback', async () => {
    const { host } = await setup();
    const service = serviceOf(host);
    expect(PROFILE_HISTORY_KEEP).toBe(10);

    for (let i = 1; i <= 7; i += 1) {
      const update = emptyProfileUpdate();
      update.recent_status = `阶段 ${i}`;
      service.applyProfileUpdate(update, {
        source: 'handler', reason: `step ${i}`, limitPolicy: 'reject',
      });
    }
    // Mastery reflux must also record history now!
    service.upsertWeakPointFromMastery('特征值分解', {
      score: 0.35, total: 4, wrongCount: 3, recentWrongSummary: '特征向量求错',
    });

    const inspected = providerOf(host).inspect();
    expect(inspected.profileHistory.length).toBe(8);
    expect(inspected.profileHistory[0]!.version).toBe(8);

    // Roll back to v3 via MemoryProvider (also exposed via meta.remote)
    const rolled: MemoryInspectionView = providerOf(host).mutateFromUser({ kind: 'rollback_profile', targetVersion: 3 });
    expect(rolled.learnerProfile.recent_status).toBe('阶段 3');
    expect(rolled.learnerProfile.version).toBe(9);
  });

  it('ingests essay_graded low-scoring dimensions and real mastery subject/relapse into LearnerProfile (RFC-001 M2)', async () => {
    const { host } = await setup();
    const provider = providerOf(host);
    const service = serviceOf(host);

    provider.ingestSignal({
      kind: 'essay_graded',
      examType: 'ielts_task2',
      essayId: 'essay_1',
      rubricDimensions: [
        { name: 'Task Response', score: 7.5, maxScore: 9, recurringIssue: null },
        { name: 'Grammatical Range', score: 5.0, maxScore: 9, recurringIssue: '频繁漏用虚拟语气和倒装' },
      ],
    });

    // Mastery reflux with real subject and relapse count
    service.upsertWeakPointFromMastery('特征值分解', {
      score: 0.35, total: 5, wrongCount: 4, recentWrongSummary: '特征向量方向算错',
      subject: '线性代数', relapseCount: 2,
    });

    const view = provider.inspect();
    const essayWp = view.learnerProfile.weak_points.find(wp => wp.knowledge_point === 'Grammatical Range');
    expect(essayWp).toBeDefined();
    expect(essayWp!.subject).toBe('ielts_task2');
    expect(essayWp!.error_pattern).toContain('虚拟语气');
    // High-scoring dimension (7.5/9 >= 65%) must NOT be added as a weakness
    expect(view.learnerProfile.weak_points.some(wp => wp.knowledge_point === 'Task Response')).toBe(false);

    const mathWp = view.learnerProfile.weak_points.find(wp => wp.knowledge_point === '特征值分解');
    expect(mathWp).toBeDefined();
    expect(mathWp!.subject).toBe('线性代数');
    expect(mathWp!.error_pattern).toContain('relapse=2');
  });

  it('embeds compact anti-truncation pacing guidance in <memory_kernel> without inflating HardRules budget (P3-3)', async () => {
    const { host } = await setup();
    const service = serviceOf(host);
    const provider = providerOf(host);

    // Empty kernel: <memory_kernel> and pacing guidance must be omitted completely.
    const emptySnap = provider.buildSessionSnapshot({ sessionId: 'sess_p3_empty', memoryEnabled: true });
    expect(emptySnap.renderedKernel).toBe('');
    const emptyBuilt = new PromptBuilder(null).withMemoryKernel(emptySnap.renderedKernel).buildSplit();
    expect(emptyBuilt.stableSystem).not.toContain('<memory_kernel>');
    expect(emptyBuilt.stableSystem).not.toContain(MEMORY_KERNEL_PACING_RULE);

    // Non-empty kernel with an ending rule: <memory_kernel> carries concise pacing guidance
    // while HardRules char budget accounting stays 100% consistent with renderHardRules.
    provider.mutateFromUser({
      kind: 'upsert_rule',
      input: {
        instruction: '每次讲解末尾必须附带【30秒自测】1 道思考题',
        scope: 'global',
        pinned: true,
      },
    });
    const doc = service.loadHardRules();
    expect(renderedHardRulesCharCount(doc)).toBe(ruleCharLength(renderHardRules(doc.rules)));
    expect(ruleCharLength(MEMORY_KERNEL_PACING_RULE)).toBeLessThanOrEqual(80);

    const nonEmptySnap = provider.buildSessionSnapshot({ sessionId: 'sess_p3_full', memoryEnabled: true });
    const fullBuilt = new PromptBuilder(null).withMemoryKernel(nonEmptySnap.renderedKernel).buildSplit();
    expect(fullBuilt.stableSystem).toContain('<memory_kernel>');
    expect(fullBuilt.stableSystem).toContain(MEMORY_KERNEL_PACING_RULE);
    expect(fullBuilt.stableSystem).toContain('【30秒自测】');
    expect(fullBuilt.stableSystem.indexOf(MEMORY_KERNEL_PACING_RULE))
      .toBeLessThan(fullBuilt.stableSystem.indexOf('【30秒自测】'));
    // Must not inject concrete examples like 自测题 that models could hallucinate as user rules
    expect(MEMORY_KERNEL_PACING_RULE).not.toContain('自测题');
  });

  it('broadcasts exact revoked rule instruction in <memory_delta> when removed mid-session and filters transient noise', async () => {
    const { host } = await setup();
    const provider = providerOf(host);

    const added = provider.mutateFromUser({
      kind: 'upsert_rule',
      input: { instruction: '每次回答必须以【Day1口头禅：稳扎稳打】开头', scope: 'global', pinned: true },
    });
    const ruleId = added.hardRules.rules[0]!.id;
    const frozen = provider.buildSessionSnapshot({ sessionId: 'sess_revoke', memoryEnabled: true });
    expect(frozen.includedRuleIds).toContain(ruleId);

    // Same-session deletion (e.g. clicking AttributionPill "忘掉")
    provider.mutateFromUser({ kind: 'remove_rule', idOrInstruction: ruleId });
    const delta = provider.buildSessionDelta({ sessionId: 'sess_revoke', memoryEnabled: true }, frozen);
    expect(delta).not.toBeNull();
    expect(delta).toContain('【已作废/撤回，立即停止执行】');
    expect(delta).toContain('【Day1口头禅：稳扎稳打】');

    // Transient one-off filter check
    const { filterTransientCandidates } = await import('../src/auto-extractor.ts');
    const kept = filterTransientCandidates(
      [
        { title: '幽默风格偏好', content: '用户喜欢用打油诗改写数学概念', folder: '偏好' },
        { title: '英文缩写偏好', content: '用户偏好中文括注英文缩写', folder: '偏好' },
        { title: '临时自习安排', content: '今天临时改去图书馆', folder: '日程' },
        { title: 'One-off schedule', content: 'temporary schedule override tonight', folder: 'Schedule' },
      ],
      '以后英文缩写都要括注中文。对了，帮我把贝叶斯定理改写成打油诗，就这一次搞笑一下。',
    );
    expect(kept.map(c => c.title)).toEqual(['英文缩写偏好']);
  });

  it('injects localized global-alias HardRules on Turn 1 of every new session (S4-03/S4-14)', async () => {
    const { host } = await setup();
    const provider = providerOf(host);
    provider.mutateFromUser({
      kind: 'upsert_rule',
      input: { instruction: '每次回答先给一句话结论，再给步骤', scope: '全局', pinned: true },
    });
    const turn1 = provider.buildSessionSnapshot({ sessionId: 'sess_turn1_alias', memoryEnabled: true });
    expect(turn1.renderedKernel).toContain('每次回答先给一句话结论，再给步骤');
    expect(turn1.includedRuleIds).toHaveLength(1);
  });

  it('G01-1a: preserves user language and avoids Chinese leakage for non-Chinese HardRules, LearnerProfile, legacy bridge, and deltas', async () => {
    const { host } = await setup();
    const service = serviceOf(host);
    const provider = providerOf(host);
    const executor = new MemoryToolExecutor({
      service: () => service,
      llmAvailable: () => true,
      emit: () => {},
      log: { debug: () => {}, info: () => {}, warn: () => {} },
    });

    // Preserve user-language scope suffix (English & Japanese) while normalizing localized prefixes.
    expect(normalizeRuleScope('subject:Biology')).toBe('subject:biology');
    expect(normalizeRuleScope('学科:Biology')).toBe('subject:biology');
    expect(normalizeRuleScope('mode:Exam Prep')).toBe('mode:exam prep');
    expect(normalizeRuleScope('subject:生物学')).toBe('subject:生物学');

    await callTool(executor, 'builtin-memory_rule_upsert', {
      instruction: 'Always answer with concise bullet points and end with 1 quick check.',
      scope: 'global',
      pinned: true,
    });
    await callTool(executor, 'builtin-memory_rule_upsert', {
      instruction: 'Highlight enzyme kinetics assumptions.',
      scope: 'subject:biochemistry',
      pinned: true,
    });

    const profileUpdate = emptyProfileUpdate();
    profileUpdate.preferences = {
      ...emptyPreferencesPatch(),
      explanation_style: 'Use real-world engineering analogies',
      language: 'English',
    };
    profileUpdate.recent_status = 'Preparing for organic chemistry midterm';
    service.applyProfileUpdate(profileUpdate, {
      source: 'tool_call',
      reason: 'seed English profile',
      limitPolicy: 'reject',
    });

    // Legacy VFS note in English preference folder
    service.getOrCreateRootFolder();
    service.write('Preferences', 'Study Background', 'Junior biomedical engineering student who prefers intuitive analogies', 'create');

    const snap = provider.buildSessionSnapshot({
      sessionId: 'sess_en_dark',
      memoryEnabled: true,
      subject: 'biochemistry',
    });
    expect(snap.renderedKernel).toContain('## Hard Interaction Rules');
    expect(snap.renderedKernel).toContain('[REQUIRED]');
    expect(snap.renderedKernel).toContain('[subject:biochemistry]');
    expect(snap.renderedKernel).toContain('## Long-Term Learner Profile');
    expect(snap.renderedKernel).toContain('## Recorded Core Memories & Interaction Preferences');
    expect(snap.renderedKernel).toContain('Precedence:');
    // Zero Chinese leakage inside rendered English kernel or prompt wrapper
    expect(snap.renderedKernel).not.toMatch(/[\u4e00-\u9fff]/);

    const built = new PromptBuilder(null).withMemoryKernel(snap.renderedKernel).buildSplit();
    const kernelBlock = built.stableSystem.slice(
      built.stableSystem.indexOf('<memory_kernel>'),
      built.stableSystem.indexOf('</memory_kernel>') + '</memory_kernel>'.length,
    );
    expect(kernelBlock).toContain(MEMORY_KERNEL_PACING_RULE_EN);
    expect(kernelBlock).not.toMatch(/[\u4e00-\u9fff]/);

    // Mid-session rule revocation emits language-neutral [REVOKED] delta
    const ruleId = service.loadHardRules().rules[0]!.id;
    provider.mutateFromUser({ kind: 'remove_rule', idOrInstruction: ruleId });
    const delta = provider.buildSessionDelta({ sessionId: 'sess_en_dark', memoryEnabled: true, subject: 'biochemistry' }, snap);
    expect(delta).not.toBeNull();
    expect(delta).toContain('[REVOKED - STOP IMMEDIATELY]');
    expect(delta).not.toMatch(/[\u4e00-\u9fff]/);

    // Japanese rules also stay free of Chinese markers
    const jpRendered = renderHardRules([{
      id: 'r_jp',
      instruction: '箇条書きで簡潔に答えてください',
      scope: 'subject:化学',
      origin: 'user_explicit',
      pinned: true,
      createdAt: '2026-11-25T00:00:00Z',
      updatedAt: '2026-11-25T00:00:00Z',
    }]);
    expect(jpRendered).toContain('## Hard Interaction Rules');
    expect(jpRendered).toContain('[REQUIRED]');
    expect(jpRendered).not.toContain('互动硬性规则');

    const jpDelta = buildHardRulesDelta([], ['r_jp'], '2026-11-25T00:00:00Z', [{
      id: 'r_jp',
      instruction: '箇条書きで簡潔に答えてください',
      scope: 'global',
    }]);
    expect(jpDelta).toContain('[REVOKED - STOP IMMEDIATELY]');
  });

  it('G01-1b: cascades L1 formatting override into L2 LearnerProfile (with rollback history), filters legacy notes, and returns active L2 preferences', async () => {
    const { host } = await setup();
    const service = serviceOf(host);
    const provider = providerOf(host);
    const executor = new MemoryToolExecutor({
      service: () => service,
      llmAvailable: () => true,
      emit: () => {},
      log: { debug: () => {}, info: () => {}, warn: () => {} },
    });

    // Seed L2 LearnerProfile with a table preference + an unrelated analogy preference + a compound style
    const initProfile = emptyProfileUpdate();
    initProfile.preferences = {
      ...emptyPreferencesPatch(),
      explanation_style: 'Use real-world analogies; prefer markdown tables for comparisons',
      language: 'English',
      others_add: ['Always format comparisons as markdown tables', 'Include one concrete clinical example'],
    };
    initProfile.recent_status = 'Studying pharmacokinetics';
    const seeded = service.applyProfileUpdate(initProfile, {
      source: 'tool_call',
      reason: 'seed initial L2 preferences',
      limitPolicy: 'reject',
    });
    expect(seeded.profile.version).toBe(1);

    // Seed both a contradicting legacy VFS note (tables) and a compatible legacy note (background)
    service.getOrCreateRootFolder();
    const tableLegacy = service.write('Preferences', 'Table Format', 'Always summarize concepts using markdown tables', 'create');
    const bgLegacy = service.write('Preferences', 'Major', 'Undergraduate pharmacy student who likes clinical examples', 'create');

    // Freeze Turn 1 snapshot before override
    const frozenTurn1 = provider.buildSessionSnapshot({ sessionId: 'sess_override', memoryEnabled: true });
    expect(frozenTurn1.renderedKernel).toContain('markdown tables');
    expect(frozenTurn1.includedLegacyNoteIds).toContain(tableLegacy.noteId);

    // Turn 2: user overrides formatting via memory_rule_upsert -> no tables, use bullets
    const upsertRes = await callTool(executor, 'builtin-memory_rule_upsert', {
      instruction: 'Never use tables; explain with concise bullet points instead.',
      scope: 'global',
      pinned: true,
    }, 'sess_override');
    const out = upsertRes.output as Record<string, any>;
    expect(out.success).toBe(true);
    expect(out.profile_reconciled).toBe(true);
    expect(out.superseded_profile_preferences.length).toBe(2);
    // Compound explanation_style retained the non-contradicting analogy clause!
    expect(out.active_profile_preferences.explanation_style).toBe('Use real-world analogies');
    expect(out.active_profile_preferences.others).toEqual(['Include one concrete clinical example']);
    expect(out.active_profile_preferences.language).toBe('English');

    // Persisted L2 profile was updated with history snapshot preserved for rollback
    const updatedProfile = service.loadProfile()!;
    expect(updatedProfile.version).toBe(2);
    expect(updatedProfile.preferences.explanation_style).toBe('Use real-world analogies');
    expect(updatedProfile.preferences.others).toEqual(['Include one concrete clinical example']);
    const history = service.loadProfileHistory();
    expect(history.map(h => h.version)).toEqual([2, 1]);

    // Same-session delta broadcasts both the new L1 rule and the superseded L2 preferences
    const delta = provider.buildSessionDelta({ sessionId: 'sess_override', memoryEnabled: true }, frozenTurn1);
    expect(delta).not.toBeNull();
    expect(delta).toContain('Never use tables; explain with concise bullet points instead.');
    expect(delta).toContain('SUPERSEDED PREFERENCE');

    // New session snapshot excludes the contradicted legacy table note while keeping compatible background note
    const nextSessionSnap = provider.buildSessionSnapshot({ sessionId: 'sess_next', memoryEnabled: true });
    expect(nextSessionSnap.renderedKernel).toContain('Never use tables; explain with concise bullet points instead.');
    expect(nextSessionSnap.renderedKernel).toContain('Use real-world analogies');
    expect(nextSessionSnap.renderedKernel).not.toContain('Always summarize concepts using markdown tables');
    expect(nextSessionSnap.renderedKernel).not.toContain('Always format comparisons as markdown tables');
    expect(nextSessionSnap.includedLegacyNoteIds).not.toContain(tableLegacy.noteId);
    expect(nextSessionSnap.includedLegacyNoteIds).toContain(bgLegacy.noteId);

    // One-click rollback restores v1 L2 profile cleanly
    const rolled = provider.mutateFromUser({ kind: 'rollback_profile', targetVersion: 1 });
    expect(rolled.learnerProfile.preferences.explanation_style).toContain('markdown tables');
    expect(rolled.learnerProfile.preferences.others).toContain('Always format comparisons as markdown tables');
    // Even after rollback, buildSessionSnapshot projection still suppresses the contradicted L2 table clause
    // because the L1 rule remains active!
    const snapAfterRollback = provider.buildSessionSnapshot({ sessionId: 'sess_post_rb', memoryEnabled: true });
    expect(snapAfterRollback.renderedKernel).not.toContain('Always format comparisons as markdown tables');
    expect(snapAfterRollback.renderedKernel).toContain('Use real-world analogies');
  });

  it('G01-1b: scoped L1 rule preserves global L2 preference for other subjects while overriding in matching subject', async () => {
    const { host } = await setup();
    const service = serviceOf(host);
    const provider = providerOf(host);

    const init = emptyProfileUpdate();
    init.preferences = { ...emptyPreferencesPatch(), explanation_style: 'Use markdown tables for summaries' };
    service.applyProfileUpdate(init, { source: 'handler', reason: 'seed', limitPolicy: 'reject' });

    provider.mutateFromUser({
      kind: 'upsert_rule',
      input: { instruction: 'Never use tables; write plain prose paragraphs.', scope: 'subject:history', pinned: true },
    });

    // Global L2 preference must remain intact because the L1 override was scoped to subject:history
    expect(service.loadProfile()!.preferences.explanation_style).toBe('Use markdown tables for summaries');

    // In history session, L1 rule is active and suppresses the contradicting L2 preference in the snapshot
    const historySnap = provider.buildSessionSnapshot({ sessionId: 's_hist', memoryEnabled: true, subject: 'history' });
    expect(historySnap.renderedKernel).toContain('Never use tables; write plain prose paragraphs.');
    expect(historySnap.renderedKernel).not.toContain('Use markdown tables for summaries');

    // In physics session, the history-scoped L1 rule is inactive so the global L2 preference still applies
    const physicsSnap = provider.buildSessionSnapshot({ sessionId: 's_phys', memoryEnabled: true, subject: 'physics' });
    expect(physicsSnap.renderedKernel).toContain('Use markdown tables for summaries');
  });

  it('G01-1c: prioritizes complete multi-part answering over brevity/formatting rules in both Chinese and non-Chinese kernels', async () => {
    expect(ruleCharLength(MEMORY_KERNEL_PACING_RULE)).toBeLessThanOrEqual(80);
    expect(MEMORY_KERNEL_PACING_RULE).toContain('完整性优先');
    expect(MEMORY_KERNEL_PACING_RULE).toContain('子问题');
    expect(MEMORY_KERNEL_PACING_RULE).not.toContain('控制总篇幅');

    expect(MEMORY_KERNEL_PACING_RULE_EN).toContain('answer every part and sub-question completely');
    expect(MEMORY_KERNEL_PACING_RULE_EN).toContain('memory rules govern per-part format, tone, and structure only');

    const enRendered = renderHardRules([{
      id: 'r1',
      instruction: 'Use concise bullets.',
      scope: 'global',
      origin: 'user_explicit',
      pinned: true,
      createdAt: '2026-11-25T00:00:00Z',
      updatedAt: '2026-11-25T00:00:00Z',
    }]);
    expect(enRendered).toContain('never omit any sub-question');

    const zhRendered = renderHardRules([{
      id: 'r2',
      instruction: '回答尽量精炼',
      scope: 'global',
      origin: 'user_explicit',
      pinned: true,
      createdAt: '2026-11-25T00:00:00Z',
      updatedAt: '2026-11-25T00:00:00Z',
    }]);
    expect(zhRendered).toContain('不得遗漏任何子问题');
  });
});
