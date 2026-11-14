import { describe, expect, it } from 'vitest';
import { canonicalModeId, getBuiltinGradingModes } from '../src/essay_grading/types.ts';

describe('types.rs', () => {
  it('canonical_mode_id_maps_known_aliases', () => {
    expect(canonicalModeId('ielts_task2')).toBe('ielts');
    expect(canonicalModeId('ielts_writing')).toBe('ielts');
    expect(canonicalModeId('ielts_task_1')).toBe('ielts_task1');
    expect(canonicalModeId('cet4')).toBe('cet');
    expect(canonicalModeId('cet6')).toBe('cet');
    expect(canonicalModeId('cet46')).toBe('cet');
    expect(canonicalModeId('cet_46')).toBe('cet');
    expect(canonicalModeId('gaokao_english_short')).toBe('gaokao_en_short');
    expect(canonicalModeId('gaokao_eng_short')).toBe('gaokao_en_short');
    expect(canonicalModeId('gaokao_english_long')).toBe('gaokao_en_long');
    expect(canonicalModeId('gaokao_eng_long')).toBe('gaokao_en_long');
    expect(canonicalModeId('gaokao_en_continuation')).toBe('gaokao_en_long');
    expect(canonicalModeId('  practice  ')).toBe('practice');
  });

  it('builtin_modes_include_new_exam_modes', () => {
    const ids = new Set(getBuiltinGradingModes().map((mode) => mode.id));

    expect(ids.has('gaokao')).toBe(true);
    expect(ids.has('gaokao_en_short')).toBe(true);
    expect(ids.has('gaokao_en_long')).toBe(true);
    expect(ids.has('ielts')).toBe(true);
    expect(ids.has('ielts_task1')).toBe(true);
    expect(ids.has('kaoyan')).toBe(true);
    expect(ids.has('toefl')).toBe(true);
    expect(ids.has('cet')).toBe(true);
    expect(ids.has('zhongkao')).toBe(true);
    expect(ids.has('practice')).toBe(true);
  });

  /**
   * 维度分值与总分的一致性守护：
   * - 求和制模式：各维度满分之和 == 总分满分
   * - band 制模式（雅思/托福）：每个维度满分 == 总分满分（总分为平均而非求和）
   */
  it('builtin_mode_dimensions_are_consistent_with_total', () => {
    const bandModes = new Set(['ielts', 'ielts_task1', 'toefl']);

    for (const mode of getBuiltinGradingModes()) {
      expect(mode.scoreDimensions.length, `模式 ${mode.id} 缺少评分维度`).toBeGreaterThan(0);
      if (bandModes.has(mode.id)) {
        for (const dim of mode.scoreDimensions) {
          expect(
            dim.maxScore,
            `band 制模式 ${mode.id} 的维度 ${dim.name} 满分应等于总分满分`,
          ).toBe(mode.totalMaxScore);
        }
      } else {
        const dimSum = mode.scoreDimensions.reduce((sum, dim) => sum + dim.maxScore, 0);
        expect(
          Math.abs(dimSum - mode.totalMaxScore),
          `求和制模式 ${mode.id} 的维度满分之和 (${dimSum}) 与总分满分 (${mode.totalMaxScore}) 不一致`,
        ).toBeLessThan(0.01);
      }
    }
  });
});
