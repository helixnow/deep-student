import { describe, expect, it } from 'vitest';
import {
  INPUT_BAR_TEMPLATE_EXPANSIONS,
  PERMISSION_PRESETS,
  SPLIT_INPUT_BAR_SCAN_FILES,
  THINKING_DEPTH_SUFFIXES,
  UPLOAD_STAGES,
  extractI18nKeys,
} from './i18nKeyExtract';

/**
 * i18n 动态键矩阵（0824 Wave2-C R7「i18n 动态键」）
 *
 * 与 inputBarSplitI18nKeys.contract.test.ts 的分工：契约测试锁「所有模板都
 * 被注册表展开 + 每个键双语可解析 + 枚举与产品声明不漂移」；本矩阵测试从
 * **调用方视角**验证 extractI18nKeys 的展开结果——把「骨架 × 枚举值」组合
 * 逐格断言存在于展开集合中。这样即使有人改坏了注册表的 expandedKeys 拼接
 * （契约测试的 unexpandedTemplates 断言不会发现：骨架仍然命中，只是展开值
 * 错了），矩阵也会精确指出缺失的那一格。
 *
 * 覆盖三组任务指定的动态键族：
 * 1. uploadStage × 3：AttachmentPanelBody 的 t(`chatV2:inputBar.uploadStage.${…}`)，
 *    枚举恰好 reading / uploading / creating 三值；
 * 2. permissionPreset：ComposerPlusMenu 的 modes / hints / shortHints 三个骨架
 *    各 × 4 预设（cautious / relaxed / full_access / danger_full_access）；
 * 3. thinkingDepth.minimal：InputBarV2 的 t(`chatV2:inputBar.thinkingDepth.${…}`)
 *    最小档——R5 曾发现 minimal 词条缺失，此处单独点名防回归。
 */

const extraction = extractI18nKeys(SPLIT_INPUT_BAR_SCAN_FILES, INPUT_BAR_TEMPLATE_EXPANSIONS);
const extractedKeys = new Set(extraction.keys.keys());

interface MatrixRow {
  group: string;
  prefix: string;
  values: readonly string[];
}

const DYNAMIC_KEY_MATRIX: readonly MatrixRow[] = [
  {
    group: 'uploadStage',
    prefix: 'chatV2:inputBar.uploadStage',
    values: UPLOAD_STAGES,
  },
  {
    group: 'permissionPreset.modes',
    prefix: 'chatV2:authority.permissionPreset.modes',
    values: PERMISSION_PRESETS,
  },
  {
    group: 'permissionPreset.hints',
    prefix: 'chatV2:authority.permissionPreset.hints',
    values: PERMISSION_PRESETS,
  },
  {
    group: 'permissionPreset.shortHints',
    prefix: 'chatV2:authority.permissionPreset.shortHints',
    values: PERMISSION_PRESETS,
  },
  {
    group: 'thinkingDepth',
    prefix: 'chatV2:inputBar.thinkingDepth',
    values: THINKING_DEPTH_SUFFIXES,
  },
];

describe('i18n dynamic key expansion matrix', () => {
  it('extraction ran against the real scan list (precondition)', () => {
    // 展开集合为空说明扫描清单或提取正则失效，后面的逐格断言会齐刷刷假红
    expect(extractedKeys.size).toBeGreaterThan(0);
    expect(extraction.unexpandedTemplates).toEqual([]);
  });

  describe.each(DYNAMIC_KEY_MATRIX)('$group (prefix $prefix)', ({ prefix, values }) => {
    it.each(values.map((value) => [value]))(
      'expanded set contains %s',
      (value) => {
        expect(extractedKeys.has(`${prefix}.${value}`)).toBe(true);
      },
    );
  });

  it('uploadStage expands to exactly its 3 enum values (×3, no extras)', () => {
    // 「×3」按字面锁死：枚举本身就是 3 值……
    expect(UPLOAD_STAGES).toHaveLength(3);
    expect(new Set(UPLOAD_STAGES)).toEqual(new Set(['reading', 'uploading', 'creating']));
    // ……且展开集合中该前缀下恰好这 3 个键，多一个少一个都算矩阵破损
    const uploadStageKeys = [...extractedKeys].filter((key) =>
      key.startsWith('chatV2:inputBar.uploadStage.'),
    );
    expect(new Set(uploadStageKeys)).toEqual(
      new Set(UPLOAD_STAGES.map((stage) => `chatV2:inputBar.uploadStage.${stage}`)),
    );
  });

  it('every permissionPreset facet covers all 4 presets', () => {
    expect(PERMISSION_PRESETS).toHaveLength(4);
    for (const facet of ['modes', 'hints', 'shortHints'] as const) {
      const facetKeys = [...extractedKeys].filter((key) =>
        key.startsWith(`chatV2:authority.permissionPreset.${facet}.`),
      );
      expect(new Set(facetKeys), `facet ${facet}`).toEqual(
        new Set(
          PERMISSION_PRESETS.map((preset) => `chatV2:authority.permissionPreset.${facet}.${preset}`),
        ),
      );
    }
  });

  it('thinkingDepth.minimal is present in the expanded set (R5 regression pin)', () => {
    expect(THINKING_DEPTH_SUFFIXES).toContain('minimal');
    expect(extractedKeys.has('chatV2:inputBar.thinkingDepth.minimal')).toBe(true);
  });
});
