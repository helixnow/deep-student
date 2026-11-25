/**
 * P3 产物模板骨架（canvas-in-skills）
 *
 * 三块职责：
 * 1. 注入面：skill 激活时把 `artifact.intentSkeleton` 渲染进 skill 正文
 *    （经现有 skill content 通道进 prompt，零新管道；不进 <available_skills>
 *    目录——目录会话级冻结，避免撑爆目录与 prompt cache）。
 * 2. 加载校验：对照 generativeUIRegistry 校验骨架 block type 合法性
 *    （白名单实际有三处：skill content 硬编码 / 前端 registry / Rust
 *    ALLOWED_GENERATIVE_UI_BLOCK_TYPES——以前端 registry 为准）。
 * 3. 执行校验：generative-ui onEnd 处对照已激活 skill 的骨架校验块序列，
 *    不符则降级为普通产物 + 提示（无工具错误通道，零协议改动）。
 */

import type { GenerativeUIIntent } from '@/features/generative-ui/types';
import { generativeUIRegistry } from '@/features/generative-ui/registry';
// Validation needs schema metadata, not React renderers/charting libraries.
import '@/features/generative-ui/blockSchemas';
import type { SkillArtifactDeclaration, SkillDefinition } from './types';

/** 骨架注入段的包裹标签（prompt 内可识别、审计可过滤） */
const ARTIFACT_TEMPLATE_TAG = 'artifact_template';

/** 用户自定义/已改写激活技能的首轮硬性约束包裹标签（S4-06 P1 #1） */
export const USER_SKILL_DIRECTIVE_TAG = 'user_skill_directive';
const USER_SKILL_SELF_CHECK_TAG = 'user_skill_self_check';

export type RenderableSkillInput = Pick<SkillDefinition, 'id' | 'content' | 'artifact'> &
  Partial<Pick<SkillDefinition, 'name' | 'location' | 'isBuiltin' | 'isCustomized' | 'packageSource' | 'sourcePath'>>;

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 判断技能是否为用户自建或用户显式修改过的自定义技能。
 *
 * - 非内置来源（global / project / external）或已自定义内置技能（isCustomized=true）返回 true；
 * - 原生内置技能及未提供来源字段的轻量单测桩返回 false（保持原样输出与零额外 token 开销）。
 */
export function isUserAuthoredSkill(skill: RenderableSkillInput): boolean {
  if (skill.isCustomized === true) return true;
  if (skill.isBuiltin === true || skill.packageSource === 'builtin') return false;
  if (skill.sourcePath?.startsWith('builtin://')) return false;
  return (
    skill.location === 'global' ||
    skill.location === 'project' ||
    skill.packageSource === 'global' ||
    skill.packageSource === 'project' ||
    skill.packageSource === 'external'
  );
}

/**
 * 把产物模板声明与用户自定义技能的首轮硬性约束框架渲染进 skill 正文。
 *
 * - 原生内置技能且无 artifact 声明（或骨架为空）时原样返回；
 * - 非内置/用户自定义技能且正文非空时，增加紧凑高显著性的首轮约束指令头与输出前自检尾，
 *   确保其中的明确规则、格式约束与禁止项（如「禁止直接给出完整证明/答案」「只给下一步方向」）
 *   在 Turn 1 即被严格遵守，且 live 与 original replay 共享同一渲染结果（逐字节一致）。
 */
export function renderSkillContentWithArtifact(
  skill: RenderableSkillInput,
): string {
  const content = skill.content ?? '';
  const artifact = skill.artifact;

  let body = content;
  if (artifact?.intentSkeleton) {
    const layoutLock = artifact.layoutLock === true;
    const dataToolsAttr = artifact.dataTools?.length
      ? ` dataTools="${escapeXmlAttr(artifact.dataTools.join(','))}"`
      : '';
    const skeletonJson = JSON.stringify(artifact.intentSkeleton, null, 2);

    const section = [
      '',
      `<${ARTIFACT_TEMPLATE_TAG} skillId="${escapeXmlAttr(skill.id)}" layoutLock="${layoutLock}"${dataToolsAttr}>`,
      layoutLock
        ? '【产物模板】本技能已声明产物布局骨架。调用 render_generative_ui 时 intent 必须严格遵循以下骨架：只允许填充数据（props 内的值），不得增删块或改变块顺序。'
        : '【产物模板】本技能已声明产物布局骨架。调用 render_generative_ui 时 intent 应遵循以下骨架结构，可按需补充块。',
      '```json',
      skeletonJson,
      '```',
      `调用时填 skeletonRef="${skill.id}" 以声明遵循该骨架。`,
      `</${ARTIFACT_TEMPLATE_TAG}>`,
    ].join('\n');

    body += section;
  }

  if (
    !isUserAuthoredSkill(skill) ||
    body.trim().length === 0 ||
    body.includes(`<${USER_SKILL_DIRECTIVE_TAG}`)
  ) {
    return body;
  }

  const header = [
    `<${USER_SKILL_DIRECTIVE_TAG} skillId="${escapeXmlAttr(skill.id)}" enforcement="strict" scope="turn-1-and-all">`,
    '【用户自定义激活技能 · 首轮强制生效】以下规则由用户主动编写并启用，优先级高于默认解题/作答习惯。起草第 1 轮及后续每轮回复前，必须逐条核对并严格遵守其中全部硬性规则、格式要求与禁止项（特别是「禁止直接给出完整答案/完整证明」「只给下一步思考方向」等负向约束，绝不可擅自越界或提前剧透）。',
    `</${USER_SKILL_DIRECTIVE_TAG}>`,
  ].join('\n');

  const footer = [
    `<${USER_SKILL_SELF_CHECK_TAG}>`,
    '【输出前自检】确认本条回复未违反上方自定义技能的任何禁止项或格式约束，再输出给用户。',
    `</${USER_SKILL_SELF_CHECK_TAG}>`,
  ].join('\n');

  return `${header}\n\n${body}\n\n${footer}`;
}

