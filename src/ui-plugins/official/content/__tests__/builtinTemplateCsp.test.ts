// WP-249 / D-154 (a)：内置模板不再依赖内联事件处理器；7 个原 onclick/脚本交互改为
// 隐藏 checkbox/radio + label + CSS。复杂交互 4 个（glass/redaction/manuscript/lab）
// 按裁定在模板里保留脚本，供 Anki 导出使用。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { sanitizeHtmlForPreview } from '@/components/previews/htmlSandboxPolicy';
import { renderAnkiTemplate } from '@/services/ankiTemplateEngine';

interface RawTemplate {
  id: string;
  version: string;
  css_style: string;
  front_template: string;
  back_template: string;
  preview_data_json: string;
}

const COPIES = [
  'host/plugins/anki/data/builtin-templates.json',
  'src/data/anki/builtin-templates.json',
];
const texts = COPIES.map((p) => readFileSync(path.resolve(process.cwd(), p), 'utf8'));
const templates = JSON.parse(texts[0]) as RawTemplate[];
const byId = (id: string) => templates.find((t) => t.id === id)!;

const SCRIPTED = ['design-glass', 'design-lab', 'design-manuscript', 'design-redaction'];

// [模板, 切换控件 class, 点击后出现的选择器, 点击后隐藏的选择器]
const TOGGLES: Array<[string, string, string[], string[]]> = [
  ['design-architect', 'arch-toggle', ['.arch-content'], []],
  ['design-botanical', 'bot-toggle', ['.bot-back-box'], []],
  ['design-monograph', 'mono-toggle', ['.mono-a'], ['.mono-hint']],
  ['design-footnote', 'fn-toggle', ['.fn-note'], ['.fn-hint']],
  ['design-marginalia', 'mg-toggle', ['.mg-def', '.mg-note'], ['.mg-hint']],
  ['design-seminar', 'sem-toggle', ['.sem-steps'], ['.sem-hint']],
  ['design-nomenclature', 'nom-toggle', ['.nom-def'], ['.nom-hint']],
  ['design-swiss', 'swiss-toggle', ['.swiss-back-face'], ['.swiss-front-face']],
  ['design-eink', 'eink-toggle', ['.eink-p'], ['.eink-sub']],
  ['design-lexicon', 'lex-toggle', ['.lex-back-content'], ['.lex-front']],
  ['design-polaroid', 'polar-toggle', ['.polar-back'], ['.polar-front']],
];

function renderFront(t: RawTemplate): string {
  const front = renderAnkiTemplate(t.front_template, JSON.parse(t.preview_data_json), { side: 'front' });
  expect(front.issues).toEqual([]);
  return sanitizeHtmlForPreview(front.html, 'template-safe');
}

/** 在 jsdom 中挂载净化后的正面与模板 CSS，返回 display 计算函数。 */
let recalc = 0;
function mount(t: RawTemplate) {
  document.head.innerHTML = '';
  const style = document.createElement('style');
  style.textContent = t.css_style;
  document.head.appendChild(style);
  document.body.innerHTML = renderFront(t);
  return (selector: string) => {
    const el = document.querySelector(selector);
    expect(el, selector).not.toBeNull();
    // jsdom 的样式缓存不随 checked 变化失效；改写样式表强制重算。
    recalc += 1;
    style.textContent = `${t.css_style}\n/* ${recalc} */`;
    return getComputedStyle(el!).display;
  };
}

describe('builtin templates: CSP-compatible interactions (WP-249)', () => {
  it('keeps the Host and frontend copies byte-identical', () => {
    const hashes = texts.map((s) => createHash('sha256').update(s).digest('hex'));
    expect(new Set(hashes).size).toBe(1);
  });

  it('has no inline event handler attribute in any template', () => {
    for (const t of templates) {
      for (const html of [t.front_template, t.back_template]) {
        expect(html, t.id).not.toMatch(/\son[a-z]+\s*=/i);
      }
    }
  });

  it('keeps <script> only in the four complex interactive templates', () => {
    const withScript = templates
      .filter((t) => /<script\b/i.test(t.front_template + t.back_template))
      .map((t) => t.id)
      .sort();
    expect(withScript).toEqual(SCRIPTED);
  });

  it('leaves no script or inline handler in any rendered preview (D-166)', () => {
    for (const t of templates) {
      const data = JSON.parse(t.preview_data_json);
      const front = renderAnkiTemplate(t.front_template, data, { side: 'front' });
      const back = renderAnkiTemplate(t.back_template, data, { side: 'back', frontSide: front.html });
      for (const html of [front.html, back.html]) {
        const out = sanitizeHtmlForPreview(html, 'template-safe');
        expect(out, t.id).not.toMatch(/<script\b/i);
        expect(out, t.id).not.toMatch(/\son[a-z]+\s*=/i);
      }
    }
  });

  it.each(TOGGLES)('%s toggles by label click without script', (id, toggle, shown, hidden) => {
    const t = byId(id);
    const display = mount(t);
    const input = document.querySelector<HTMLInputElement>(`input.${toggle}`)!;
    expect(input).not.toBeNull();
    expect(input.closest('label')).not.toBeNull();
    expect(display(`.${toggle}`)).toBe('none');
    for (const s of shown) expect(display(s), `${id} ${s} before`).toBe('none');
    for (const s of hidden) expect(display(s), `${id} ${s} before`).not.toBe('none');

    // 点击卡片任意位置（label 内部）切换
    (document.querySelector(shown[0])!.parentElement as HTMLElement).click();
    expect(input.checked).toBe(true);
    for (const s of shown) expect(display(s), `${id} ${s} after`).not.toBe('none');
    for (const s of hidden) expect(display(s), `${id} ${s} after`).toBe('none');
  });

  it.each(TOGGLES.filter(([id]) => id !== 'design-eink'))('%s toggles back on second click', (id, toggle, shown) => {
    const display = mount(byId(id));
    const label = document.querySelector<HTMLInputElement>(`input.${toggle}`)!.closest('label')!;
    label.click();
    label.click();
    expect(document.querySelector<HTMLInputElement>(`input.${toggle}`)!.checked).toBe(false);
    expect(display(shown[0])).toBe('none');
  });

  it('e-ink reveal is one-way like the original script', () => {
    mount(byId('design-eink'));
    const label = document.querySelector('label.eink-card') as HTMLElement;
    label.click();
    label.click();
    expect(document.querySelector<HTMLInputElement>('input.eink-toggle')!.checked).toBe(true);
  });
});
