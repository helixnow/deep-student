// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  ContextUsageRing,
  estimateContextUsageTokens,
  formatCompactTokens,
  formatContextUsageSummary,
  resolveContextUsageLevel,
} from '@/features/chat/components/ContextUsageRing';
import {
  STEER_INTERRUPT_REASON,
  StreamingFollowupController,
  buildTurnInterruptMetadata,
  resolveFollowupKeyMode,
} from '@/features/chat/utils/streamingInputQueueSteer';
import {
  COVER_HEIGHT,
  COVER_WIDTH,
  GOLDEN_ANGLE_DEG,
  computeTitleCoverPalette,
  layoutTextCoverLines,
  renderProceduralTextCoverDataUrl,
  renderTextCoverSvg,
  tokenizeCjkAndLatin,
} from '@/features/learning-hub/utils/proceduralTextCover';
import {
  MAX_FEEDBACK_JSON_DEPTH,
  acceptsWidgetFeedbackUpdate,
  buildQuizWidgetAnswerFeedback,
  readWidgetAnswerFeedback,
  validateWidgetAnswerFeedbackEnvelope,
} from '@/features/learning-hub/utils/widgetAnswerFeedback';
import {
  buildSessionDraftCompositeKey, parseSessionDraftCompositeKey, SessionDraftLruStore,
  DoubleEscapeStopGuard, LargeTextPasteController, preemptFloatingBlockingRequestsOnSend,
} from '@/features/chat/components/input-bar/composerOpenChamberEnhancements';
import { ParkedSessionViewManager } from '../modelListCacheAndResume';
import { computePromptCacheHitRate } from '../promptCacheAndTurnCompaction';
import { computeTurnTelemetryBreakdown, resolveSessionSidebarActivityState, type SessionActivity } from '../sidebarHierarchyAndTelemetry';
import { AgentCoEditHistoryManager } from '@/features/learning-hub/utils/mdLivePreviewAndAgentCoEdit';
import { buildStudyHeatmap } from '@/features/learning-hub/utils/studyTimeTrackerAndHeatmap';

