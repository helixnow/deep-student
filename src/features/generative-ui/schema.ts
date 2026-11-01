/**
 * Generative UI — Zod Schema 校验层
 *
 * 模型输出必须经过 schema 校验；不合法则拒绝或降级 fallback。
 */

import { z } from 'zod';
import type { GenerativeLayoutMode, GenerativeLayoutUnit, GenerativeUIIntent } from './types';
import { sanitizeResearchSessionId } from './utils/extractResearchSessionId';
import { sanitizeGenerativeTextLeaves } from './utils/sanitizeGenerativeText';
import { isDangerousGenerativeUrl } from './utils/sanitizeGenerativeUrl';
import {
  GENUI_FOLLOWUP_ACTION_ID_RE,
  GENUI_FOLLOWUP_ACTION_PREFIX,
  GENUI_FOLLOWUP_PROMPT_MAX_CHARS,
  GENUI_FORM_FIELD_NAME_RE,
  GENUI_IMAGE_PDF_PAGE_MAX,
  GENUI_IMAGE_PDF_RESOURCE_ID_RE,
  GENUI_IMAGE_RESOURCE_ID_RE,
  GENUI_IMAGE_URL_MAX_CHARS,
  GENUI_INTERACTIVE_ID_RE,
  GENUI_MAX_FOLLOWUP_ACTIONS,
  GENUI_SLIDER_MAX_STEPS,
  GENUI_TEXT_FIELD_DEFAULT_MAX_CHARS,
  GENUI_TEXT_FIELD_MAX_CHARS,
  countGenuiChars,
} from './interaction/limits';
import {
  MAX_GENERATIVE_UI_STREAM_CHARS,
  STREAM_BUFFER_CAPPED_WARNING,
  isStreamBufferOverCap,
} from './utils/streamBufferGuard';

export const GENERATIVE_UI_INTENT_VERSIONS = ['1', '1.1'] as const;
export const GENERATIVE_LAYOUT_UNITS = [1, 2, 3] as const;

/** 将任意输入钳制到 1|2|3（非法 / 缺失走 fallback） */
export function clampGenerativeLayoutUnit(
  value: unknown,
  fallback: GenerativeLayoutUnit = 1,
): GenerativeLayoutUnit {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n <= 1) return 1;
  if (n >= 3) return 3;
  return 2;
}

const optionalLayoutUnitSchema = z
  .number()
  .optional()
  .transform((n) => (typeof n === 'number' ? clampGenerativeLayoutUnit(n) : undefined));

/** 顶层 layout：stack 单列 / grid 2–3 列 */
export const generativeLayoutSchema = z.object({
  mode: z.enum(['stack', 'grid']),
  columns: optionalLayoutUnitSchema,
});

/** 块意图 schema */
export const generativeBlockIntentSchema = z.object({
  type: z.string().min(1).max(64),
  props: z.record(z.string(), z.unknown()).optional().default({}),
  id: z.string().max(128).optional(),
  span: optionalLayoutUnitSchema,
});

/** 与 schema max 对齐的块数上限 */
export const MAX_GENERATIVE_UI_BLOCKS = 32;

const generativeUIMetaSchema = z
  .object({
    title: z.string().max(200).optional(),
    description: z.string().max(1000).optional(),
    researchSessionId: z
      .unknown()
      .optional()
      .transform((value) => sanitizeResearchSessionId(value) ?? undefined),
  })
  .optional();

/** 完整 UI 意图文档 schema（version 默认仍为 '1'；未知 version 失败） */
export const generativeUIIntentSchema = z.object({
  version: z.enum(GENERATIVE_UI_INTENT_VERSIONS).optional().default('1'),
  layout: generativeLayoutSchema.optional(),
  blocks: z.array(generativeBlockIntentSchema).min(0).max(MAX_GENERATIVE_UI_BLOCKS),
  meta: generativeUIMetaSchema,
});

/** 解析后的布局：无 layout 字段视为 stack / 1 列；grid 缺省 columns=2 */
export function resolveGenerativeLayout(intent: Pick<GenerativeUIIntent, 'layout'>): {
  mode: GenerativeLayoutMode;
  columns: GenerativeLayoutUnit;
} {
  const mode: GenerativeLayoutMode = intent.layout?.mode === 'grid' ? 'grid' : 'stack';
  const raw = intent.layout?.columns;
  const columns =
    raw === undefined ? (mode === 'grid' ? 2 : 1) : clampGenerativeLayoutUnit(raw);
  return { mode, columns };
}

