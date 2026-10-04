/**
 * 预置批阅模式的展示文案本地化
 *
 * 预置模式（gaokao / ielts / cet …）的 name / description / 维度名由 Rust 端
 * `get_builtin_grading_modes()` 以中文（部分维度为英文）硬编码返回。这里按稳定的
 * canonical 模式 ID 把它们映射到 `essay_grading:builtinModes.<id>.*` 的 i18n 键，
 * 仅用于**展示**——发给模型的提示词、落库的模式配置一律保持后端原文。
 *
 * 用户自定义覆盖的判定（逐字段）：预置模式的覆盖与原模式同 ID（列表里还会被标
 * is_builtin=true），无法靠标记区分，所以每个字段只有在与预置原文**完全一致**时
 * 才翻译；用户改过的名称/描述/维度名原样显示。纯自定义模式 ID 不在表内，不翻译。
 *
 * BUILTIN_MODE_SOURCE 必须与 src-tauri/src/essay_grading/types.rs 及
 * zh-CN/essay_grading.json 的 builtinModes 保持一致（modeI18n.test.ts 校验）。
 */
import type { GradingMode } from './essayGradingApi';
import { canonicalizeEssayModeId } from './modeIds';

export interface BuiltinModeSource {
  name: string;
  description: string;
  /** dimKey → 后端原始维度名 */
  dimensions: Record<string, string>;
}

export const BUILTIN_MODE_SOURCE: Readonly<Record<string, BuiltinModeSource>> = {
  gaokao: {
    name: '高考作文',
    description: '按照高考作文评分标准进行批改，总分60分',
    dimensions: { content: '内容', expression: '表达', development: '发展等级' },
  },
  gaokao_en_short: {
    name: '高考英语小作文',
    description: '高考英语应用文写作评分模式，总分15分',
    dimensions: {
      content_key_points: 'Content & Key Points',
      language_quality: 'Language Quality',
      format_register: 'Format & Register',
    },
  },
  gaokao_en_long: {
    name: '高考英语大作文',
    description: '高考英语读后续写评分模式，总分25分',
    dimensions: {
      content_context_coherence: 'Content & Context Coherence',
      language_use: 'Language Use',
      cohesion_structure: 'Cohesion & Structure',
    },
  },
  ielts: {
    name: '雅思大作文',
    description: 'IELTS Writing Task 2（议论文）评分模式，总分9分',
    dimensions: {
      task_response: 'Task Response',
      coherence_cohesion: 'Coherence & Cohesion',
      lexical_resource: 'Lexical Resource',
      grammatical_range_accuracy: 'Grammatical Range & Accuracy',
    },
  },
  ielts_task1: {
    name: '雅思小作文',
    description: 'IELTS Writing Task 1（Academic/General）评分模式，总分9分',
    dimensions: {
      task_achievement: 'Task Achievement',
      coherence_cohesion: 'Coherence & Cohesion',
      lexical_resource: 'Lexical Resource',
      grammatical_range_accuracy: 'Grammatical Range & Accuracy',
    },
  },
  kaoyan: {
    name: '考研英语大作文',
    description: '考研英语（一图画/二图表）Part B 评分模式，总分20分',
    dimensions: {
      content_task_fulfillment: 'Content & Task Fulfillment',
      organization_coherence: 'Organization & Coherence',
      language_accuracy: 'Language & Accuracy',
    },
  },
  toefl: {
    name: '托福写作',
    description: 'TOEFL iBT Writing 评分模式（2026新版含Academic Discussion），总分5分',
    dimensions: {
      content_relevance: 'Content & Relevance',
      organization_coherence: 'Organization & Coherence',
      language_use: 'Language Use',
    },
  },
  zhongkao: {
    name: '中考作文',
    description: '按照中考作文评分标准进行批改，总分50分',
    dimensions: { content: '内容', expression: '表达', creativity: '创意' },
  },
  cet: {
    name: '四六级作文',
    description: '按照大学英语四六级作文评分标准进行批改，总分15分',
    dimensions: {
      content_relevance: 'Content & Relevance',
      organization: 'Organization',
      language: 'Language',
    },
  },
  practice: {
    name: '日常练习',
    description: '宽松友好的批改模式，适合日常写作练习',
    dimensions: {
      creativity_expression: '创意与表达',
      content_completeness: '内容完整',
      language_conventions: '语言规范',
    },
  },
};

/** 只需 i18next 的 t 的最小签名，方便组件直接传 useTranslation 的 t */
export type ModeI18nT = (key: string, options?: { defaultValue?: string }) => string;

