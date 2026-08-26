import { describe, expect, it } from 'vitest';
import {
  COMPACTION_REASON_CODES,
  IMAGE_INJECT_MODES,
  INPUT_BAR_TEMPLATE_EXPANSIONS,
  PDF_INJECT_MODES,
  PERMISSION_PRESETS,
  SPLIT_INPUT_BAR_SCAN_FILES,
  THINKING_DEPTH_SUFFIXES,
  UPLOAD_STAGES,
  collectQuotedStrings,
  extractI18nKeys,
  loadLocaleNamespace,
  readRepoSource,
  resolveKeyToText,
} from './i18nKeyExtract';

/**
 * 拆分输入栏 i18n 键解析契约（0824 rel-mobile 审查；R5 升级为模板展开 + 严格叶子）
 *
 * 背景：AttachmentPanelBody（v0.9.44 → 0824 Composer 拆分新增）曾引用
 * `common:actions.more` 作为移动端「⋯更多」按钮的 aria-label，但当时两份
 * locale 里都没有这个键——en-US 读屏用户只能听到中文 fallback「更多」。
 * 0824 上 rel-i18n(#318) 已把该按钮收敛为复用已翻译的顶层 `common:more`
 * （releaseUpgradeI18n.test.ts 锁定组件不得再引用 `common:actions.more`）；
 * rel-mobile(#324) 增补的 `actions.more` 词条保留，并在此锁定为双语可解析。
 *
 * R5（i18n 守卫-AST）升级点：
 * 1. 模板字符串键不再豁免：`t(\`ns:prefix.${enum}\`)` 按注册表逐值展开
 *    （uploadStage / permissionPreset modes|hints|shortHints / injectMode /
 *    thinkingDepth / compaction reason），注册表不认识的带命名空间模板直接判失败。
 * 2. resolveKeyToText 要求叶子是非空字符串：键打到中间对象（漏最后一段）不再放行。
 * 3. 扫描清单补齐 AttachmentPreviewChips / ContextUsagePopover /
 *    ComposerInlinePanel / ComposerPanel，以及模板键宿主 InputBarV2 / useInputBarV2。
 * 4. 注册表枚举与产品源码声明做集合相等 drift 校验。
 */

const LOCALES = ['zh-CN', 'en-US'] as const;

/**
 * 已知缺口登记。R5 已补 chatV2:inputBar.thinkingDepth.minimal 双语词条，表空。
 * 新增不可静态补齐的缺口才允许登记，且必须有自清理断言。
 */
const KNOWN_UNRESOLVED_KEYS: Record<string, readonly (typeof LOCALES)[number][]> = {};

const extraction = extractI18nKeys(SPLIT_INPUT_BAR_SCAN_FILES, INPUT_BAR_TEMPLATE_EXPANSIONS);

const isKnownGap = (key: string, locale: (typeof LOCALES)[number]): boolean =>
  KNOWN_UNRESOLVED_KEYS[key]?.includes(locale) ?? false;

const resolveNamespacedKey = (key: string, locale: string): boolean => {
  const separatorIndex = key.indexOf(':');
  const ns = key.slice(0, separatorIndex);
  const path = key.slice(separatorIndex + 1);
  return resolveKeyToText(loadLocaleNamespace(locale, ns), path);
};