/**
 * 仅允许受控 Tailwind token，不把模型 class 透传到 DOM。
 * compact=true（窄屏 < sm）强制单列 stack + gap-2，不输出 sm:grid-cols-*，桌面默认签名不变。
 */
export function layoutGridClassName(
  mode: GenerativeLayoutMode,
  columns: GenerativeLayoutUnit,
  compact = false,
): string {
  if (compact) return 'grid gap-2';
  if (mode === 'grid' && columns === 2) return 'grid gap-3 sm:grid-cols-2';
  if (mode === 'grid' && columns === 3) return 'grid gap-3 sm:grid-cols-3';
  return 'grid gap-3';
}

export function layoutSpanClassName(
  mode: GenerativeLayoutMode,
  span?: GenerativeLayoutUnit,
  compact = false,
): string | undefined {
  if (compact || mode !== 'grid') return undefined;
  if (span === 2) return 'sm:col-span-2';
  if (span === 3) return 'sm:col-span-3';
  return undefined;
}

export type GenerativeBlockIntentSchema = z.infer<typeof generativeBlockIntentSchema>;
export type GenerativeUIIntentSchema = z.infer<typeof generativeUIIntentSchema>;

/** 各内置组件 props schema — 在 blocks/ 中扩展 */

export const statCardPropsSchema = z.object({
  id: z.string().optional(),
  title: z.string().min(1).max(120),
  value: z.union([z.string(), z.number()]),
  subtitle: z.string().max(200).optional(),
  trend: z.enum(['up', 'down', 'neutral']).optional(),
  trendLabel: z.string().max(80).optional(),
});

export const alertBlockPropsSchema = z.object({
  id: z.string().optional(),
  variant: z.enum(['default', 'info', 'warning', 'destructive']).optional().default('default'),
  title: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
});

export const listBlockPropsSchema = z.object({
  id: z.string().optional(),
  title: z.string().max(120).optional(),
  items: z
    .array(
      z.object({
        id: z.string().optional(),
        label: z.string().min(1).max(200),
        description: z.string().max(300).optional(),
        badge: z.string().max(40).optional(),
      }),
    )
    .min(0)
    .max(50),
  emptyLabel: z.string().max(80).optional(),
});

export const progressBlockPropsSchema = z.object({
  id: z.string().optional(),
  title: z.string().max(120).optional(),
  current: z.number().min(0),
  total: z.number().min(1),
  label: z.string().max(80).optional(),
});

/** action id 以此开头 ⇔ 必须带 prompt（send-followup） */
export const FOLLOWUP_ACTION_PREFIX = GENUI_FOLLOWUP_ACTION_PREFIX;

export function isFollowupActionId(id: unknown): boolean {
  return typeof id === 'string' && id.startsWith(GENUI_FOLLOWUP_ACTION_PREFIX);
}

const ACTION_RISK_ORDER = { low: 0, medium: 1, high: 2 } as const;

/**
 * action-bar 单个 action。
 * - followup:<slug>（^followup:[a-z0-9-]{1,40}$）⇔ 必须带 prompt（1..500）；非 followup 不得带 prompt。
 * - confirm=true → 解析结果 riskLevel 至少提升为 medium（行内二次确认）。
 */
export const generativeActionSchema = z
  .object({
    id: z.string().min(1).max(64),
    label: z.string().min(1).max(60),
    variant: z.enum(['default', 'primary', 'destructive']).optional().default('default'),
    riskLevel: z.enum(['low', 'medium', 'high']).optional().default('low'),
    prompt: z.string().min(1).max(GENUI_FOLLOWUP_PROMPT_MAX_CHARS).optional(),
    confirm: z.boolean().optional(),
  })
  .superRefine((action, ctx) => {
    const followup = isFollowupActionId(action.id);
    if (followup && !GENUI_FOLLOWUP_ACTION_ID_RE.test(action.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['id'],
        message: 'followup action id must match ^followup:[a-z0-9-]{1,40}$',
      });
    }
    if (followup && action.prompt === undefined) {
      ctx.addIssue({ code: 'custom', path: ['prompt'], message: 'followup action requires prompt' });
    }
    if (!followup && action.prompt !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['prompt'],
        message: 'prompt is only allowed on followup:* actions',
      });
    }
  })
  .transform((action) =>
    action.confirm === true && ACTION_RISK_ORDER[action.riskLevel] < ACTION_RISK_ORDER.medium
      ? { ...action, riskLevel: 'medium' as const }
      : action,
  );