describe('wave6 runtime state and editing regressions', () => {
  it('keeps failed queue heads and retries ahead of newer submissions', async () => {
    const onSendTurn = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const controller = new StreamingFollowupController({ onSendTurn, onAnswerAsk: () => {} });
    controller.enqueue({ text: 'old' });
    await expect(controller.drainQueue()).rejects.toThrow('offline');
    expect(controller.getSnapshot()).toMatchObject({ isStreaming: false, queuedItems: [{ text: 'old' }] });
    await controller.submit({ text: 'new' });
    expect(onSendTurn.mock.calls.map(([turn]) => turn.text)).toEqual(['old', 'old']);
    expect(controller.getSnapshot().queuedItems.map((item) => item.text)).toEqual(['new']);
    await controller.onTurnSettled();
    expect(onSendTurn.mock.calls.map(([turn]) => turn.text)).toEqual(['old', 'old', 'new']);
  });

  it('loads database history even after a background patch, and retries failed hydration cleanly', async () => {
    const manager = new ParkedSessionViewManager('a', () => ({ messages: [] as string[], running: false }));
    manager.writeView('b', { running: true });
    const load = vi.fn(async () => ({ messages: ['history'], running: false }));
    expect(await manager.switchSession('b', load)).toEqual({ messages: ['history'], running: true });
    manager.writeView('c', { messages: ['temporary'] });
    await expect(manager.switchSession('c', async () => { throw new Error('database offline'); })).rejects.toThrow();
    expect(manager.readView('c').messages).toEqual([]);
    expect(await manager.switchSession('c', load)).toEqual({ messages: ['history'], running: false });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not dismiss any approvals or forms when the target session is unknown', () => {
    const result = preemptFloatingBlockingRequestsOnSend({
      sessionId: null,
      pendingApprovals: [{ id: 'a', sessionId: 'other' }],
      pendingForms: [{ id: 'f', sessionId: 'other' }],
    });
    expect(result.dismissedApprovals).toEqual([]);
    expect(result.dismissedForms).toEqual([]);
    expect(result.remainingApprovals).toHaveLength(1);
    expect(result.remainingForms).toHaveLength(1);
  });

  it('invalidates a pending paste after an external document change', () => {
    const controller = new LargeTextPasteController({ initialText: 'before', charThreshold: 4 });
    controller.handlePaste('large paste');
    expect(controller.hasPendingPaste()).toBe(true);
    controller.setDocumentState('user edited');
    expect(controller.hasPendingPaste()).toBe(false);
    expect(controller.getDocumentText()).toBe('user edited');
  });

  it('ignores held Escape repeat events without consuming the initial press', () => {
    const guard = new DoubleEscapeStopGuard();
    expect(guard.handleEscape({ nowMs: 1 }).armed).toBe(true);
    expect(guard.handleEscape({ nowMs: 2, repeat: true }).shouldStop).toBe(false);
    expect(guard.handleEscape({ nowMs: 3 }).shouldStop).toBe(true);
    guard.reset();
    expect(guard.handleEscape({ nowMs: 4, repeat: true }).armed).toBe(false);
  });

  it('round-trips delimiter-containing draft keys and evicts by last write, even across hydration', () => {
    const identity = { runtimeKey: 'local::runtime', directory: '/path::part/%value', sessionIdOrWorkDraftKey: 'session::id' };
    expect(parseSessionDraftCompositeKey(buildSessionDraftCompositeKey(identity))).toEqual(identity);
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
    const store = new SessionDraftLruStore({ maxEntries: 2, storage, now: () => 100 });
    store.setDraft(identity, { text: 'first', updatedAtMs: 500 });
    expect(store.getDraft(buildSessionDraftCompositeKey(identity))?.text).toBe('first');
    store.setDraft('b', { text: 'second', updatedAtMs: 500 });
    store.setDraft(identity, { text: 'latest', updatedAtMs: 1 });
    const restored = new SessionDraftLruStore({ maxEntries: 2, storage });
    restored.setDraft('c', { text: 'third', updatedAtMs: 0 });
    expect(restored.getDraft('b')).toBeNull();
    expect(restored.getDraft(identity)?.text).toBe('latest');
  });

  it('uses current feedback timestamps and permits pending-to-final transitions at the same timestamp', () => {
    const result = buildQuizWidgetAnswerFeedback({ attemptId: 'a', question: { stem: 'object', answer: { a: 1, b: [2, { c: 3 }] } }, userAnswer: { b: [2, { c: 3 }], a: 1 } });
    expect(result?.status).toBe('correct');
    expect(result?.updatedAt).toBeGreaterThan(0);
    const current = { attemptId: 'a', updatedAt: 1, status: 'pending' as const };
    expect(acceptsWidgetFeedbackUpdate(current, { ...current, status: 'correct' }).ok).toBe(true);
    expect(acceptsWidgetFeedbackUpdate(current, current).ok).toBe(false);
    expect(acceptsWidgetFeedbackUpdate({ ...current, status: 'correct' }, { ...current, updatedAt: 2 }).ok).toBe(false);
    const wrong = buildQuizWidgetAnswerFeedback({ attemptId: 'a', question: { stem: 'array', answer: [1, 2] }, userAnswer: [2, 1] });
    expect(wrong?.status).toBe('incorrect');
  });

  it('checks both context anchors around deletions, including empty-document boundaries', () => {
    for (const changed of ['ZZZCCC', 'AAAZZZ', 'PREFIXAAACCC']) {
      const manager = new AgentCoEditHistoryManager('AAABBBCCC');
      manager.applyAgentEdits([{ old_string: 'BBB', new_string: '' }]);
      expect(manager.isLastAgentBatchIntact()).toBe(true);
      manager.applyUserEdit(changed);
      expect(manager.undoLastAgentEdit().ok).toBe(false);
      expect(manager.getMarkdown()).toBe(changed);
    }
    const manager = new AgentCoEditHistoryManager('all');
    manager.applyAgentEdits([{ old_string: 'all', new_string: '' }]);
    manager.applyUserEdit('user');
    expect(manager.undoLastAgentEdit().ok).toBe(false);
  });

  it('publishes the committed agent state before invoking rechunk callbacks', () => {
    let observed = '';
    const manager = new AgentCoEditHistoryManager('before', { onRechunkMaterialBlocks: () => { observed = manager.getMarkdown(); } });
    manager.applyAgentEdits([{ old_string: 'before', new_string: 'after' }]);
    expect(observed).toBe('after');
  });

  it('clamps cache measurements to fractions and rejects nonfinite heatmap week counts', () => {
    expect(computePromptCacheHitRate([{ inputTokens: 10, cacheReadInputTokens: 20 }])).toBe(1);
    expect(computeTurnTelemetryBreakdown({ input: -5, cacheRead: 10 }).cacheHitRate).toBe(1);
    expect(computeTurnTelemetryBreakdown({ input: 10, cacheRead: -5 }).cacheHitRate).toBe(0);
    for (const weeks of [NaN, Infinity, -Infinity]) {
      expect(buildStudyHeatmap({ today: '2026-11-09', weeks, seconds: new Map() }).weeks).toHaveLength(1);
    }
  });

  it.each(['evaluatingGoal', 'runningMain', 'runningShell', 'zombie', 'unread'] as const)('does not bubble nonblocking child %s', (flag) => {
    const sessions = new Map<string, SessionActivity>([['p', { id: 'p' }], ['c', { id: 'c', parentId: 'p', [flag]: true }]]);
    expect(resolveSessionSidebarActivityState('p', sessions).state).toBe('idle');
    sessions.set('c', { id: 'c', parentId: 'p', waitingSecret: true });
    expect(resolveSessionSidebarActivityState('p', sessions).state).toBe('waiting_input');
  });
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (
      _key: string,
      defaultVal?: string | Record<string, unknown>,
      options?: Record<string, unknown>,
    ) => {
      const template = typeof defaultVal === 'string' ? defaultVal : _key;
      const vars =
        (typeof defaultVal === 'object' ? defaultVal : options) ?? {};
      return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) =>
        vars[k] !== undefined ? String(vars[k]) : '',
      );
    },
  }),
}));

