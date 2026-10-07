/**
 * 演示用的两套 Anki 模板（问答 / 填空）：对话演示的 anki_cards 块、闪卡、制卡与模板管理演示共用。
 * 单独成模块，单应用演示不必为了模板拉整份对话剧本。
 */
import type { CustomAnkiTemplate } from '@/types';

const DEMO_TEMPLATE_BASE = {
  author: 'Deep Student',
  version: '1.0',
  generation_prompt: '',
  preview_front: '',
  preview_back: '',
  is_active: true,
  is_built_in: true,
};

export const DEMO_ANKI_TEMPLATES: CustomAnkiTemplate[] = [
  {
    ...DEMO_TEMPLATE_BASE,
    id: 'tpl_demo_basic',
    name: '问答题',
    description: '标准问答卡：正面问题，背面答案',
    note_type: 'Basic',
    fields: ['Front', 'Back'],
    front_template:
      '<div class="card"><div class="qa-front">{{Front}}</div></div>',
    back_template:
      '<div class="card"><div class="qa-front qa-front--dim">{{Front}}</div><hr id="answer" /><div class="qa-back">{{Back}}</div></div>',
    // 注意：沙箱把模板输出直接放进 body，没有 .card 外壳；这里手动包一层。
    // 颜色不写死——跟随沙箱暗色兜底的 body 前景色，深浅主题都可读。
    css_style:
      '.card { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; font-size: 15px; line-height: 1.75; padding: 18px 20px; box-sizing: border-box; } ' +
      '.qa-front { font-weight: 600; } ' +
      '.qa-front--dim { font-weight: 500; opacity: 0.6; font-size: 13px; } ' +
      '.qa-back { white-space: pre-wrap; } ' +
      'hr#answer { border: none; border-top: 1px dashed currentColor; opacity: 0.3; margin: 10px 0; }',
    field_extraction_rules: {
      Front: { field_type: 'text', is_required: true, description: '问题' },
      Back: { field_type: 'text', is_required: true, description: '答案' },
    },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  } as unknown as CustomAnkiTemplate,
  {
    ...DEMO_TEMPLATE_BASE,
    id: 'tpl_demo_cloze',
    name: '填空题',
    description: '挖空卡：{{c1::答案}} 背诵模式',
    note_type: 'Cloze',
    fields: ['Text'],
    front_template:
      '<div class="card"><div class="cloze-text">{{cloze:Text}}</div></div>',
    back_template:
      '<div class="card"><div class="cloze-text">{{cloze:Text}}</div></div>',
    css_style:
      '.card { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; font-size: 15px; line-height: 1.75; padding: 18px 20px; box-sizing: border-box; } ' +
      '.cloze-text { white-space: pre-wrap; } ' +
      // 引擎正面输出 .cloze（挖空占位），背面输出 .cloze-revealed（揭示答案）
      '.cloze { font-weight: 700; border-bottom: 1.5px dashed currentColor; padding: 0 2px; } ' +
      '.cloze-revealed { font-weight: 700; border-bottom: 1.5px solid currentColor; padding: 0 2px; }',
    field_extraction_rules: {
      Text: { field_type: 'text', is_required: true, description: '挖空文本' },
    },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  } as unknown as CustomAnkiTemplate,
];