export const actionBarPropsSchema = z.object({
  id: z.string().optional(),
  actions: z
    .array(generativeActionSchema)
    .min(1)
    .max(6)
    .refine(
      (actions) =>
        actions.filter((a) => isFollowupActionId(a.id)).length <= GENUI_MAX_FOLLOWUP_ACTIONS,
      { message: `at most ${GENUI_MAX_FOLLOWUP_ACTIONS} followup:* actions` },
    ),
});

// ---------------------------------------------------------------------------
// 交互作答 / 图片块（choice、form、image）
// ---------------------------------------------------------------------------

/** IPv4 点分字面量（WHATWG URL 会把 0x7f.1 等变体规范化成点分） */
const IPV4_HOST_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
/** 路径穿越 / 反斜杠：同 Rust validate_genui_image_url（含 `\`、`../`、结尾 `/..`、`%2e%2e`） */
function hasTraversalFragment(raw: string): boolean {
  const lower = raw.toLowerCase();
  return lower.includes('\\') || lower.includes('../') || lower.endsWith('/..') || lower.includes('%2e%2e');
}
/** 空白或 Unicode Cc 控制字符 */
// eslint-disable-next-line no-control-regex
const WHITESPACE_OR_CONTROL_RE = /[\s\u0000-\u001F\u007F-\u009F]/;
/** 非空（trim 后）字符串，与 Rust get_str(non_empty=true) 一致 */
const nonBlank = (max: number) =>
  z.string().min(1).max(max).refine((s) => s.trim().length > 0, { message: 'must not be blank' });

/**
 * 外链图片 URL 规则（与 Rust 同义）：仅 https、≤2048、拒绝凭据 / localhost / IP 字面量 /
 * 单标签主机 / `../` / 空白。
 */
export function isAllowedGenerativeImageUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length === 0) return false;
  if (countGenuiChars(raw) > GENUI_IMAGE_URL_MAX_CHARS) return false;
  if (WHITESPACE_OR_CONTROL_RE.test(raw)) return false;
  if (!/^https:\/\//i.test(raw)) return false;
  if (hasTraversalFragment(raw)) return false;
  if (isDangerousGenerativeUrl(raw)) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host.startsWith('[') || host.includes(':')) return false;
  if (IPV4_HOST_RE.test(host)) return false;
  if (!host.includes('.')) return false;
  return true;
}

/** 图片来源：VFS 资源 / PDF 页 / https 外链 */
export const generativeImageSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('resource'),
    resourceId: z.string().regex(GENUI_IMAGE_RESOURCE_ID_RE),
  }),
  z.object({
    kind: z.literal('pdf-page'),
    resourceId: z.string().regex(GENUI_IMAGE_PDF_RESOURCE_ID_RE),
    page: z.number().int().min(1).max(GENUI_IMAGE_PDF_PAGE_MAX),
  }),
  z.object({
    kind: z.literal('url'),
    url: z
      .string()
      .max(GENUI_IMAGE_URL_MAX_CHARS)
      .refine((value) => isAllowedGenerativeImageUrl(value), {
        message: 'image url must be a public https URL (no credentials/localhost/IP literal)',
      }),
  }),
]);

export const choiceOptionSchema = z.object({
  id: z.string().regex(GENUI_INTERACTIVE_ID_RE),
  label: nonBlank(120),
  description: z.string().max(300).optional(),
  image: generativeImageSourceSchema.optional(),
});

/**
 * 选择题。实际交互 id 取 block.id（Rust 强制必填）。
 * multiple：minSelect 缺省 1、maxSelect 缺省 options.length，须 0 ≤ min ≤ max ≤ options.length。
 */