describe('StreamingFollowupController (Queue vs Steer state machine)', () => {
  it('enforces Invariant 1: pendingAsk takes absolute priority over both queue and steer', async () => {
    const answered: string[] = [];
    const sent: Array<{ text: string; mode: string }> = [];
    let draftCleared = 0;

    const controller = new StreamingFollowupController({
      onAnswerAsk: (text) => {
        answered.push(text);
      },
      onSendTurn: (payload) => {
        sent.push({ text: payload.text, mode: payload.mode });
      },
      onClearDraft: () => {
        draftCleared += 1;
      },
    });

    controller.beginTurn();
    controller.setPendingAsk(true);

    const r1 = await controller.submit({ text: '选 B 方案', mode: 'queue' });
    const r2 = await controller.submit({ text: '选 C 方案', mode: 'steer' });

    expect(r1.routedTo).toBe('answerAsk');
    expect(r2.routedTo).toBe('answerAsk');
    expect(answered).toEqual(['选 B 方案', '选 C 方案']);
    expect(sent).toHaveLength(0);
    expect(controller.getSnapshot().queuedItems).toHaveLength(0);
    expect(draftCleared).toBe(2);
  });

  it('enforces Invariant 2: queues inputs during streaming, supports edit/remove/promote, and drains on settle', async () => {
    const sent: Array<{ text: string; mode: string; fromQueueId?: string }> = [];
    const aborted: string[] = [];

    const controller = new StreamingFollowupController({
      onAnswerAsk: () => {},
      onSendTurn: (payload) => {
        sent.push(payload);
      },
      onAbortCurrentTurn: (intent) => {
        aborted.push(intent);
      },
    });

    // 启动首轮生成
    const initial = await controller.submit({ text: '第一问' });
    expect(initial.routedTo).toBe('sent');
    expect(controller.getSnapshot().isStreaming).toBe(true);

    // 流式期间默认 queue
    const q1 = await controller.submit({ text: '排队问题一' });
    const q2 = await controller.submit({ text: '排队问题二' });
    const q3 = await controller.submit({ text: '排队问题三' });

    expect(q1.routedTo).toBe('enqueued');
    expect(q2.routedTo).toBe('enqueued');
    expect(q3.routedTo).toBe('enqueued');
    expect(controller.getSnapshot().queuedItems).toHaveLength(3);

    // 按 ID 编辑：修改文本
    controller.updateQueuedItem(q1.item!.id, '排队问题一（已改）');
    expect(controller.getSnapshot().queuedItems[0].text).toBe('排队问题一（已改）');

    // 按 ID 编辑为空白字符串 = 自动删除
    controller.updateQueuedItem(q2.item!.id, '   ');
    expect(controller.getSnapshot().queuedItems.map((i) => i.id)).toEqual([
      q1.item!.id,
      q3.item!.id,
    ]);

    // 当前轮即使被用户点击停止（stop），收尾后依然自动弹出队首发送
    controller.stopCurrentTurn();
    expect(aborted).toEqual(['stop']);

    const settleMeta = await controller.onTurnSettled();
    expect(settleMeta.appendStoppedSuffix).toBe(true);
    expect(settleMeta.interrupted).toBe(false);

    // 队首 q1 已被自动弹出并作为新轮发送，队列仅剩 q3
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({
      text: '排队问题一（已改）',
      mode: 'queue',
      fromQueueId: q1.item!.id,
    });
    expect(controller.getSnapshot().queuedItems.map((i) => i.id)).toEqual([
      q3.item!.id,
    ]);

    // 将 q3 立即提升为插入（promoteQueuedItemToSteer）
    const promotePromise = controller.promoteQueuedItemToSteer(q3.item!.id);
    // 提升时会先出队再触发 steer 中断当前轮
    expect(controller.getSnapshot().queuedItems).toHaveLength(0);
    expect(controller.getSnapshot().turnIntent).toBe('steer');

    await controller.onTurnSettled({ skipDrain: true });
    const promoteResult = await promotePromise;
    expect(promoteResult.routedTo).toBe('steered');
    expect(sent[2]).toMatchObject({
      text: '排队问题三',
      mode: 'steer',
      fromQueueId: q3.item!.id,
    });
  });

  it('enforces Invariant 3: steer sets turnIntent before abort, awaits inflightDone, and degrades to queue on race', async () => {
    const events: string[] = [];
    let observedIntentAtAbort: string | null = null;

    const controller = new StreamingFollowupController({
      onAnswerAsk: () => {},
      onSendTurn: (payload) => {
        events.push(`send:${payload.mode}:${payload.text}`);
      },
      onAbortCurrentTurn: (intent) => {
        observedIntentAtAbort = controller.getSnapshot().turnIntent;
        events.push(`abort:${intent}`);
      },
    });

    await controller.submit({ text: '原始长回答请求' });
    expect(controller.getSnapshot().isStreaming).toBe(true);

    // 发起两条并发 steer：第一条抢到新一轮，第二条在醒来时发现 isStreaming=true 必须降级入队而不丢消息
    const steer1Promise = controller.submit({
      text: '打断插入 A',
      mode: 'steer',
    });
    const steer2Promise = controller.submit({
      text: '并发插入 B',
      mode: 'steer',
    });

    expect(observedIntentAtAbort).toBe('steer');
    expect(buildTurnInterruptMetadata('steer')).toEqual({
      interrupted: true,
      interruptReason: STEER_INTERRUPT_REASON,
      appendStoppedSuffix: false,
    });

    // 释放第一轮 inflightDone
    const meta = await controller.onTurnSettled({ skipDrain: true });
    expect(meta.interrupted).toBe(true);
    expect(meta.interruptReason).toBe(STEER_INTERRUPT_REASON);

    const [res1, res2] = await Promise.all([steer1Promise, steer2Promise]);
    expect(res1.routedTo).toBe('steered');
    expect(res2.routedTo).toBe('enqueued');
    expect(controller.getSnapshot().queuedItems.map((i) => i.text)).toEqual([
      '并发插入 B',
    ]);
  });

  it('maps Enter and Ctrl/Cmd+Enter keybindings accurately', () => {
    expect(resolveFollowupKeyMode({ key: 'Enter' }, 'queue')).toBe('queue');
    expect(
      resolveFollowupKeyMode({ key: 'Enter', ctrlKey: true }, 'queue'),
    ).toBe('steer');
    expect(
      resolveFollowupKeyMode({ key: 'Enter', metaKey: true }, 'queue'),
    ).toBe('steer');
    expect(
      resolveFollowupKeyMode({ key: 'Enter', shiftKey: true }, 'queue'),
    ).toBeNull();
    expect(
      resolveFollowupKeyMode({ key: 'Enter', isComposing: true }, 'queue'),
    ).toBeNull();
  });
});

