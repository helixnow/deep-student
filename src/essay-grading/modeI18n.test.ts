import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import i18next, { type i18n as I18n } from 'i18next';
import { beforeAll, describe, expect, it } from 'vitest';
import zhEssay from '@/locales/zh-CN/essay_grading.json';
import enEssay from '@/locales/en-US/essay_grading.json';
import type { GradingMode } from './essayGradingApi';
import {
  BUILTIN_MODE_SOURCE,
  createDimensionLabeler,
  getDimensionDisplayName,
  getModeDisplayDescription,
  getModeDisplayName,
  type ModeI18nT,
} from './modeI18n';

let instance: I18n;
const tFor = (lng: string): ModeI18nT => instance.getFixedT(lng) as unknown as ModeI18nT;

beforeAll(async () => {
  instance = i18next.createInstance();
  await instance.init({
    lng: 'en-US',
    fallbackLng: false,
    resources: {
      'zh-CN': { essay_grading: zhEssay },
      'en-US': { essay_grading: enEssay },
    },
    ns: ['essay_grading'],
    interpolation: { escapeValue: false },
  });
});

const mode = (overrides: Partial<GradingMode>): GradingMode => ({
  id: 'gaokao',
  name: '高考作文',
  description: '按照高考作文评分标准进行批改，总分60分',
  system_prompt: 'prompt',
  score_dimensions: [],
  total_max_score: 60,
  is_builtin: true,
  created_at: '',
  updated_at: '',
  ...overrides,
});

describe('modeI18n', () => {
  it('localizes untouched built-in modes into English', () => {
    const en = tFor('en-US');
    expect(getModeDisplayName(mode({}), en)).toBe('Gaokao Chinese Essay');
    expect(getModeDisplayDescription(mode({}), en)).toBe(
      'Grades against the Gaokao Chinese essay rubric, 60 points total'
    );
    expect(getModeDisplayName(mode({ id: 'ielts', name: '雅思大作文' }), en)).toBe('IELTS Writing Task 2');
    expect(getModeDisplayName(mode({ id: 'practice', name: '日常练习' }), en)).toBe('Daily Practice');
    expect(getDimensionDisplayName('gaokao', '发展等级', en)).toBe('Development Level');
    expect(getDimensionDisplayName('practice', '创意与表达', en)).toBe('Creativity & Expression');
    expect(getDimensionDisplayName('ielts', 'Task Response', en)).toBe('Task Response');
  });

  it('resolves alias mode ids via canonical id', () => {
    const en = tFor('en-US');
    expect(getModeDisplayName(mode({ id: 'cet6', name: '四六级作文' }), en)).toBe('CET-4/6 Essay');
    expect(getDimensionDisplayName('ielts_task2', 'Lexical Resource', en)).toBe('Lexical Resource');
  });

  it('keeps Chinese strings identical under zh-CN', () => {
    const zh = tFor('zh-CN');
    for (const [id, source] of Object.entries(BUILTIN_MODE_SOURCE)) {
      expect(getModeDisplayName(mode({ id, name: source.name }), zh)).toBe(source.name);
      expect(getModeDisplayDescription(mode({ id, description: source.description }), zh)).toBe(source.description);
      for (const dimName of Object.values(source.dimensions)) {
        expect(getDimensionDisplayName(id, dimName, zh)).toBe(dimName);
      }
    }
  });

  it('leaves user custom modes unchanged', () => {
    const en = tFor('en-US');
    const custom = mode({ id: 'b9c1-uuid', name: '高考作文', description: '我的描述', is_builtin: false });
    expect(getModeDisplayName(custom, en)).toBe('高考作文');
    expect(getModeDisplayDescription(custom, en)).toBe('我的描述');
    expect(getDimensionDisplayName(custom.id, '内容', en)).toBe('内容');
    expect(createDimensionLabeler(custom.id, en)).toBeUndefined();
  });

  it('leaves user-edited fields of built-in overrides unchanged (per field)', () => {
    const en = tFor('en-US');
    // 覆盖与预置同 ID，且 get_modes 会标 is_builtin=true
    const override = mode({ name: '我的高考作文', description: '按照高考作文评分标准进行批改，总分60分' });
    expect(getModeDisplayName(override, en)).toBe('我的高考作文');
    // 未改动的描述仍是预置原文 → 照常本地化
    expect(getModeDisplayDescription(override, en)).toBe(
      'Grades against the Gaokao Chinese essay rubric, 60 points total'
    );
    expect(getDimensionDisplayName('gaokao', '立意', en)).toBe('立意');
    expect(getDimensionDisplayName('gaokao', '内容', en)).toBe('Content');
  });

  it('falls back to backend text when t only echoes keys (missing namespace / test stubs)', () => {
    const echo: ModeI18nT = (key) => key;
    expect(getModeDisplayName(mode({}), echo)).toBe('高考作文');
    expect(getDimensionDisplayName('gaokao', '内容', echo)).toBe('内容');
  });

  it('zh-CN locale values equal the frontend source table', () => {
    expect((zhEssay as { builtinModes: unknown }).builtinModes).toEqual(BUILTIN_MODE_SOURCE);
    const enModes = (enEssay as { builtinModes: Record<string, { dimensions: Record<string, string> }> }).builtinModes;
    expect(Object.keys(enModes).sort()).toEqual(Object.keys(BUILTIN_MODE_SOURCE).sort());
    for (const [id, source] of Object.entries(BUILTIN_MODE_SOURCE)) {
      expect(Object.keys(enModes[id].dimensions).sort()).toEqual(Object.keys(source.dimensions).sort());
    }
  });

  it('source table mirrors the Rust built-in modes (types.rs)', () => {
    const rust = readFileSync(
      resolve(__dirname, '../../src-tauri/src/essay_grading/types.rs'),
      'utf8'
    );
    const body = rust.slice(rust.indexOf('pub fn get_builtin_grading_modes'), rust.indexOf('pub fn get_default_grading_mode'));
    const blocks = body.split(/GradingMode \{\s*id: "/).slice(1);
    const parsed: Record<string, { name: string; description: string; dims: string[] }> = {};
    for (const block of blocks) {
      const id = block.slice(0, block.indexOf('"'));
      const name = /name: "([^"]*)"\.to_string\(\)/.exec(block)?.[1] ?? '';
      const description = /description: "([^"]*)"\.to_string\(\)/.exec(block)?.[1] ?? '';
      const dims = [...block.matchAll(/ScoreDimension \{ name: "([^"]*)"/g)].map((m) => m[1]);
      parsed[id] = { name, description, dims };
    }
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(BUILTIN_MODE_SOURCE).sort());
    for (const [id, source] of Object.entries(BUILTIN_MODE_SOURCE)) {
      expect(parsed[id].name).toBe(source.name);
      expect(parsed[id].description).toBe(source.description);
      expect(parsed[id].dims).toEqual(Object.values(source.dimensions));
    }
  });
});