export const choicePropsSchema = z
  .object({
    id: z.string().optional(),
    question: nonBlank(300),
    description: z.string().max(500).optional(),
    mode: z.enum(['single', 'multiple']).default('single'),
    options: z.array(choiceOptionSchema).min(2).max(12),
    minSelect: z.number().int().min(0).optional(),
    maxSelect: z.number().int().min(1).optional(),
    allowOther: z.boolean().optional().default(false),
    required: z.boolean().optional().default(true),
  })
  .superRefine((props, ctx) => {
    const seen = new Set<string>();
    props.options.forEach((option, index) => {
      if (seen.has(option.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['options', index, 'id'],
          message: `duplicate option id: ${option.id}`,
        });
      }
      seen.add(option.id);
    });
    if (props.mode === 'multiple') {
      const { min, max } = resolveChoiceSelectBounds(props);
      if (props.maxSelect !== undefined && props.maxSelect > props.options.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['maxSelect'],
          message: 'maxSelect must be <= options.length',
        });
      }
      if (min > max) {
        ctx.addIssue({ code: 'custom', path: ['minSelect'], message: 'minSelect must be <= maxSelect' });
      }
    }
  });

/** multiple 的有效选择范围（single 恒为 [1,1]）；不含 required=false 允许 0 的放宽 */
export function resolveChoiceSelectBounds(props: {
  mode?: 'single' | 'multiple';
  options: readonly unknown[];
  minSelect?: number;
  maxSelect?: number;
}): { min: number; max: number } {
  if (props.mode !== 'multiple') return { min: 1, max: 1 };
  const max = Math.min(props.maxSelect ?? props.options.length, props.options.length);
  const min = props.minSelect ?? 1;
  return { min, max };
}

const formFieldBase = {
  name: z.string().regex(GENUI_FORM_FIELD_NAME_RE),
  label: nonBlank(80),
  help: z.string().max(200).optional(),
  required: z.boolean().optional().default(false),
};

export const formTextFieldSchema = z.object({
  ...formFieldBase,
  kind: z.literal('text'),
  placeholder: z.string().max(120).optional(),
  maxLength: z
    .number()
    .int()
    .min(1)
    .max(GENUI_TEXT_FIELD_MAX_CHARS)
    .default(GENUI_TEXT_FIELD_DEFAULT_MAX_CHARS),
  multiline: z.boolean().optional(),
});

export const formNumberFieldSchema = z
  .object({
    ...formFieldBase,
    kind: z.literal('number'),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().positive().optional(),
    unit: z.string().max(16).optional(),
  })
  .refine((f) => f.min === undefined || f.max === undefined || f.min <= f.max, {
    message: 'min must be <= max',
    path: ['max'],
  });

export const formSliderFieldSchema = z
  .object({
    ...formFieldBase,
    kind: z.literal('slider'),
    min: z.number(),
    max: z.number(),
    step: z.number().positive().default(1),
    unit: z.string().max(16).optional(),
  })
  .superRefine((f, ctx) => {
    if (!(f.max > f.min)) {
      ctx.addIssue({ code: 'custom', path: ['max'], message: 'slider max must be > min' });
      return;
    }
    if ((f.max - f.min) / f.step > GENUI_SLIDER_MAX_STEPS) {
      ctx.addIssue({
        code: 'custom',
        path: ['step'],
        message: `slider (max-min)/step must be <= ${GENUI_SLIDER_MAX_STEPS}`,
      });
    }
  });

export const formRatingFieldSchema = z.object({
  ...formFieldBase,
  kind: z.literal('rating'),
  max: z.number().int().min(3).max(10).default(5),
});

export const formSwitchFieldSchema = z.object({
  ...formFieldBase,
  kind: z.literal('switch'),
  default: z.boolean().optional(),
});

export const formFieldSchema = z.discriminatedUnion('kind', [
  formTextFieldSchema,
  formNumberFieldSchema,
  formSliderFieldSchema,
  formRatingFieldSchema,
  formSwitchFieldSchema,
]);

