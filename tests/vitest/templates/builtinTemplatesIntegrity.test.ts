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

    // 卡面内容自适应（复习舞台按内容撑高 iframe，渲染期 overflow:hidden→auto）：
    // 答案层若是绝对定位的浮层，卡片高度不会随内容增长——长答案溢出、顶部被裁、
    // 出现纵横滚动条（The Architect / The Botanical 曾如此）。
    it('keeps revealed content in normal flow (no absolute opacity:0 overlays)', () => {
      for (const { selector, body } of cssRules(template.css_style)) {
        const absolute = /position\s*:\s*absolute/.test(body);
        const hidden = /(^|;)\s*opacity\s*:\s*0\s*(;|$)/.test(body);
        expect(absolute && hidden, `${selector} 是绝对定位的隐藏浮层`).toBe(false);
      }
    });

    it('clips out-of-box decorations with overflow:clip (survives the hidden→auto normalization)', () => {
      const rules = cssRules(template.css_style);
      const bleeding = rules.filter(({ body }) =>
        /position\s*:\s*absolute/.test(body) && /(^|;)\s*(top|left|right|bottom)\s*:\s*-/.test(body));
      if (bleeding.length > 0) {
        expect(rules.some(({ body }) => /overflow\s*:\s*clip/.test(body))).toBe(true);
      }
    });

    // flex 容器会把每段直接文本与行内元素（KaTeX 输出的 <math>）拆成独立 flex 项，
    // 字段文字与公式被排成并列的窄列。字段值必须包在 span/块元素里再放进 flex 容器。
    it('does not place field text directly inside flex containers', () => {
      const flexClasses = new Set<string>();
      for (const { selector, body } of cssRules(template.css_style)) {
        if (!/display\s*:\s*(inline-)?flex/.test(body)) continue;
        for (const part of selector.split(',')) {
          const last = part.trim().split(/[\s>+~]+/).pop() ?? '';
          for (const m of last.matchAll(/\.([\w-]+)/g)) flexClasses.add(m[1]);
        }
      }
      const data = previewData(template);
      const front = renderAnkiTemplate(template.front_template, data, { side: 'front' });
      const back = renderAnkiTemplate(template.back_template, data, { side: 'back', frontSide: front.html });
      for (const html of [front.html, back.html]) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        for (const cls of flexClasses) {
          for (const el of doc.querySelectorAll(`.${cls}`)) {
            const bareText = [...el.childNodes]
              .filter((n) => n.nodeType === Node.TEXT_NODE)
              .map((n) => n.textContent?.trim() ?? '')
              .filter(Boolean);
            expect(bareText, `.${cls} 直接包含文本`).toEqual([]);
          }
        }
      }
    });
  });
});

/** 极简 CSS 规则拆分（内置模板 CSS 无嵌套；@keyframes 内的 from/to 不含类名，无碍） */
function cssRules(css: string): Array<{ selector: string; body: string }> {
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  return [...flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));
}
