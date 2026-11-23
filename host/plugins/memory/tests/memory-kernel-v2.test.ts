import { afterEach, describe, expect, it } from 'vitest';
import { setupMemoryHost, type MemoryHost } from './support.ts';
import type { MemoryServiceImpl } from '../src/service.ts';
import type { MemoryInspectionView, MemoryProvider } from '../api.ts';
import { MemoryToolExecutor } from '../src/memory-tool-executor.ts';
import type { ExecutionContext, ToolExecutor } from '../../chat/api.ts';
import { PromptBuilder } from '../../chat-pipeline/src/prompt-builder.ts';
import { PROFILE_HISTORY_KEEP, emptyProfileUpdate } from '../src/learner-profile.ts';

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
    expect(snap.renderedKernel).toContain('以后每次回答结束后都给我 1 道自测题');
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
});
