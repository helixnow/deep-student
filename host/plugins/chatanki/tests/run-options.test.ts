import { describe, expect, it } from 'vitest';
import type { CustomAnkiTemplate } from '../api.ts';
import {
  buildPreferenceHint, clampMaxCardsArg, deriveDocumentName, inferTemplateIdFromGoal,
  normalizeGlossaryParagraphs, normalizeOutputProtocolArg, resolveTemplateSelection,
  type ChatAnkiTemplateSource,
} from '../src/run-options.ts';
import { CHATANKI_PREFERENCE_MEMORY_SETTING_KEY } from '../src/preference-memory.ts';

function tpl(id: string, fields: string[], isActive = true): CustomAnkiTemplate {
  return { id, name: `name-${id}`, fields, is_active: isActive } as unknown as CustomAnkiTemplate;
}

function source(templates: CustomAnkiTemplate[], defaultId: string | null = null): ChatAnkiTemplateSource & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    getById: (id) => { reads.push(id); return templates.find((t) => t.id === id) ?? null; },
    listAll: () => templates,
    defaultTemplateId: () => defaultId,
  };
}

const CHOICE = ['Question', 'OptionA', 'OptionB', 'OptionC', 'OptionD'];

describe('chatanki run/start normalizers (chatanki_executor.rs)', () => {
  it('outputProtocol: trim+lowercase, auto/blank is None, unknown fails with the lowercased value', () => {
    expect(normalizeOutputProtocolArg(null)).toBeNull();
    expect(normalizeOutputProtocolArg('  AUTO ')).toBeNull();
    expect(normalizeOutputProtocolArg('   ')).toBeNull();
    expect(normalizeOutputProtocolArg(' Json_Schema')).toBe('json_schema');
    expect(() => normalizeOutputProtocolArg(' XML ')).toThrow(
      "invalid outputProtocol 'xml': expected auto | delimiter | json_object | json_schema",
    );
  });

  it('maxCards over 100 clamps with the structured warning; 100 and below pass through', () => {
    expect(clampMaxCardsArg(null)).toEqual([null, null]);
    expect(clampMaxCardsArg(100)).toEqual([100, null]);
    expect(clampMaxCardsArg(-5)).toEqual([-5, null]);
    const [applied, warning] = clampMaxCardsArg(250);
    expect(applied).toBe(100);
    expect(JSON.stringify(warning)).toBe(JSON.stringify({
      code: 'max_cards_clamped',
      messageKey: 'blocks.ankiCards.warnings.maxCardsClamped',
      messageParams: { requested: 250, applied: 100 },
      requested: 250,
      applied: 100,
      message: 'maxCards 250 exceeds the per-run hard limit; clamped to 100. Split into multiple runs for more cards.',
    }));
  });

  it('document name: explicit non-default deck wins (ASCII-case "default" ignored), else goal capped at 80 chars', () => {
    expect(deriveDocumentName('  生物  ', 'goal')).toBe('生物');
    expect(deriveDocumentName('DeFault', '  目标  ')).toBe('目标');
    expect(deriveDocumentName('', '  ')).toBe('chatanki');
    expect(deriveDocumentName(null, '\u3000')).toBe('chatanki');
    const long = '𝒳'.repeat(81);
    expect(deriveDocumentName(null, long)).toBe(`${'𝒳'.repeat(77)}...`);
    expect(deriveDocumentName(null, '𝒳'.repeat(80))).toBe('𝒳'.repeat(80));
  });

  it('glossary paragraphs: one paragraph per entry start, continuation lines kept, blank lines flush', () => {
    const text = '术语A：解释\r\n  续行\n\n- 条目B\n123 第三\n12\n\n孤立段落\n';
    expect(normalizeGlossaryParagraphs(text)).toBe('术语A：解释\n续行\n\n- 条目B\n\n123 第三\n12\n\n孤立段落');
    expect(normalizeGlossaryParagraphs('')).toBe('');
  });

  it('preference hint: missing/unreadable/unparseable store or blank retrieval is None; budget is 120', () => {
    const calls: unknown[][] = [];
    const retrieve = (...args: unknown[]): string => { calls.push(args); return '  偏好  '; };
    const settings = (value: string | null | Error) => ({
      getSetting: (key: string) => {
        expect(key).toBe(CHATANKI_PREFERENCE_MEMORY_SETTING_KEY);
        if (value instanceof Error) throw value;
        return value;
      },
      saveSetting: () => undefined,
    });
    expect(buildPreferenceHint(settings(null) as never, retrieve as never, 'g', [])).toBeNull();
    expect(buildPreferenceHint(settings(new Error('db')) as never, retrieve as never, 'g', [])).toBeNull();
    expect(buildPreferenceHint(settings('{"entries":1}') as never, retrieve as never, 'g', [])).toBeNull();
    expect(calls).toHaveLength(0);
    expect(buildPreferenceHint(settings('{"entries":[]}') as never, retrieve as never, 'g', ['T'])).toBe('  偏好  ');
    expect(calls).toEqual([[{ entries: [] }, 'g', ['T'], 120]]);
    expect(buildPreferenceHint(settings('{"entries":[]}') as never, (() => ' \n') as never, 'g', [])).toBeNull();
  });

  it('choice inference needs a choice goal and ≥4 trimmed/lowercased choice fields; first best wins ties', () => {
    const four = tpl('four', [' question ', 'optiona', 'OPTIONB', 'optionc']);
    const five = tpl('five', CHOICE);
    const fiveLater = tpl('five-later', CHOICE);
    const inactive = tpl('inactive', CHOICE, false);
    expect(inferTemplateIdFromGoal('总结要点', [five])).toBeNull();
    expect(inferTemplateIdFromGoal('生成选择题', [inactive, four, five, fiveLater])).toBe('five');
    expect(inferTemplateIdFromGoal('生成选择题', [tpl('three', ['question', 'optiona', 'optionb'])])).toBeNull();
  });

  it('single: explicit id (trimmed) must exist; default then built-in fallback; exact failure texts', () => {
    const basic = tpl('design-monograph', ['Front', 'Back']);
    expect(() => resolveTemplateSelection(null, 'g', 'single', 'x', null)).toThrow('Anki database not available');
    expect(resolveTemplateSelection(source([basic]), 'g', 'single', '  design-monograph ', null))
      .toEqual({ templateId: 'design-monograph', templateIds: null });
    expect(() => resolveTemplateSelection(source([basic]), 'g', 'single', 'nope', null)).toThrow('指定模板不存在: nope');

    const custom = tpl('custom', ['Front', 'Back']);
    expect(resolveTemplateSelection(source([custom, basic], ' custom '), 'g', 'single', '  ', null))
      .toEqual({ templateId: 'custom', templateIds: null });

    const logs: string[] = [];
    const stale = source([basic], 'deleted');
    expect(resolveTemplateSelection(stale, 'g', 'single', null, null, (m) => logs.push(m)))
      .toEqual({ templateId: 'design-monograph', templateIds: null });
    expect(stale.reads).toEqual(['deleted', 'design-footnote', 'design-monograph', 'design-monograph']);
    expect(logs[0]).toBe('[ChatAnkiToolExecutor] no usable default template (Some("deleted")); falling back to built-in design-monograph');

    expect(() => resolveTemplateSelection(source([]), 'g', 'single', null, null)).toThrow(
      'templateMode=single 时必须提供 templateId（指定单个模板），或先在设置中配置默认模板',
    );
  });

  it('single: settings and lookup failures carry their Rust prefixes; fallback probe failures are skipped', () => {
    const failingDefault: ChatAnkiTemplateSource = {
      getById: () => null, listAll: () => [], defaultTemplateId: () => { throw new Error('locked'); },
    };
    expect(() => resolveTemplateSelection(failingDefault, 'g', 'single', null, null)).toThrow('读取默认模板设置失败: locked');

    const failingLookup: ChatAnkiTemplateSource = {
      getById: () => { throw new Error('io'); }, listAll: () => [], defaultTemplateId: () => 'custom',
    };
    expect(() => resolveTemplateSelection(failingLookup, 'g', 'single', null, null)).toThrow('加载模板失败: io');
    expect(() => resolveTemplateSelection(failingLookup, 'g', 'single', 'x', null)).toThrow('加载模板失败: io');

    let calls = 0;
    const flakyFallback: ChatAnkiTemplateSource = {
      getById: (id) => {
        calls += 1;
        if (id === 'design-footnote') throw new Error('io');
        return id === 'design-monograph' ? tpl(id, []) : null;
      },
      listAll: () => [],
      defaultTemplateId: () => null,
    };
    expect(resolveTemplateSelection(flakyFallback, 'g', 'single', null, null).templateId).toBe('design-monograph');
    expect(calls).toBe(3);
  });

  it('multiple: non-empty ids that all exist; all: active ids or the inferred choice template', () => {
    const a = tpl('a', ['Front', 'Back']);
    const choice = tpl('choice', CHOICE);
    const off = tpl('off', ['Front'], false);
    expect(() => resolveTemplateSelection(source([a]), 'g', 'multiple', ' ', [])).toThrow(
      'templateMode=multiple 时必须提供非空 templateIds（或 templateId）',
    );
    expect(() => resolveTemplateSelection(source([a]), 'g', 'multiple', null, ['a', 'b'])).toThrow('指定模板不存在: b');
    expect(resolveTemplateSelection(source([a, choice]), 'g', 'multiple', 'choice', ['a,choice', ' a ']).templateIds)
      .toEqual(['a', 'choice']);
    const fullwidth = tpl('（', []);
    const astral = tpl('𝒳', []);
    expect(resolveTemplateSelection(source([fullwidth, astral]), 'g', 'multiple', '𝒳', ['（']).templateIds)
      .toEqual(['（', '𝒳']);

    expect(() => resolveTemplateSelection(source([off]), 'g', 'all', null, null)).toThrow('templateMode=all 但当前没有启用中的模板');
    expect(resolveTemplateSelection(source([a, off, choice]), '总结', 'all', null, null))
      .toEqual({ templateId: null, templateIds: ['a', 'choice'] });
    expect(resolveTemplateSelection(source([a, off, choice]), '选择题练习', 'all', null, null))
      .toEqual({ templateId: 'choice', templateIds: null });
    const listFails: ChatAnkiTemplateSource = { getById: () => null, listAll: () => { throw new Error('io'); }, defaultTemplateId: () => null };
    expect(() => resolveTemplateSelection(listFails, 'g', 'all', null, null)).toThrow('加载模板列表失败: io');
  });
});