export const formPropsSchema = z
  .object({
    id: z.string().optional(),
    title: z.string().max(120).optional(),
    description: z.string().max(500).optional(),
    fields: z.array(formFieldSchema).min(1).max(12),
    submitLabel: z.string().max(40).optional(),
  })
  .superRefine((props, ctx) => {
    const seen = new Set<string>();
    props.fields.forEach((field, index) => {
      if (seen.has(field.name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['fields', index, 'name'],
          message: `duplicate field name: ${field.name}`,
        });
      }
      seen.add(field.name);
    });
  });

export const imageBlockPropsSchema = z.object({
  id: z.string().optional(),
  source: generativeImageSourceSchema,
  alt: nonBlank(200),
  caption: z.string().max(300).optional(),
  fit: z.enum(['contain', 'cover']).optional().default('contain'),
  maxHeight: z.number().int().min(120).max(640).optional().default(320),
});

export type GenerativeImageSource = z.infer<typeof generativeImageSourceSchema>;
export type GenerativeAction = z.infer<typeof generativeActionSchema>;
export type ChoiceOption = z.infer<typeof choiceOptionSchema>;
export type ChoiceProps = z.infer<typeof choicePropsSchema>;
export type FormField = z.infer<typeof formFieldSchema>;
export type FormFieldKind = FormField['kind'];
export type FormProps = z.infer<typeof formPropsSchema>;
export type ImageBlockProps = z.infer<typeof imageBlockPropsSchema>;

export const textBlockPropsSchema = z.object({
  id: z.string().optional(),
  heading: z.string().max(120).optional(),
  body: z.string().min(1).max(4000),
  density: z.enum(['compact', 'normal']).optional().default('normal'),
});

export const keyValueGridPropsSchema = z.object({
  id: z.string().optional(),
  title: z.string().max(120).optional(),
  rows: z
    .array(
      z.object({
        key: z.string().min(1).max(80),
        value: z.string().min(1).max(300),
      }),
    )
    .min(1)
    .max(20),
});

export type StatCardProps = z.infer<typeof statCardPropsSchema>;
export type AlertBlockProps = z.infer<typeof alertBlockPropsSchema>;
export type ListBlockProps = z.infer<typeof listBlockPropsSchema>;
export type ProgressBlockProps = z.infer<typeof progressBlockPropsSchema>;
export type ActionBarProps = z.infer<typeof actionBarPropsSchema>;
export type TextBlockProps = z.infer<typeof textBlockPropsSchema>;
export type KeyValueGridProps = z.infer<typeof keyValueGridPropsSchema>;

/** 从 JSON 字符串解析并校验 UI 意图 */
export function parseGenerativeUIIntent(
  raw: string,
  maxChars: number = MAX_GENERATIVE_UI_STREAM_CHARS,
): {
  ok: true;
  intent: GenerativeUIIntentSchema;
} | {
  ok: false;
  errors: string[];
} {
  if (isStreamBufferOverCap(raw.length, maxChars)) {
    return { ok: false, errors: [STREAM_BUFFER_CAPPED_WARNING] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, errors: [`Invalid JSON: ${(e as Error).message}`] };
  }

  const result = generativeUIIntentSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    };
  }
  return { ok: true, intent: result.data };
}

/** 校验单个块的 props（需已注册 type 的 schema） */
export function validateBlockProps<T>(
  schema: z.ZodType<T>,
  props: unknown,
): { ok: true; props: T } | { ok: false; errors: string[] } {
  const result = schema.safeParse(sanitizeGenerativeTextLeaves(props));
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    };
  }
  return { ok: true, props: result.data };
}

export type ParseGenerativeUIIntentResult = ReturnType<typeof parseGenerativeUIIntent>;
export type ValidateBlockPropsResult<T> = ReturnType<typeof validateBlockProps<T>>;

export function isGenerativeUIParseFailure(
  result: ParseGenerativeUIIntentResult,
): result is Extract<ParseGenerativeUIIntentResult, { ok: false }> {
  return result.ok === false;
}

export function isBlockPropsValidationFailure<T>(
  result: ValidateBlockPropsResult<T>,
): result is Extract<ValidateBlockPropsResult<T>, { ok: false }> {
  return result.ok === false;
}

export interface RecoveredBlockList {
  blocks: GenerativeBlockIntentSchema[];
  dropped: number;
  truncated: boolean;
  warnings: string[];
}

export interface RecoveredGenerativeUIIntent {
  intent: GenerativeUIIntentSchema;
  dropped: number;
  truncated: boolean;
  warnings: string[];
}

