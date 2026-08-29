import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { deepScholarSkill } from '../builtin/dstu-memory-orchestrator';
import { vfsMemorySkill } from '../builtin-tools/vfs-memory';

// Issue #90：普通知识问答（如"线性回归是什么？"）也必须按用户画像深度作答，
// 而不是只有用户写"根据我当前阶段"才检索记忆。
describe('profile auto-recall contract (issue #90)', () => {
  describe('deep-student skill prompt', () => {
    it('mandates recall for plain knowledge questions, not only personal ones', () => {
      expect(deepScholarSkill.content).toContain('普通知识/概念问答');
      expect(deepScholarSkill.content).toContain('线性回归是什么');
      expect(deepScholarSkill.content).toContain('即使用户**没有**提到"我的阶段/我的水平"');
    });

    it('narrows the skip-recall exception to pure greetings only', () => {
      expect(deepScholarSkill.content).toContain('唯一例外是纯寒暄');
      expect(deepScholarSkill.content).toContain('知识/概念提问**永远不算**简单问题');
      // 旧措辞允许模型把知识问答归为"极其简单"而跳过检索
      expect(deepScholarSkill.content).not.toContain('除非问题极其简单');
    });

    it('tells the model to include learner stage keywords in retrieval', () => {
      expect(deepScholarSkill.content).toContain('个人背景 学习阶段');
      expect(deepScholarSkill.content).toContain('学习阶段/水平/基础');
    });

    it('documents depth calibration against the injected learner profile', () => {
      expect(deepScholarSkill.content).toContain('画像深度校准');
      expect(deepScholarSkill.content).toContain('<learner_profile>');
      // 画像不含阶段身份事实 → 必须检索"偏好/个人背景"的 fact 记忆
      expect(deepScholarSkill.content).toContain('偏好/个人背景');
      expect(deepScholarSkill.content).toContain('不超纲');
      // 画像可能为空（新用户/记忆关闭/隐私模式）时的兜底
      expect(deepScholarSkill.content).toContain('画像可能为空');
    });

    it('keeps the retrieval tools available to the skill', () => {
      expect(deepScholarSkill.allowedTools).toContain('builtin-unified_search');
      expect(deepScholarSkill.allowedTools).toContain('builtin-memory_search');
      expect(deepScholarSkill.allowedTools).toContain('builtin-learner_profile_get');
    });
  });

  describe('vfs-memory skill prompt', () => {
    it('clarifies that auto-injection does not cover stage identity facts', () => {
      expect(vfsMemorySkill.content).toContain(
        '学习阶段/年级/专业方向等身份事实',
      );
      expect(vfsMemorySkill.content).toContain('偏好/个人背景');
      expect(vfsMemorySkill.content).toContain(
        '不要因为"画像已注入"就跳过检索',
      );
    });

    it('keeps the learner_profile_get description consistent with backend injection', () => {
      const tool = vfsMemorySkill.embeddedTools?.find(
        (candidate) => candidate.name === 'builtin-learner_profile_get',
      );
      expect(tool?.description).toContain('画像已随会话自动注入 system prompt');
    });
  });

  describe('backend injection source contract', () => {
    // vfs-memory 声称"画像已随会话自动注入 system prompt"——用源码契约钉住该事实，
    // 后端注入路径变化时此测试会失败，提醒同步更新技能提示词。
    const promptBuilderSource = readFileSync(
      resolve(process.cwd(), 'src-tauri/src/chat_v2/prompt_builder.rs'),
      'utf-8',
    );

    it('injects the learner profile block into the system prompt', () => {
      expect(promptBuilderSource).toContain('<learner_profile>');
      expect(promptBuilderSource).toContain('fn load_learner_profile_block');
      expect(promptBuilderSource).toContain(
        '.with_learner_profile(load_learner_profile_block(options))',
      );
    });

    it('skips injection when memory is disabled, so the profile block is conditional', () => {
      expect(promptBuilderSource).toContain(
        'if options.memory_enabled == Some(false)',
      );
    });
  });
});
