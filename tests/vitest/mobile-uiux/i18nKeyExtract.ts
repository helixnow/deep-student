/**
 * 拆分输入栏 i18n 键提取辅助（0824 Wave2-C R5「i18n 守卫-AST」）
 *
 * 供 inputBarSplitI18nKeys.contract.test.ts 使用的纯提取层：
 *
 * 1. 字面量键：`t('ns:path.to.key')` / `i18n.t('ns:key', …)`（命名空间显式）；
 *    对声明了 defaultNamespace 的文件，还提取无前缀字面量 `t('path.to.key')`
 *    并展开为 `ns:path.to.key`（如 ComposerPanel 统一 useTranslation('chatV2')）。
 * 2. 模板字符串键：`t(\`ns:prefix.${expr}\`)` 先把每个 ${…} 占位符规格化为
 *    骨架 `ns:prefix.*`，再按 INPUT_BAR_TEMPLATE_EXPANSIONS 注册表把动态枚举
 *    逐值展开成完整键（uploadStage / permissionPreset modes|hints|shortHints /
 *    injectMode / thinkingDepth / compaction reason）。注册表不认识的带命名空间
 *    模板会记入 unexpandedTemplates —— 契约测试要求它必须为空，逼迫新增动态键
 *    时同步登记枚举展开。
 * 3. resolveKeyToText：叶子必须是**非空字符串**；路径打到中间对象（漏了最后
 *    一段）或空串一律判失败——旧实现 `typeof cursor === 'object'` 会把
 *    「键指向子树」误判为可解析。
 *
 * 枚举值来源都以产品声明为准（见各常量注释）；契约测试另有 drift 断言把这里
 * 的枚举与产品源码的声明做集合相等校验，防止两边悄悄漂移。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();

export type LocaleTree = Record<string, unknown>;

export interface ScanFileSpec {
  file: string;
  /**
   * 该文件内所有 useTranslation() 共用的唯一默认命名空间。仅当整个文件的
   * useTranslation 都是同一个单命名空间时才可声明（数组命名空间的 fallback
   * 语义有歧义，不做无前缀提取）。
   */
  defaultNamespace?: string;
}

export interface TemplateExpansion {
  /** 模板骨架：每个 ${…} 占位符规格化为 '*'，如 'chatV2:inputBar.uploadStage.*' */
  skeleton: string;
  /** 骨架对应动态枚举逐值展开后的完整命名空间键 */
  expandedKeys: readonly string[];
}

export interface UnexpandedTemplate {
  file: string;
  skeleton: string;
}

export interface ExtractedI18nKeys {
  /** 命名空间键 -> 引用它的文件集合（字面量 + 模板展开） */
  keys: Map<string, Set<string>>;
  /** 带显式命名空间、但展开注册表不认识的模板骨架（契约要求为空） */
  unexpandedTemplates: UnexpandedTemplate[];
}

