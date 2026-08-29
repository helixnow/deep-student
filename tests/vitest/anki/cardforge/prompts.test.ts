import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

import {
  PromptKit,
  buildCardGenerationSystemPrompt,
  buildContentAnalysisPrompt,
} from '@/components/anki/cardforge/prompts';
import type { TemplateInfo } from '@/components/anki/cardforge/types';

const LEGACY_START_MARKER = '<<<ANKI_CARD_JSON_START>>>';
const END_MARKER = '<<<ANKI_CARD_JSON_END>>>';

/**
 * 跨层契约 fixture：Rust 侧 streaming_anki_service 的
 * cardagent_real_options_full_request_has_single_protocol_source 用同一份
 * 文本作为 custom_anki_prompt 组装完整请求消息。两侧必须逐字一致。
 */
const CROSS_LAYER_FIXTURE_PATH = path.resolve(
  __dirname,
  '../../../../src-tauri/tests/fixtures/cardagent_system_prompt.txt'
);

const mockTemplate: TemplateInfo = {
  id: 'basic',
  name: 'Basic',
  description: 'Basic template',
  category: 'general',
  fields: ['front', 'back', 'tags'],
  noteType: 'Basic',
  isActive: true,
  complexityLevel: 'simple',
  useCaseDescription: 'General knowledge',
};

describe('PromptKit protocol neutrality (0824 评审 #2)', () => {
  it('system prompt carries no output-protocol rules (backend is the single source)', () => {
    const prompt = buildCardGenerationSystemPrompt();

    // 输出协议（END 分隔符 / {"cards":[...]} wrapper）只能由后端
    // anki_protocol::format_instructions 生成；CardAgent 基础 prompt
    // 带任何一种都会与后端自动选择的另一种协议互斥。
    expect(prompt).not.toContain(END_MARKER);
    expect(prompt).not.toContain(LEGACY_START_MARKER);
    expect(prompt).not.toContain('结束标记');
    expect(prompt).not.toContain('"cards"');
  });

  it('system prompt matches the Rust cross-layer contract fixture byte-for-byte', () => {
    const fixture = readFileSync(CROSS_LAYER_FIXTURE_PATH, 'utf-8');

    // fixture 文件以换行结尾（POSIX 文本文件约定）；两侧消费前都做 trim：
    // 后端 build_prompt 对 custom_anki_prompt 调 str::trim。
    expect(buildCardGenerationSystemPrompt().trim()).toBe(fixture.trim());
  });

  it('system prompt never embeds material or placeholders', () => {
    const prompt = buildCardGenerationSystemPrompt();

    expect(prompt).not.toContain('{{DOCUMENT_CONTENT}}');
  });

  it('content analysis prompt embeds the material and template ids', () => {
    const material = '牛顿第一定律：物体在不受外力作用时保持静止或匀速直线运动。';
    const prompt = buildContentAnalysisPrompt(material, [mockTemplate]);

    expect(prompt).toContain(material);
    expect(prompt).toContain('basic');
  });

  it('PromptKit no longer exposes any protocol markers', () => {
    // 协议标记（START/END）已全部退出前端：
    // 后端 anki_protocol::CARD_DELIMITER 是唯一定义。
    expect(PromptKit).not.toHaveProperty('CARD_JSON_START');
    expect(PromptKit).not.toHaveProperty('CARD_JSON_END');
  });

  it('PromptKit only exposes prompts that are wired to a real call path', () => {
    // 死 prompt（boundary/user/errorRepair/qualityAssessment）已删除：
    // - 定界 prompt：前端 LLM 定界死代码已移除（定界由后端管线执行）
    // - user prompt：学习材料由后端注入 user 消息，前端从不组装
    // - 修复/质量评估：流程从未接线
    expect(Object.keys(PromptKit).sort()).toEqual(
      ['buildCardGenerationSystemPrompt', 'buildContentAnalysisPrompt'].sort()
    );
  });
});