/** 从未知块列表抽出合法块：丢弃非法、id 去重（先到优先）、超过上限截断 */
export function recoverGenerativeBlocks(rawBlocks: unknown[]): RecoveredBlockList {
  const warnings: string[] = [];
  const seenIds = new Set<string>();
  const blocks: GenerativeBlockIntentSchema[] = [];
  let dropped = 0;
  let truncated = false;

  for (const raw of rawBlocks) {
    const result = generativeBlockIntentSchema.safeParse(raw);
    if (!result.success) {
      dropped += 1;
      continue;
    }

    const block = result.data;
    if (block.id) {
      if (seenIds.has(block.id)) {
        dropped += 1;
        warnings.push(`duplicate-id:${block.id}`);
        continue;
      }
      seenIds.add(block.id);
    }

    if (blocks.length >= MAX_GENERATIVE_UI_BLOCKS) {
      truncated = true;
      if (!warnings.includes('blocks-truncated')) {
        warnings.push('blocks-truncated');
      }
      continue;
    }

    blocks.push(block);
  }

  return { blocks, dropped, truncated, warnings };
}

/** 从已解析对象恢复意图（不要求整份 schema 一次通过） */
export function recoverGenerativeUIIntent(value: unknown): RecoveredGenerativeUIIntent | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.blocks)) return null;

  const recovered = recoverGenerativeBlocks(obj.blocks);
  const metaResult = generativeUIMetaSchema.safeParse(obj.meta);
  const layoutResult =
    obj.layout === undefined
      ? { success: true as const, data: undefined }
      : generativeLayoutSchema.safeParse(obj.layout);
  const version = obj.version === '1.1' ? '1.1' : '1';

  return {
    intent: {
      version,
      layout: layoutResult.success ? layoutResult.data : undefined,
      blocks: recovered.blocks,
      meta: metaResult.success ? metaResult.data : undefined,
    },
    dropped: recovered.dropped,
    truncated: recovered.truncated,
    warnings: recovered.warnings,
  };
}

/** 宽松 parse helper：完整 JSON 失败时尽量保留合法 blocks */
export function parseGenerativeUIIntentRecovered(
  input: string | unknown,
  maxChars: number = MAX_GENERATIVE_UI_STREAM_CHARS,
):
  | {
      ok: true;
      intent: GenerativeUIIntentSchema;
      dropped: number;
      truncated: boolean;
      warnings: string[];
    }
  | {
      ok: false;
      errors: string[];
    } {
  let value: unknown = input;
  if (typeof input === 'string') {
    if (isStreamBufferOverCap(input.length, maxChars)) {
      return { ok: false, errors: [STREAM_BUFFER_CAPPED_WARNING] };
    }
    try {
      value = JSON.parse(input);
    } catch (e) {
      return { ok: false, errors: [`Invalid JSON: ${(e as Error).message}`] };
    }
  }

  const recovered = recoverGenerativeUIIntent(value);
  if (!recovered) {
    return { ok: false, errors: ['Unable to recover UI intent'] };
  }
  return {
    ok: true,
    intent: recovered.intent,
    dropped: recovered.dropped,
    truncated: recovered.truncated,
    warnings: recovered.warnings,
  };
}

// Extended built-in block schemas. Kept free of React/chart/editor imports.

export const flashcardPreviewPropsSchema = z.object({
  id: z.string().optional(),
  front: z.string().min(1).max(500),
  back: z.string().min(1).max(1000),
  tags: z.array(z.string().max(40)).max(8).optional(),
  deckName: z.string().max(80).optional(),
});

export const reviewCalendarPropsSchema = z.object({
  id: z.string().optional(),
  title: z.string().max(120).optional(),
  days: z
    .array(
      z.object({
        date: z.string().min(1).max(20),
        label: z.string().max(40).optional(),
        dueCount: z.number().min(0),
        completedCount: z.number().min(0).optional(),
      }),
    )
    .min(1)
    .max(14),
});

export const mistakeAnalysisPropsSchema = z.object({
  id: z.string().optional(),
  topic: z.string().min(1).max(120),
  errorRate: z.number().min(0).max(100),
  mistakeCount: z.number().min(0).optional(),
  suggestion: z.string().max(500),
  severity: z.enum(['low', 'medium', 'high']).optional().default('medium'),
});