describe('ContextUsageRing & estimateContextUsageTokens', () => {
  it('formats ≈32.5k / 128k (25%) and classifies normal / warn / danger levels', () => {
    expect(formatCompactTokens(32500)).toBe('32.5k');
    expect(formatCompactTokens(128000)).toBe('128k');
    expect(formatContextUsageSummary(32500, 128000)).toBe('≈32.5k / 128k (25%)');

    expect(resolveContextUsageLevel(0.7)).toBe('normal');
    expect(resolveContextUsageLevel(0.71)).toBe('warn');
    expect(resolveContextUsageLevel(0.9)).toBe('warn');
    expect(resolveContextUsageLevel(0.91)).toBe('danger');

    const est = estimateContextUsageTokens({
      systemPrompt: 'a'.repeat(1000),
      skillMetaBlock: 'b'.repeat(500),
      historyContents: ['c'.repeat(2000), 'd'.repeat(1500)],
      draftText: 'e'.repeat(100),
      maxWindowTokens: 10000,
    });
    expect(est.usedTokens).toBe(700 + 350 + 1400 + 1050 + 70);
    expect(est.level).toBe('normal');
  });

  it('renders ContextUsageRing with tabular-nums summary, level attributes, and popover details', () => {
    const handleCompress = vi.fn();
    const { rerender } = render(
      <ContextUsageRing
        usedTokens={32500}
        maxWindowTokens={128000}
        showInlineSummary
        onCompress={handleCompress}
      />,
    );

    const trigger = screen.getByTestId('context-usage-ring');
    expect(trigger.getAttribute('data-level')).toBe('normal');
    expect(trigger.getAttribute('aria-label')).toContain('≈32.5k / 128k (25%)');

    const inlineSummary = screen.getByTestId('context-usage-ring-summary');
    expect(inlineSummary.textContent).toBe('≈32.5k / 128k (25%)');
    expect(inlineSummary.className).toContain('font-mono');
    expect(inlineSummary.className).toContain('tabular-nums');

    // 切换至 warn (> 70%) 与 danger (> 90%)
    rerender(
      <ContextUsageRing
        usedTokens={102400}
        maxWindowTokens={128000}
        showInlineSummary
        onCompress={handleCompress}
      />,
    );
    expect(screen.getByTestId('context-usage-ring').getAttribute('data-level')).toBe('warn');

    rerender(
      <ContextUsageRing
        usedTokens={120000}
        maxWindowTokens={128000}
        showInlineSummary
        onCompress={handleCompress}
      />,
    );
    expect(screen.getByTestId('context-usage-ring').getAttribute('data-level')).toBe('danger');

    fireEvent.click(screen.getByTestId('context-usage-ring'));
    expect(screen.getByTestId('context-usage-ring-popover')).toBeTruthy();

    fireEvent.click(screen.getByTestId('context-usage-ring-compress'));
    expect(handleCompress).toHaveBeenCalledTimes(1);
  });
});

