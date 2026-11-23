import { describe, expect, it, vi } from 'vitest';
import { ChatPipelineHooksRegistry } from '../src/pipeline-hooks.ts';
import { PromptBuilder } from '../src/prompt-builder.ts';
import { GradingRubricRegistry } from '../../llm/src/essay_grading/rubric-registry.ts';
import { ReviewSchedulerRegistry, DEFAULT_REVIEW_SCHEDULER_ID } from '../../review/src/scheduler-registry.ts';

describe('RFC-002 P2: Native Cordis Core Hook & Provider Registries', () => {
  it('chatPipelineHooks orders hooks by priority, isolates crashes/timeouts, and renders <plugin_extensions>', async () => {
    const warnings: string[] = [];
    const hooks = new ChatPipelineHooksRegistry(msg => warnings.push(msg));
    const afterEvents: string[] = [];

    const disposeBad = hooks.register('acme.buggy', {
      name: 'crash-hook',
      priority: 10,
      augmentSystemPrompt: () => { throw new Error('boom'); },
      afterReply: () => { throw new Error('after-boom'); },
    });
    const disposeSlow = hooks.register('acme.slow', {
      name: 'slow-hook',
      priority: 15,
      timeoutMs: 100,
      augmentSystemPrompt: () => new Promise(resolve => setTimeout(() => resolve('too late'), 400)),
    });
    const disposeGood = hooks.register('acme.socratic', {
      name: 'proof-guard',
      priority: 20,
      augmentSystemPrompt: ({ userContent }) => userContent.includes('证明') ? '请强制分步验证每个引理前提' : null,
      afterReply: ({ messageId }) => { afterEvents.push(messageId); },
    });

    const ext = await hooks.runAugmentSystemPrompt({ sessionId: 's1', mode: 'chat', userContent: '帮我证明中值定理' });
    expect(ext).toContain('[acme.socratic:proof-guard]');
    expect(ext).toContain('请强制分步验证每个引理前提');
    expect(warnings.some(w => w.includes('acme.buggy/crash-hook'))).toBe(true);
    expect(warnings.some(w => w.includes('acme.slow/slow-hook'))).toBe(true);

    const built = new PromptBuilder(null).withPluginExtensions(ext).buildSplit();
    expect(built.turnVolatile).toContain('<plugin_extensions>');
    expect(built.turnVolatile).toContain('请强制分步验证每个引理前提');

    await hooks.runAfterReply({
      sessionId: 's1', messageId: 'm1', userContent: 'q', assistantContent: 'a', durationMs: 120,
    });
    expect(afterEvents).toEqual(['m1']);

    disposeBad();
    disposeSlow();
    disposeGood();
    expect(hooks.list()).toEqual([]);
  });

  it('gradingRubrics registers custom essay rubrics dynamically and cleans up on dispose', () => {
    const registry = new GradingRubricRegistry();
    const dispose = registry.register('acme.kaoyan', {
      id: 'kaoyan_english_1',
      name: '考研英语一大作文',
      description: '按考研英语一 20 分制分档评分',
      systemPrompt: '请按考研英语一大作文标准逐段评分',
      scoreDimensions: [
        { name: '内容切题', maxScore: 8, description: '图画寓意准确' },
        { name: '语言表达', maxScore: 8, description: '词汇与句式丰富度' },
        { name: '结构衔接', maxScore: 4, description: '三段式逻辑连贯' },
      ],
      totalMaxScore: 20,
    });

    expect(registry.list()).toHaveLength(1);
    expect(registry.get('kaoyan_english_1')?.name).toBe('考研英语一大作文');
    expect(registry.listProviders()).toEqual([
      { pluginId: 'acme.kaoyan', modeId: 'kaoyan_english_1', name: '考研英语一大作文' },
    ]);

    dispose();
    expect(registry.list()).toHaveLength(0);
    expect(registry.get('kaoyan_english_1')).toBeNull();
  });

  it('reviewSchedulers activates custom schedulers and falls back to fsrs6 on error or dispose', () => {
    const warn = vi.fn();
    const schedulers = new ReviewSchedulerRegistry(warn);
    expect(schedulers.getActiveId()).toBe(DEFAULT_REVIEW_SCHEDULER_ID);

    const disposeCram = schedulers.register('acme.cram', {
      id: 'exam_cram_v1',
      displayName: '考前 7 天冲刺调度器',
      description: '压缩复习间隔至 3 天以内',
      nextState: ({ rating }) => ({
        intervalDays: rating <= 2 ? 1 : 2,
        stability: 2,
        difficulty: 5,
      }),
    });

    expect(schedulers.setActive('exam_cram_v1')).toBe(true);
    const cramResult = schedulers.computeNextState({
      cardId: 'c1', stability: 4, difficulty: 5, elapsedDays: 2, reps: 3, lapses: 0, rating: 3,
    });
    expect(cramResult.schedulerId).toBe('exam_cram_v1');
    expect(cramResult.state.intervalDays).toBe(2);
    expect(cramResult.fellBack).toBe(false);

    // Faulty scheduler must fall back cleanly to built-in fsrs6
    const disposeBad = schedulers.register('acme.broken', {
      id: 'broken_sched',
      displayName: 'Broken',
      description: 'Always throws',
      nextState: () => { throw new Error('NaN overflow'); },
    });
    expect(schedulers.setActive('broken_sched')).toBe(true);
    const fallbackResult = schedulers.computeNextState({
      cardId: 'c1', stability: 4, difficulty: 5, elapsedDays: 2, reps: 3, lapses: 0, rating: 3,
    });
    expect(fallbackResult.schedulerId).toBe(DEFAULT_REVIEW_SCHEDULER_ID);
    expect(fallbackResult.fellBack).toBe(true);
    expect(warn).toHaveBeenCalled();

    // Disposing active custom scheduler reverts activeId to fsrs6 automatically
    disposeBad();
    expect(schedulers.getActiveId()).toBe(DEFAULT_REVIEW_SCHEDULER_ID);
    disposeCram();
  });
});