export interface SkeletonTypeValidation {
  valid: boolean;
  /** 未在 generativeUIRegistry 注册的块类型 */
  unknownTypes: string[];
}

/**
 * 校验骨架中所有 block type 是否已在前端 registry 注册。
 * 骨架无 blocks 数组时视为合法（骨架可以只声明 layout/meta）。
 */
export function validateArtifactSkeletonTypes(
  skeleton: Record<string, unknown>,
): SkeletonTypeValidation {
  const blocks = Array.isArray(skeleton.blocks) ? skeleton.blocks : [];
  const unknownTypes: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const type = (block as { type?: unknown }).type;
    if (typeof type === 'string' && !generativeUIRegistry.has(type)) {
      unknownTypes.push(type);
    }
  }
  return { valid: unknownTypes.length === 0, unknownTypes };
}

export interface IntentSkeletonValidation {
  valid: boolean;
  /** 校验失败原因（机器可读 code + 参数，由调用方映射 i18n 文案） */
  errors: SkeletonValidationError[];
}

export interface SkeletonValidationError {
  code: 'count_mismatch' | 'block_mismatch' | 'missing_type';
  params: Record<string, string | number>;
}

function skeletonBlockTypes(skeleton: Record<string, unknown>): string[] {
  const blocks = Array.isArray(skeleton.blocks) ? skeleton.blocks : [];
  return blocks
    .map((b) => (b && typeof b === 'object' ? (b as { type?: unknown }).type : undefined))
    .filter((t): t is string => typeof t === 'string');
}

function intentBlockTypes(intent: GenerativeUIIntent): string[] {
  return (intent.blocks ?? [])
    .map((b) => b?.type)
    .filter((t): t is string => typeof t === 'string');
}

/**
 * 对照骨架校验实际 intent。
 *
 * - layoutLock=true：块类型序列必须完全一致（长度 + 顺序 + 类型）；
 * - layoutLock=false：骨架声明的块类型必须全部出现（可补充、可重排）。
 */
export function validateIntentAgainstSkeleton(
  intent: GenerativeUIIntent,
  artifact: SkillArtifactDeclaration,
): IntentSkeletonValidation {
  const skeleton = artifact.intentSkeleton;
  if (!skeleton) return { valid: true, errors: [] };

  const expected = skeletonBlockTypes(skeleton);
  if (expected.length === 0) return { valid: true, errors: [] };

  const actual = intentBlockTypes(intent);
  const errors: SkeletonValidationError[] = [];

  if (artifact.layoutLock === true) {
    if (actual.length !== expected.length) {
      errors.push({ code: 'count_mismatch', params: { expected: expected.length, actual: actual.length } });
    } else {
      for (let i = 0; i < expected.length; i++) {
        if (actual[i] !== expected[i]) {
          errors.push({
            code: 'block_mismatch',
            params: { index: i + 1, expected: expected[i], actual: actual[i] ?? '' },
          });
        }
      }
    }
  } else {
    const actualSet = new Set(actual);
    for (const type of expected) {
      if (!actualSet.has(type)) {
        errors.push({ code: 'missing_type', params: { type } });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * 在已激活 skill 集合中查找声明了骨架的模板（按 skeletonRef 精确匹配，
 * 或回退到唯一一个带骨架的激活 skill）。
 *
 * skeletonRef 必须指向**本会话已激活**的 skill——骨架只随激活正文注入
 * prompt，对未激活 skill 的骨架做校验属于误报（模型从未见过该骨架）。
 */
export function findActiveArtifactSkill(
  activeSkillIds: string[],
  getSkill: (id: string) => Pick<SkillDefinition, 'id' | 'artifact'> | undefined,
  skeletonRef?: string,
): { skillId: string; artifact: SkillArtifactDeclaration } | null {
  if (skeletonRef) {
    if (!activeSkillIds.includes(skeletonRef)) return null;
    const skill = getSkill(skeletonRef);
    if (skill?.artifact?.intentSkeleton) {
      return { skillId: skill.id, artifact: skill.artifact };
    }
    return null;
  }
  const withSkeleton = activeSkillIds
    .map((id) => getSkill(id))
    .filter((s): s is NonNullable<typeof s> => Boolean(s?.artifact?.intentSkeleton));
  if (withSkeleton.length === 1) {
    return { skillId: withSkeleton[0].id, artifact: withSkeleton[0].artifact! };
  }
  return null;
}