describe('split input bar i18n key resolution contract', () => {
  it('expands every namespaced template literal through the enum registry', () => {
    // 新增 t(`ns:…${…}`) 动态键时必须同步登记枚举展开，否则骨架会落到这里
    expect(extraction.unexpandedTemplates).toEqual([]);
  });

  it('extracts a meaningful number of keys (anti-rot guard)', () => {
    // 当前扫描清单提取 187 个键（字面量 + 模板展开）；归零/骤降说明正则或清单失效
    expect(extraction.keys.size).toBeGreaterThan(120);
  });

  it('attributes expanded template keys to their host files', () => {
    const expectAttribution = (key: string, fileSuffix: string): void => {
      const files = extraction.keys.get(key);
      expect(files, `${key} must be extracted`).toBeDefined();
      expect(
        [...files!].some((file) => file.endsWith(fileSuffix)),
        `${key} must be attributed to ${fileSuffix}`,
      ).toBe(true);
    };
    expectAttribution('chatV2:inputBar.uploadStage.creating', 'AttachmentPanelBody.tsx');
    expectAttribution(
      'chatV2:authority.permissionPreset.shortHints.danger_full_access',
      'ComposerPlusMenu.tsx',
    );
    expectAttribution('chatV2:injectMode.pdf.ocr', 'useInputBarV2.ts');
    expectAttribution('chatV2:inputBar.thinkingDepth.max', 'InputBarV2.tsx');
    expectAttribution('chatV2:compaction.reason.unknown', 'InputBarV2.tsx');
    // ComposerPanel 的无前缀键经 defaultNamespace 展开
    expectAttribution('chatV2:common.clearSearch', 'ComposerPanel/ComposerPanel.tsx');
  });

  it('resolves every extracted key to non-empty text in both zh-CN and en-US', () => {
    const missing: string[] = [];
    for (const [key, files] of extraction.keys) {
      for (const locale of LOCALES) {
        if (isKnownGap(key, locale)) continue;
        if (!resolveNamespacedKey(key, locale)) {
          missing.push(`${key} (${locale}) referenced by ${[...files].join(', ')}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('keeps registered known gaps missing until locales are fixed (self-cleaning list)', () => {
    for (const [key, locales] of Object.entries(KNOWN_UNRESOLVED_KEYS)) {
      expect(
        extraction.keys.has(key),
        `${key} is registered as a known gap but no longer extracted — drop it`,
      ).toBe(true);
      for (const locale of locales) {
        expect(
          resolveNamespacedKey(key, locale),
          `${key} (${locale}) now resolves — remove it from KNOWN_UNRESOLVED_KEYS`,
        ).toBe(false);
      }
    }
  });

  it('keeps expansion enums in sync with product declarations (drift guard)', () => {
    // uploadStage：AttachmentMeta.uploadStage 联合类型
    const commonTypes = readRepoSource('src/features/chat/core/types/common.ts');
    const uploadStageDecl = commonTypes.match(/uploadStage\?:\s*([^;]+);/);
    expect(uploadStageDecl).not.toBeNull();
    expect(new Set(collectQuotedStrings(uploadStageDecl![1]))).toEqual(new Set(UPLOAD_STAGES));

    // injectMode：ImageInjectMode / PdfInjectMode 联合类型
    const imageModesDecl = commonTypes.match(/export type ImageInjectMode = ([^;]+);/);
    const pdfModesDecl = commonTypes.match(/export type PdfInjectMode = ([^;]+);/);
    expect(imageModesDecl).not.toBeNull();
    expect(pdfModesDecl).not.toBeNull();
    expect(new Set(collectQuotedStrings(imageModesDecl![1]))).toEqual(new Set(IMAGE_INJECT_MODES));
    expect(new Set(collectQuotedStrings(pdfModesDecl![1]))).toEqual(new Set(PDF_INJECT_MODES));

    // permissionPreset：ComposerPlusMenu 的 PERMISSION_PRESETS 数组
    const plusMenuSource = readRepoSource(
      'src/features/chat/components/input-bar/ComposerPlusMenu.tsx',
    );
    const presetsStart = plusMenuSource.indexOf('const PERMISSION_PRESETS');
    expect(presetsStart).toBeGreaterThan(-1);
    const presetsSlice = plusMenuSource.slice(
      presetsStart,
      plusMenuSource.indexOf('];', presetsStart),
    );
    expect(new Set(collectQuotedStrings(presetsSlice))).toEqual(new Set(PERMISSION_PRESETS));

    // thinkingDepth：InputBarV2 的 THINKING_DEPTH_LABEL_KEYS 值域
    //（kind 键形如 'openai-effort': {，值形如 minimal: 'minimal'，只收冒号后的字符串）
    const inputBarV2Source = readRepoSource(
      'src/features/chat/components/input-bar/InputBarV2.tsx',
    );
    const depthStart = inputBarV2Source.indexOf('const THINKING_DEPTH_LABEL_KEYS');
    expect(depthStart).toBeGreaterThan(-1);
    const depthSlice = inputBarV2Source.slice(
      depthStart,
      inputBarV2Source.indexOf('\n};', depthStart),
    );
    const depthSuffixes = [...depthSlice.matchAll(/:\s*'([A-Za-z]+)'/g)].map((m) => m[1]);
    expect(new Set(depthSuffixes)).toEqual(new Set(THINKING_DEPTH_SUFFIXES));

    // compaction reason：KNOWN_COMPACTION_REASONS + 兜底 unknown
    const compactionSource = readRepoSource('src/features/chat/utils/compactionFeedback.ts');
    const reasonsStart = compactionSource.indexOf('const KNOWN_COMPACTION_REASONS');
    expect(reasonsStart).toBeGreaterThan(-1);
    const reasonsSlice = compactionSource.slice(
      reasonsStart,
      compactionSource.indexOf(']);', reasonsStart),
    );
    expect(new Set(collectQuotedStrings(reasonsSlice))).toEqual(new Set(COMPACTION_REASON_CODES));
    expect(compactionSource).toContain("'compaction.reason.unknown'");
    // 宽骨架 chatV2:* 只允许被 compaction reason 这个调用点占用
    expect(inputBarV2Source).toContain('t(`chatV2:${compactionReasonI18nKey(result.reason)}`)');
  });

  /**
   * 【官方裁决 · 0824 Step 21】`common:actions.more` 正式声明为 alias：
   * 组件保持 `common:more`，locale 保留 `actions.more` 词条不得删除。
   */
  it('keeps the mobile attachment panel more/close aria-labels on resolvable keys', () => {
    const panelSource = readRepoSource(
      'src/features/chat/components/input-bar/AttachmentPanelBody.tsx',
    );
    // 与 releaseUpgradeI18n.test.ts 保持一致：组件复用顶层 common:more，
    // 不得回退到当年双语缺失的 common:actions.more
    expect(panelSource).toContain("aria-label={t('common:more'");
    expect(panelSource).not.toMatch(/actions\.more/);
    expect(panelSource).toContain("aria-label={t('common:actions.close')}");
    for (const locale of LOCALES) {
      const common = loadLocaleNamespace(locale, 'common');
      expect(resolveKeyToText(common, 'more')).toBe(true);
      // rel-mobile(#324) 增补的词条保留且双语可解析（严格非空字符串）
      expect(resolveKeyToText(common, 'actions.more')).toBe(true);
      expect(resolveKeyToText(common, 'actions.close')).toBe(true);
    }
  });
});