/** 字面量 t('ns:path.to.key')；命名空间显式（含 chat_host 这类下划线命名空间） */
const LITERAL_NAMESPACED_KEY = /\bt\(\s*'([A-Za-z0-9_-]+):([A-Za-z0-9_.-]+)'/g;
/** 无前缀字面量 t('path.to.key')；字符集排除冒号，天然不会重复命中带命名空间的键 */
const LITERAL_BARE_KEY = /\bt\(\s*'([A-Za-z0-9_.-]+)'/g;
/** 模板字符串 t(`…`)；\b 允许 i18n.t(`…`) 的点前缀命中 */
const TEMPLATE_KEY = /\bt\(\s*`([^`]+)`/g;
const TEMPLATE_PLACEHOLDER = /\$\{[^}]*\}/g;

export const readRepoSource = (relPath: string): string =>
  readFileSync(resolve(ROOT, relPath), 'utf-8');

export const toTemplateSkeleton = (rawTemplate: string): string =>
  rawTemplate.replace(TEMPLATE_PLACEHOLDER, '*');

/** 提取源码片段里的所有单引号字符串（drift 断言用） */
export const collectQuotedStrings = (sourceSlice: string): string[] =>
  [...sourceSlice.matchAll(/'([^']+)'/g)].map((m) => m[1]);

export function extractI18nKeys(
  specs: readonly ScanFileSpec[],
  expansions: readonly TemplateExpansion[],
): ExtractedI18nKeys {
  const expansionBySkeleton = new Map(
    expansions.map((entry) => [entry.skeleton, entry.expandedKeys] as const),
  );
  const keys = new Map<string, Set<string>>();
  const unexpandedTemplates: UnexpandedTemplate[] = [];

  const record = (key: string, file: string): void => {
    if (!keys.has(key)) keys.set(key, new Set());
    keys.get(key)!.add(file);
  };

  for (const spec of specs) {
    const source = readRepoSource(spec.file);

    for (const match of source.matchAll(LITERAL_NAMESPACED_KEY)) {
      record(`${match[1]}:${match[2]}`, spec.file);
    }

    if (spec.defaultNamespace) {
      for (const match of source.matchAll(LITERAL_BARE_KEY)) {
        record(`${spec.defaultNamespace}:${match[1]}`, spec.file);
      }
    }

    for (const match of source.matchAll(TEMPLATE_KEY)) {
      const skeleton = toTemplateSkeleton(match[1]);
      // 无显式命名空间的模板（如 BlockingApprovalBar 的 approval.sensitivity.*）
      // 运行时按 useTranslation 数组的 fallback 语义解析，不在本契约范围
      if (!skeleton.includes(':')) continue;
      if (!skeleton.includes('*')) {
        // 无占位符的模板等价于字面量键
        const separatorIndex = skeleton.indexOf(':');
        record(
          `${skeleton.slice(0, separatorIndex)}:${skeleton.slice(separatorIndex + 1)}`,
          spec.file,
        );
        continue;
      }
      const expandedKeys = expansionBySkeleton.get(skeleton);
      if (!expandedKeys) {
        unexpandedTemplates.push({ file: spec.file, skeleton });
        continue;
      }
      for (const key of expandedKeys) record(key, spec.file);
    }
  }

  return { keys, unexpandedTemplates };
}

// ============================================================================
// Locale 读取与严格叶子解析
// ============================================================================

const namespaceCache = new Map<string, LocaleTree | null>();

export const loadLocaleNamespace = (locale: string, ns: string): LocaleTree | null => {
  const cacheKey = `${locale}/${ns}`;
  if (!namespaceCache.has(cacheKey)) {
    try {
      namespaceCache.set(
        cacheKey,
        JSON.parse(readRepoSource(`src/locales/${locale}/${ns}.json`)) as LocaleTree,
      );
    } catch {
      namespaceCache.set(cacheKey, null);
    }
  }
  return namespaceCache.get(cacheKey) ?? null;
};

/**
 * 键必须解析到**非空字符串**叶子。
 * 打到对象（键只写到子树，如 `chatV2:injectMode.pdf`）或空串都判失败。
 */
export const resolveKeyToText = (tree: LocaleTree | null, path: string): boolean => {
  if (!tree) return false;
  let cursor: unknown = tree;
  for (const part of path.split('.')) {
    if (
      cursor === null ||
      typeof cursor !== 'object' ||
      Array.isArray(cursor) ||
      !(part in (cursor as LocaleTree))
    ) {
      return false;
    }
    cursor = (cursor as LocaleTree)[part];
  }
  return typeof cursor === 'string' && cursor.trim().length > 0;
};

// ============================================================================
// 输入栏拆分组件的动态枚举（与产品声明一一对应，契约测试做 drift 校验）
// ============================================================================

/** AttachmentMeta.uploadStage（src/features/chat/core/types/common.ts） */
export const UPLOAD_STAGES = ['reading', 'uploading', 'creating'] as const;

/** PERMISSION_PRESETS（src/features/chat/components/input-bar/ComposerPlusMenu.tsx） */
export const PERMISSION_PRESETS = [
  'cautious',
  'relaxed',
  'full_access',
  'danger_full_access',
] as const;

/** ImageInjectMode（src/features/chat/core/types/common.ts） */
export const IMAGE_INJECT_MODES = ['image', 'ocr'] as const;

/** PdfInjectMode（src/features/chat/core/types/common.ts） */
export const PDF_INJECT_MODES = ['text', 'ocr', 'image'] as const;

/** THINKING_DEPTH_LABEL_KEYS 值域（src/features/chat/components/input-bar/InputBarV2.tsx） */
export const THINKING_DEPTH_SUFFIXES = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

/** KNOWN_COMPACTION_REASONS（src/features/chat/utils/compactionFeedback.ts）；unknown 是兜底键 */
export const COMPACTION_REASON_CODES = [
  'sessionTooShort',
  'usableTooSmall',
  'lockBusy',
  'streaming',
  'summaryFailed',
  'cancelled',
  'staleLineage',
  'invalidResponse',
] as const;

export const INPUT_BAR_TEMPLATE_EXPANSIONS: readonly TemplateExpansion[] = [
  {
    // AttachmentPanelBody: t(`chatV2:inputBar.uploadStage.${attachment.uploadStage || 'reading'}`)
    skeleton: 'chatV2:inputBar.uploadStage.*',
    expandedKeys: UPLOAD_STAGES.map((stage) => `chatV2:inputBar.uploadStage.${stage}`),
  },
  {
    // ComposerPlusMenu: t(`chatV2:authority.permissionPreset.modes.${preset}`)
    skeleton: 'chatV2:authority.permissionPreset.modes.*',
    expandedKeys: PERMISSION_PRESETS.map(
      (preset) => `chatV2:authority.permissionPreset.modes.${preset}`,
    ),
  },
  {
    // ComposerPlusMenu: title={t(`chatV2:authority.permissionPreset.hints.${preset}`)}
    skeleton: 'chatV2:authority.permissionPreset.hints.*',
    expandedKeys: PERMISSION_PRESETS.map(
      (preset) => `chatV2:authority.permissionPreset.hints.${preset}`,
    ),
  },
  {
    // ComposerPlusMenu: t(`chatV2:authority.permissionPreset.shortHints.${preset}`)
    skeleton: 'chatV2:authority.permissionPreset.shortHints.*',
    expandedKeys: PERMISSION_PRESETS.map(
      (preset) => `chatV2:authority.permissionPreset.shortHints.${preset}`,
    ),
  },
  {
    // useInputBarV2: i18n.t(`chatV2:injectMode.${mediaTypeKey}.${mode}`)
    // mediaTypeKey ∈ {pdf,image}，mode 取各媒体类型自己的注入模式集
    skeleton: 'chatV2:injectMode.*.*',
    expandedKeys: [
      ...PDF_INJECT_MODES.map((mode) => `chatV2:injectMode.pdf.${mode}`),
      ...IMAGE_INJECT_MODES.map((mode) => `chatV2:injectMode.image.${mode}`),
    ],
  },
  {
    // InputBarV2: t(`chatV2:inputBar.thinkingDepth.${keySuffix}`, fallback)
    skeleton: 'chatV2:inputBar.thinkingDepth.*',
    expandedKeys: THINKING_DEPTH_SUFFIXES.map(
      (suffix) => `chatV2:inputBar.thinkingDepth.${suffix}`,
    ),
  },
  {
    // InputBarV2: t(`chatV2:${compactionReasonI18nKey(result.reason)}`)
    // compactionReasonI18nKey 只会返回 compaction.reason.<code|unknown>；
    // 骨架宽（chatV2:*），契约测试锁定该调用点形状防止骨架被其他动态键复用
    skeleton: 'chatV2:*',
    expandedKeys: [...COMPACTION_REASON_CODES, 'unknown'].map(
      (reason) => `chatV2:compaction.reason.${reason}`,
    ),
  },
];

/**
 * 扫描清单：v0.9.44 → 0824 Composer 拆分出的输入栏组件。
 * InputBarV2.tsx / useInputBarV2.ts 是 thinkingDepth、compaction reason、
 * injectMode 三组模板键的宿主，为让动态枚举展开真正生效一并纳入。
 */
export const SPLIT_INPUT_BAR_SCAN_FILES: readonly ScanFileSpec[] = [
  { file: 'src/features/chat/components/input-bar/InputBarUI.tsx' },
  { file: 'src/features/chat/components/input-bar/InputBarV2.tsx' },
  { file: 'src/features/chat/components/input-bar/useInputBarV2.ts' },
  { file: 'src/features/chat/components/input-bar/ComposerToolbar.tsx' },
  { file: 'src/features/chat/components/input-bar/ComposerTextarea.tsx' },
  { file: 'src/features/chat/components/input-bar/ComposerPlusMenu.tsx' },
  { file: 'src/features/chat/components/input-bar/ComposerInlinePanel.tsx' },
  {
    file: 'src/features/chat/components/input-bar/ComposerPanel/ComposerPanel.tsx',
    // 文件内两处 useTranslation 均为单命名空间 'chatV2'，
    // 无前缀键（common.close / common.clearSearch）按 chatV2:* 提取
    defaultNamespace: 'chatV2',
  },
  { file: 'src/features/chat/components/input-bar/AttachmentPanelBody.tsx' },
  { file: 'src/features/chat/components/input-bar/AttachmentPreviewChips.tsx' },
  { file: 'src/features/chat/components/input-bar/ContextUsagePopover.tsx' },
  { file: 'src/features/chat/components/input-bar/attachmentModeHelpers.ts' },
];
