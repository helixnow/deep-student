import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import i18next, { type i18n as I18n } from 'i18next';
import { beforeAll, describe, expect, it } from 'vitest';
import zhEssay from '@/locales/zh-CN/essay_grading.json';
import enEssay from '@/locales/en-US/essay_grading.json';
import type { GradingMode } from './essayGradingApi';
import { buildEssayAutoTitle } from '@/dstu/autoTitle';
import {
  BUILTIN_MODE_SOURCE,
  createDimensionLabeler,
  getDimensionDisplayName,
  getModeDisplayDescription,
  getModeDisplayName,
  localizeEssayTitle,
  type EssayTitleI18nT,
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

describe('essay session titles', () => {
  const titleT = (lng: string): EssayTitleI18nT => instance.getFixedT(lng) as unknown as EssayTitleI18nT;
  // 与 EssayGradingWorkbench 自动起名同一组合方式
  const autoTitle = (lng: string, gradedMode: GradingMode) =>
    buildEssayAutoTitle({
      inputText: 'Some people think that remote work is better. Others disagree.',
      modeName: getModeDisplayName(gradedMode, tFor(lng)) || undefined,
      join: (m, subject) => titleT(lng)('essay_grading:session.auto_title', { mode: m, subject }),
    });
  const ielts = mode({ id: 'ielts', name: '雅思大作文', description: BUILTIN_MODE_SOURCE.ielts.description });

  it('new auto titles use the localized built-in mode name', () => {
    expect(autoTitle('en-US', ielts)).toBe('IELTS Writing Task 2: Some people think that…');
    expect(autoTitle('zh-CN', ielts)).toBe('雅思大作文：Some people think that…');
  });

  it('new auto titles keep custom and user-renamed mode names', () => {
    expect(autoTitle('en-US', mode({ id: 'ielts', name: '我的雅思' }))).toBe('我的雅思: Some people think that…');
    expect(autoTitle('en-US', mode({ id: 'custom_1', name: '雅思大作文', is_builtin: false })))
      .toBe('雅思大作文: Some people think that…');
  });

  it('displays legacy titles with a stored Chinese built-in prefix in the UI language', () => {
    const en = titleT('en-US');
    expect(localizeEssayTitle('雅思大作文: Some people think that…', en)).toBe('IELTS Writing Task 2: Some people think that…');
    expect(localizeEssayTitle('雅思大作文：远程办公的利弊', en)).toBe('IELTS Writing Task 2: 远程办公的利弊');
    const short = localizeEssayTitle('高考英语小作文：给外教的一封信', en);
    expect(short).toMatch(/^.+: 给外教的一封信$/);
    expect(short).not.toContain('高考');
  });

  it('leaves other titles and the Chinese UI untouched', () => {
    const en = titleT('en-US');
    expect(localizeEssayTitle('雅思大作文练习', en)).toBe('雅思大作文练习');
    expect(localizeEssayTitle('我的雅思：远程办公', en)).toBe('我的雅思：远程办公');
    expect(localizeEssayTitle('雅思大作文：', en)).toBe('雅思大作文：');
    expect(localizeEssayTitle('', en)).toBe('');
    expect(localizeEssayTitle('雅思大作文：远程办公的利弊', titleT('zh-CN'))).toBe('雅思大作文：远程办公的利弊');
  });
});