const GENERATIVE_EMBED_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const mindmapEmbedPropsSchema = z
  .object({
    id: z.string().optional(),
    mindmapId: z.string().min(1).max(128).regex(GENERATIVE_EMBED_ID_RE).optional(),
    versionId: z.string().min(1).max(128).regex(GENERATIVE_EMBED_ID_RE).optional(),
    title: z.string().max(120).optional(),
    height: z.number().min(200).max(600).optional().default(280),
  })
  .refine((data) => Boolean(data.mindmapId || data.versionId), {
    message: 'mindmapId or versionId is required',
  });

export const paperDigestPropsSchema = z.object({
  id: z.string().optional(),
  title: z.string().min(1).max(300),
  authors: z.string().max(200).optional(),
  venue: z.string().max(120).optional(),
  year: z.number().int().min(1900).max(2100).optional(),
  citationLabel: z.string().max(40).optional(),
  citationCount: z.number().min(0).optional(),
  keyFindings: z.array(z.string().min(1).max(300)).max(8).optional(),
  abstractExcerpt: z.string().max(500).optional(),
});

export const researchPlanStepSchema = z.object({
  label: z.string().min(1).max(200),
  status: z.enum(['pending', 'active', 'done']).optional().default('pending'),
});

export const researchPlanPropsSchema = z.object({
  id: z.string().optional(),
  title: z.string().min(1).max(160),
  round: z.number().int().min(1).optional(),
  steps: z.array(researchPlanStepSchema).min(1).max(12),
});

export const researchReportPropsSchema = z.object({
  id: z.string().optional(),
  title: z.string().max(200).optional(),
  body: z.string().min(1).max(12000),
  density: z.enum(['compact', 'normal']).optional().default('normal'),
});

export const MARKDOWN_TITLE_MAX = 120;

export const MARKDOWN_BODY_MAX = 20000;

export const markdownPropsSchema = z.object({
  id: z.string().optional(),
  title: z.string().max(MARKDOWN_TITLE_MAX).optional(),
  body: z.string().min(1).max(MARKDOWN_BODY_MAX),
  variant: z.enum(['default', 'compact']).optional(),
});

export const CHART_KINDS = ['bar', 'line', 'pie'] as const;

export const chartSeriesSchema = z.object({
  name: z.string().max(40),
  values: z.array(z.number()),
});

export const chartBlockPropsSchema = z
  .object({
    id: z.string().optional(),
    title: z.string().max(120).optional(),
    kind: z.enum(CHART_KINDS),
    categories: z.array(z.string()).min(1).max(24),
    series: z.array(chartSeriesSchema).min(1).max(8).optional(),
    unit: z.string().max(16).optional(),
  })
  .refine(
    (data) =>
      (data.series ?? []).every((item) => item.values.length === data.categories.length),
    { message: 'series.values.length must equal categories.length', path: ['series'] },
  );

export const STEPS_STATUSES = ['pending', 'active', 'done', 'error', 'skipped'] as const;

export const stepsStepSchema = z.object({
  id: z.string().optional(),
  label: z.string().min(1).max(160),
  description: z.string().max(300).optional(),
  status: z.enum(STEPS_STATUSES).default('pending'),
  durationLabel: z.string().max(40).optional(),
});

export const stepsBlockPropsSchema = z.object({
  id: z.string().optional(),
  title: z.string().max(120).optional(),
  steps: z.array(stepsStepSchema).min(1).max(20),
});

const TABLE_ALIGN = ['left', 'center', 'right'] as const;

export const tableColumnSchema = z.object({
  key: z.string().min(1).max(40),
  label: z.string().min(1).max(80),
  align: z.enum(TABLE_ALIGN).optional(),
});

export const tableBlockPropsSchema = z.object({
  id: z.string().optional(),
  title: z.string().max(120).optional(),
  columns: z.array(tableColumnSchema).min(1).max(12),
  rows: z.array(z.record(z.string(), z.union([z.string(), z.number()]))).min(0).max(50),
  emptyLabel: z.string().max(80).optional(),
  caption: z.string().max(200).optional(),
});