type ModeLike = Pick<GradingMode, 'id'>;

function getBuiltinSource(modeId: string | null | undefined): [string, BuiltinModeSource] | null {
  if (!modeId) return null;
  const canonicalId = canonicalizeEssayModeId(modeId);
  const source = BUILTIN_MODE_SOURCE[canonicalId];
  return source ? [canonicalId, source] : null;
}

function translateOr(t: ModeI18nT, key: string, fallback: string): string {
  const translated = t(key, { defaultValue: fallback });
  // 缺键 / 测试桩返回键名时退回后端原文
  return typeof translated === 'string' && translated && translated !== key ? translated : fallback;
}

/** 预置模式（且名称未被用户改过）→ 当前语言名称；否则原样返回后端名称 */
export function getModeDisplayName(mode: ModeLike & Pick<GradingMode, 'name'>, t: ModeI18nT): string {
  const hit = getBuiltinSource(mode.id);
  if (!hit || mode.name !== hit[1].name) return mode.name;
  return translateOr(t, `essay_grading:builtinModes.${hit[0]}.name`, mode.name);
}

/** 预置模式（且描述未被用户改过）→ 当前语言描述；否则原样返回 */
export function getModeDisplayDescription(
  mode: ModeLike & Pick<GradingMode, 'description'>,
  t: ModeI18nT,
): string {
  const hit = getBuiltinSource(mode.id);
  if (!hit || mode.description !== hit[1].description) return mode.description;
  return translateOr(t, `essay_grading:builtinModes.${hit[0]}.description`, mode.description);
}

/**
 * 维度名本地化：仅当 modeId 是预置模式且维度名与该模式的预置维度原文一致时翻译。
 * 也用于批改结果里的维度名（来自模型 <dim name="…">，即该模式配置的维度名）。
 */
export function getDimensionDisplayName(
  modeId: string | null | undefined,
  dimensionName: string,
  t: ModeI18nT,
): string {
  const hit = getBuiltinSource(modeId);
  if (!hit) return dimensionName;
  const trimmed = dimensionName.trim();
  const dimKey = Object.keys(hit[1].dimensions).find((key) => hit[1].dimensions[key] === trimmed);
  if (!dimKey) return dimensionName;
  return translateOr(t, `essay_grading:builtinModes.${hit[0]}.dimensions.${dimKey}`, dimensionName);
}

/** 便捷：为某模式生成维度名映射函数（ScoreCard 等只拿到维度名的组件使用） */
export function createDimensionLabeler(
  modeId: string | null | undefined,
  t: ModeI18nT,
): ((dimensionName: string) => string) | undefined {
  if (!getBuiltinSource(modeId)) return undefined;
  return (dimensionName: string) => getDimensionDisplayName(modeId, dimensionName, t);
}

/** 标题本地化需要插值（session.auto_title 的 {{mode}} / {{subject}}） */
export type EssayTitleI18nT = (
  key: string,
  options?: { defaultValue?: string; mode?: string; subject?: string },
) => string;

/** 识别「预置模式中文原名 + ：/: + 主题」形式的标题前缀 */
function findBuiltinTitlePrefix(title: string): { id: string; subject: string } | null {
  for (const [id, source] of Object.entries(BUILTIN_MODE_SOURCE)) {
    if (!title.startsWith(source.name)) continue;
    const sep = title.charAt(source.name.length);
    if (sep !== ':' && sep !== '：') continue;
    const subject = title.slice(source.name.length + 1).trimStart();
    if (subject) return { id, subject };
  }
  return null;
}

/**
 * 仅展示：自动起名曾把预置模式的中文原名落库（「雅思大作文：…」「雅思大作文: …」），
 * 这里按当前界面语言换成本地化模式名重新拼接；其余标题（含自定义模式前缀）原样返回。
 * 不改存储——重命名编辑框仍以库内原文为准。
 */
export function localizeEssayTitle(title: string, t: EssayTitleI18nT): string {
  if (!title) return title;
  const hit = findBuiltinTitlePrefix(title);
  if (!hit) return title;
  const sourceName = BUILTIN_MODE_SOURCE[hit.id].name;
  const localizedName = translateOr(t as ModeI18nT, `essay_grading:builtinModes.${hit.id}.name`, sourceName);
  if (localizedName === sourceName) return title;
  const joinKey = 'essay_grading:session.auto_title';
  const joined = t(joinKey, { mode: localizedName, subject: hit.subject });
  return typeof joined === 'string' && joined && joined !== joinKey
    ? joined
    : `${localizedName}: ${hit.subject}`;
}
