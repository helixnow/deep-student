import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ChatPipelineHooksRegistry, formatDeclarativeStudyPackPrompt } from '../src/pipeline-hooks.ts';
import { MEMORY_KERNEL_PACING_RULE, PromptBuilder } from '../src/prompt-builder.ts';
import { GradingRubricRegistry } from '../../llm/src/essay_grading/rubric-registry.ts';
import { ReviewSchedulerRegistry, DEFAULT_REVIEW_SCHEDULER_ID } from '../../review/src/scheduler-registry.ts';
import { checkManifest } from '../../../kernel/manifest.ts';
import { DeclarativeAssetRegistry, mountDeclarativeAssets } from '../../../kernel/declarative-loader.ts';

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

  it('mounts the real examples/plugins/kaoyan-math-pack Study Pack into rubrics + prompt extensions and cleans up cleanly', async () => {
    const packDir = fileURLToPath(new URL('../../../../examples/plugins/kaoyan-math-pack', import.meta.url));
    const pkg = JSON.parse(await readFile(`${packDir}/package.json`, 'utf8'));
    const checked = checkManifest(pkg, { appVersion: '0.20.9', context: 'community-startup', platform: 'desktop' });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;

    const registry = new DeclarativeAssetRegistry();
    const rubrics = new GradingRubricRegistry();
    const dispose = await mountDeclarativeAssets(checked.manifest, packDir, { registry, gradingRubrics: rubrics });

    expect(rubrics.get('example.kaoyan-math-pack:kaoyan-math-proof')?.name).toBe('考研数学证明题严格批改');
    expect(registry.listCardTemplates()).toHaveLength(1);
    const promptBlock = formatDeclarativeStudyPackPrompt(registry);
    expect(promptBlock).toContain('考研数学苏格拉底引导法');
    expect(promptBlock).toContain('/kaoyan-sprint');

    const built = new PromptBuilder(null).withPluginExtensions(promptBlock).buildSplit();
    expect(built.turnVolatile).toContain('<plugin_extensions>');
    expect(built.turnVolatile).toContain('考研数学苏格拉底引导法');

    dispose();
    expect(rubrics.get('example.kaoyan-math-pack:kaoyan-math-proof')).toBeNull();
    expect(formatDeclarativeStudyPackPrompt(registry)).toBeNull();
  });

  it('injects compact anti-truncation pacing guidance into <memory_kernel> only when non-empty and reinforces <memory_delta> (P3-3)', () => {
    const baseline = new PromptBuilder(null).buildSplit();
    const withEmptyKernel = new PromptBuilder(null).withMemoryKernel('   ').buildSplit();
    expect(withEmptyKernel.stableSystem).toBe(baseline.stableSystem);
    expect(baseline.stableSystem).not.toContain('<memory_kernel>');
    expect(baseline.stableSystem).not.toContain(MEMORY_KERNEL_PACING_RULE);

    expect([...MEMORY_KERNEL_PACING_RULE].length).toBeLessThanOrEqual(80);

    const kernelBody = '## 互动硬性规则（从第 1 轮起 100% 严格遵循）\n- [必遵] 每次回答结尾输出【30秒自测】 (id:r1)';
    const withKernel = new PromptBuilder(null).withMemoryKernel(kernelBody).buildSplit();
    expect(withKernel.stableSystem).toContain('<memory_kernel>');
    expect(withKernel.stableSystem).toContain(MEMORY_KERNEL_PACING_RULE);
    expect(withKernel.stableSystem).toContain('【30秒自测】');
    expect(withKernel.turnVolatile).toBeNull();

    const withDelta = new PromptBuilder(null)
      .withMemoryKernel(kernelBody)
      .withMemoryDelta('+ 新增/更新规则：结尾附 3 条要点清单 (id:r2)')
      .buildSplit();
    expect(withDelta.stableSystem).toBe(withKernel.stableSystem);
    expect(withDelta.turnVolatile).toContain('<memory_delta>');
    expect(withDelta.turnVolatile).toContain('勿中途截断');
    expect(withDelta.turnVolatile).toContain('结尾附 3 条要点清单');
  });
});
