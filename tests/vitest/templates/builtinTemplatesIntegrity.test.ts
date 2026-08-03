/**
 * 内置模板完整性测试
 *
 * 守护三件事：
 * 1. 前端副本（src/data/anki）与后端权威副本（src-tauri/src/data）内容一致；
 * 2. 每个内置模板的结构、字段、预览数据合法，front/back 用预览数据渲染时零问题；
 * 3. 渲染结果经预览净化（DOMPurify template-safe）后核心内容仍然可见，
 *    即模板不依赖 <script>/onclick 才能展示题面与答案；
 *    CSS 不使用 @import/@font-face/外链 url()，保证应用内预览与 Anki 观感一致。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { renderAnkiTemplate } from '@/services/ankiTemplateEngine';
import { sanitizeHtmlForPreview } from '@/components/previews/htmlSandboxPolicy';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const BACKEND_PATH = path.join(REPO_ROOT, 'src-tauri/src/data/builtin-templates.json');
const FRONTEND_PATH = path.join(REPO_ROOT, 'src/data/anki/builtin-templates.json');

interface RawBuiltinTemplate {
  id: string;
  name: string;
  description: string;
  author: string;
  version: string;
  note_type: string;
  fields_json: string;
  css_style: string;
  front_template: string;
  back_template: string;
  preview_front: string;
  preview_back: string;
  preview_data_json: string;
  field_extraction_rules_json: string;
  generation_prompt: string;
}

const backendTemplates = JSON.parse(readFileSync(BACKEND_PATH, 'utf8')) as RawBuiltinTemplate[];
const frontendTemplates = JSON.parse(readFileSync(FRONTEND_PATH, 'utf8')) as RawBuiltinTemplate[];

const CLOZE_ANSWER_PATTERN = /\{\{c\d+::([\s\S]*?)(?:::[\s\S]*?)?\}\}/;

function previewData(template: RawBuiltinTemplate): Record<string, string> {
  return JSON.parse(template.preview_data_json);
}

describe('builtin templates integrity', () => {
  it('keeps frontend copy in sync with the authoritative backend copy', () => {
    expect(frontendTemplates).toEqual(backendTemplates);
  });

  it('has unique ids', () => {
    const ids = backendTemplates.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  describe.each(backendTemplates.map((t) => [t.id, t] as const))('%s', (_id, template) => {
    it('declares a valid structure', () => {
      expect(template.name).toBeTruthy();
      expect(template.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(['Basic', 'Cloze']).toContain(template.note_type);

      const fields = JSON.parse(template.fields_json) as string[];
      expect(Array.isArray(fields)).toBe(true);
      expect(fields.length).toBeGreaterThan(0);

      // 与后端 validate_template_request 对齐：规则与字段一一对应
      const rules = JSON.parse(template.field_extraction_rules_json) as Record<string, unknown>;
      expect(Object.keys(rules).sort()).toEqual([...fields].sort());

      const data = previewData(template);
      expect(Object.keys(data).length).toBeGreaterThan(0);

      if (template.note_type === 'Cloze') {
        expect(template.front_template).toContain('{{cloze:');
        expect(template.back_template).toContain('{{cloze:');
        const hasClozeMarker = Object.values(data).some((value) =>
          CLOZE_ANSWER_PATTERN.test(value),
        );
        expect(hasClozeMarker).toBe(true);
      }
    });

    it('uses preview-safe CSS (no external fonts/resources, night-mode aware base)', () => {
      const css = template.css_style;
      expect(css).not.toMatch(/@import/i);
      expect(css).not.toMatch(/@font-face/i);
      // url() 仅允许 data: 内联资源（含其内部的 #fragment 引用），外链在预览中会被替换为 blocked
      const urlRefs = css.match(/url\(\s*['"]?([^'")]+)/gi) ?? [];
      for (const ref of urlRefs) {
        expect(ref).toMatch(/url\(\s*['"]?(data:|#|%23)/i);
      }
      expect(css).toContain('.card1');
    });

    it('renders front and back with preview data without issues', () => {
      const data = previewData(template);
      const front = renderAnkiTemplate(template.front_template, data, { side: 'front' });
      expect(front.issues).toEqual([]);
      expect(front.html.trim()).not.toBe('');

      const back = renderAnkiTemplate(template.back_template, data, {
        side: 'back',
        frontSide: front.html,
      });
      expect(back.issues).toEqual([]);
      expect(back.html.trim()).not.toBe('');
    });

    it('keeps core content visible after preview sanitization (no JS dependency)', () => {
      const data = previewData(template);
      const front = renderAnkiTemplate(template.front_template, data, { side: 'front' });
      const back = renderAnkiTemplate(template.back_template, data, {
        side: 'back',
        frontSide: front.html,
      });

      const sanitizedFront = sanitizeHtmlForPreview(front.html, 'template-safe');
      const sanitizedBack = sanitizeHtmlForPreview(back.html, 'template-safe');

      const fields = JSON.parse(template.fields_json) as string[];
      const firstFieldValue = data[fields[0]] ?? '';
      if (firstFieldValue && !firstFieldValue.includes('{{')) {
        // 题面主字段必须在净化后的正面可见
        expect(sanitizedFront).toContain(firstFieldValue);
      }

      if (template.note_type === 'Cloze') {
        // 背面必须揭示 cloze 答案
        const clozeSource = Object.values(data).find((value) =>
          CLOZE_ANSWER_PATTERN.test(value),
        );
        const answer = clozeSource?.match(CLOZE_ANSWER_PATTERN)?.[1] ?? '';
        expect(answer).not.toBe('');
        expect(sanitizedBack).toContain(answer);
      } else {
        // 背面必须包含答案主体（预览数据中最长的字段值）
        const longestValue = Object.values(data)
          .filter((value) => typeof value === 'string' && !value.includes('{{'))
          .sort((a, b) => b.length - a.length)[0];
        expect(longestValue).toBeTruthy();
        expect(sanitizedBack).toContain(longestValue);
      }
    });
  });
});