describe('proceduralTextCover (Golden-Angle CJK Text Cover Generator)', () => {
  it('tokenizes CJK char-by-char and preserves spaces between Latin words', () => {
    const tokens = tokenizeCjkAndLatin('分布式Distributed Systems：一致性');
    expect(tokens).toEqual([
      '分',
      '布',
      '式',
      'Distributed',
      ' ',
      'Systems',
      '：',
      '一',
      '致',
      '性',
    ]);
  });

  it('computes deterministic Golden-Angle (137.507764°) dark palette with white text', () => {
    expect(GOLDEN_ANGLE_DEG).toBe(137.507764);
    const p1 = computeTitleCoverPalette('线性代数笔记');
    const p2 = computeTitleCoverPalette('线性代数笔记');
    const p3 = computeTitleCoverPalette('微积分导论');

    expect(p1).toEqual(p2);
    expect(p1.hue).toBeGreaterThanOrEqual(0);
    expect(p1.hue).toBeLessThan(360);
    expect(p1.hue).not.toBe(p3.hue);
    expect(p1.lightnessStart).toBe(30);
    expect(p1.lightnessEnd).toBe(22);
    expect(p1.titleColor).toBe('#ffffff');
  });

  it('wraps CJK & Latin lines within 480x270 layout and outputs offline SVG Data URL', () => {
    const layout = layoutTextCoverLines(
      '深入理解计算机系统 CSAPP 核心章节复习笔记与实验总结超长标题测试自动折行与省略号截断',
      '本章涵盖虚拟内存、异常控制流、系统级 I/O 以及并发编程的重点概念梳理，帮助快速回顾核心考点。'.repeat(
        3,
      ),
    );

    expect(layout.width).toBe(COVER_WIDTH);
    expect(layout.height).toBe(COVER_HEIGHT);
    expect(layout.titleLines.length).toBeLessThanOrEqual(2);
    expect(layout.titleLines.at(-1)?.endsWith('…')).toBe(true);
    expect(layout.previewLines.length).toBeLessThanOrEqual(3);
    expect(layout.previewLines.at(-1)?.endsWith('…')).toBe(true);
    expect(layout.hasDivider).toBe(true);

    const svg = renderTextCoverSvg({
      title: '编译原理',
      preview: '词法分析与语法分析器构造',
    });
    expect(svg).toContain('viewBox="0 0 480 270"');
    expect(svg).toContain('编译原理');

    const dataUrl = renderProceduralTextCoverDataUrl({
      title: '编译原理',
      preview: '词法分析与语法分析器构造',
    });
    expect(dataUrl.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
  });
});

describe('validateWidgetAnswerFeedbackEnvelope (Widget Answer Feedback v1)', () => {
  const validHostEnvelope = {
    version: 1 as const,
    attemptId: 'attempt-001',
    status: 'correct' as const,
    answer: 0,
    correctAnswer: 0,
    explanation: '选项 A 符合定义。',
    grading: 'host' as const,
    authoritative: true,
    updatedAt: 100,
  };

  it('accepts valid v1 authoritative host feedback and rejects malformed or oversized payloads', () => {
    const res = validateWidgetAnswerFeedbackEnvelope(validHostEnvelope);
    expect(res.ok).toBe(true);
    expect(res.envelope?.attemptId).toBe('attempt-001');
    expect(res.envelope?.status).toBe('correct');

    // 拒绝未知字段、非法版本、超长解释、超大字节
    expect(
      validateWidgetAnswerFeedbackEnvelope({ ...validHostEnvelope, extra: 1 }).ok,
    ).toBe(false);
    expect(
      validateWidgetAnswerFeedbackEnvelope({ ...validHostEnvelope, version: 2 })
        .ok,
    ).toBe(false);
    expect(
      validateWidgetAnswerFeedbackEnvelope({
        ...validHostEnvelope,
        explanation: 'x'.repeat(16001),
      }).ok,
    ).toBe(false);
    expect(
      validateWidgetAnswerFeedbackEnvelope({
        ...validHostEnvelope,
        answer: '图'.repeat(12000),
      }).ok,
    ).toBe(false);

    // 拒绝超过 JSON 最大深度 (16) 的嵌套结构
    let deepNode: unknown = 'leaf';
    for (let i = 0; i < MAX_FEEDBACK_JSON_DEPTH + 2; i++) {
      deepNode = { nested: deepNode };
    }
    expect(
      validateWidgetAnswerFeedbackEnvelope({
        ...validHostEnvelope,
        answer: deepNode,
      }).errorCode,
    ).toBe('JSON_LIMIT_EXCEEDED');
  });

  it('distinguishes authoritative host grading from non-authoritative AI reference feedback', () => {
    // AI 判分绝不能标为 authoritative: true
    expect(
      validateWidgetAnswerFeedbackEnvelope({
        ...validHostEnvelope,
        grading: 'ai',
        authoritative: true,
      }).errorCode,
    ).toBe('AUTHORITY_MISMATCH');

    // 非权威反馈绝不能伪装成 correct / incorrect / partial
    expect(
      validateWidgetAnswerFeedbackEnvelope({
        ...validHostEnvelope,
        grading: 'ai',
        authoritative: false,
        status: 'correct',
      }).errorCode,
    ).toBe('AUTHORITY_MISMATCH');

    // 宿主客观题 vs AI 参考题构建器校验
    const hostResult = buildQuizWidgetAnswerFeedback({
      attemptId: 'q-1',
      question: {
        stem: '1 + 1 = ?',
        options: ['1', '2'],
        answer: 1,
        explanation: '基础加法',
      },
      userAnswer: 1,
      updatedAt: 10,
    });
    expect(hostResult?.authoritative).toBe(true);
    expect(hostResult?.status).toBe('correct');

    const aiRefResult = buildQuizWidgetAnswerFeedback({
      attemptId: 'q-2',
      question: {
        stem: '简述进程与线程的区别',
        type: 'freeform',
        answer: '进程是资源分配的基本单位',
        answerSource: 'ai',
      },
      userAnswer: '线程是调度的基本单位',
      updatedAt: 20,
    });
    expect(aiRefResult?.authoritative).toBe(false);
    expect(aiRefResult?.status).toBe('pending');
    expect(aiRefResult?.grading).toBe('ai');
  });

  it('enforces attemptId binding and strictly monotonic updatedAt ordering', () => {
    const initial = readWidgetAnswerFeedback(validHostEnvelope)!;

    // 拒绝不同 attemptId 串台
    expect(
      validateWidgetAnswerFeedbackEnvelope(
        { ...validHostEnvelope, attemptId: 'attempt-other', updatedAt: 200 },
        { currentEnvelope: initial },
      ).errorCode,
    ).toBe('ATTEMPT_ID_MISMATCH');

    // 拒绝相同或更旧的 updatedAt
    expect(
      validateWidgetAnswerFeedbackEnvelope(
        { ...validHostEnvelope, updatedAt: 100, status: 'partial' },
        { currentEnvelope: initial },
      ).errorCode,
    ).toBe('STALE_TIMESTAMP');

    // 拒绝从已判定状态倒退回 pending
    expect(
      validateWidgetAnswerFeedbackEnvelope(
        {
          ...validHostEnvelope,
          updatedAt: 200,
          status: 'pending',
          authoritative: false,
          grading: 'ai',
        },
        { currentEnvelope: initial },
      ).errorCode,
    ).toBe('STATUS_REGRESSION');

    // 允许同一 attemptId 且 updatedAt 严格递增的状态更新
    const updated = validateWidgetAnswerFeedbackEnvelope(
      { ...validHostEnvelope, updatedAt: 200, status: 'partial' },
      { currentEnvelope: initial },
    );
    expect(updated.ok).toBe(true);
    expect(updated.envelope?.status).toBe('partial');
  });
});
