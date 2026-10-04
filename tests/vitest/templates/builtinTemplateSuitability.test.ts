/**
 * 内置模板「内容适配」元数据守护
 *
 * 事故：Agent 给微积分讲义（中值定理 + 证明）选了 design-architect，把整句证明塞进
 * Formula（1.5rem 等宽大字、只容一条公式）/ Expl，卡片不可读。修复把选模板依据写进
 * 模板元数据：generation_prompt 写明「适用 / 不适用 / 逐字段要求」，字段规则带
 * max_length（生成提示词、json_schema、QA 留痕与 Agent 侧 fieldLimitWarnings 共用）。
 * 本测试防止新增/改版模板时丢掉这些元数据，并锁住 ChatAnki 技能里的选模板规则。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { chatAnkiSkill } from '@/features/chat/skills/builtin';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const BACKEND_PATH = path.join(REPO_ROOT, 'src-tauri/src/data/builtin-templates.json');

interface RawBuiltinTemplate {
  id: string;
  note_type: string;
  fields_json: string;
  preview_data_json: string;
  field_extraction_rules_json: string;
  generation_prompt: string;
}

interface RawRule {
  description: string;
  max_length?: number;
}

const templates = JSON.parse(readFileSync(BACKEND_PATH, 'utf8')) as RawBuiltinTemplate[];
const templateIds = new Set(templates.map((t) => t.id));

const GENERAL_QA = ['design-footnote', 'design-monograph'];
const GENERAL_CLOZE = ['design-glass', 'design-exam'];

function rulesOf(template: RawBuiltinTemplate): Record<string, RawRule> {
  return JSON.parse(template.field_extraction_rules_json);
}

describe('builtin template suitability metadata', () => {
  it('keeps the general-purpose Q&A and cloze fallbacks available', () => {
    for (const id of [...GENERAL_QA, ...GENERAL_CLOZE]) {
      expect(templateIds.has(id)).toBe(true);
    }
  });

  describe.each(templates.map((t) => [t.id, t] as const))('%s', (_id, template) => {
    it('states when to use it, when not to, and points to existing alternatives', () => {
      const prompt = template.generation_prompt;
      expect(prompt).toMatch(/^适用：/);
      expect(prompt).toContain('不适用：');
      expect(prompt).toContain('字段：');
      const referenced = prompt.match(/design-[a-z]+/g) ?? [];
      expect(referenced.length).toBeGreaterThan(0);
      for (const id of referenced) {
        expect(templateIds.has(id)).toBe(true);
      }
    });

    it('gives every field a purpose and a max_length that the preview data respects', () => {
      const fields = JSON.parse(template.fields_json) as string[];
      const rules = rulesOf(template);
      const preview = JSON.parse(template.preview_data_json) as Record<string, string>;
      for (const field of fields) {
        const rule = rules[field];
        expect(rule.description.length).toBeGreaterThan(0);
        expect(rule.description).not.toBe(field);
        expect(Number.isInteger(rule.max_length)).toBe(true);
        expect(rule.max_length).toBeGreaterThan(0);
        // generation_prompt 必须提到每个字段，模型才知道逐字段要求
        expect(template.generation_prompt).toContain(field.replace(/(\d|(?<=option)[a-e])$/, ''));
        if (preview[field] !== undefined) {
          expect([...preview[field]].length).toBeLessThanOrEqual(rule.max_length!);
        }
      }
    });
  });

  it('keeps design-architect Formula a short single-expression field', () => {
    const architect = templates.find((t) => t.id === 'design-architect')!;
    const rules = rulesOf(architect);
    expect(rules.Formula.max_length).toBeLessThanOrEqual(60);
    expect(rules.Expl.max_length).toBeLessThanOrEqual(80);
    expect(architect.generation_prompt).toContain('证明');
    expect(architect.generation_prompt).toContain('design-footnote');
  });

  it('lets the general Q&A templates hold multi-sentence answers', () => {
    for (const id of GENERAL_QA) {
      const template = templates.find((t) => t.id === id)!;
      expect(rulesOf(template).Answer.max_length).toBeGreaterThanOrEqual(400);
    }
  });
});

describe('ChatAnki skill template selection guidance', () => {
  const content = chatAnkiSkill.content;

  it('defaults to plain Q&A / cloze and reserves showcase templates for matching content', () => {
    expect(content).toContain('## 选模板：内容决定模板');
    for (const id of [...GENERAL_QA, ...GENERAL_CLOZE]) {
      expect(content).toContain(id);
    }
    expect(content).toContain('只在内容完全符合其字段语义时');
    expect(content).toContain('fieldLimitWarnings');
    expect(content).toContain('maxChars');
  });

  it('tells the model where list_templates exposes the guidance', () => {
    const listTemplates = chatAnkiSkill.embeddedTools?.find(
      (tool) => tool.name === 'builtin-chatanki_list_templates',
    );
    expect(listTemplates?.description).toContain('selectionRule');
    expect(listTemplates?.description).toContain('fieldGuide');

    for (const name of ['builtin-chatanki_run', 'builtin-chatanki_start']) {
      const tool = chatAnkiSkill.embeddedTools?.find((t) => t.name === name);
      const templateId = (tool?.inputSchema as any).properties.templateId.description as string;
      expect(templateId).toContain('design-footnote');
      expect(templateId).toContain('design-glass');
    }
  });
});
