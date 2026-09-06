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
// 内置块 import 即注册——保证校验时 registry 已填充，避免模块加载顺序导致误报
import '@/features/generative-ui/blocks';
import type { SkillArtifactDeclaration, SkillDefinition } from './types';

/** 骨架注入段的包裹标签（prompt 内可识别、审计可过滤） */
const ARTIFACT_TEMPLATE_TAG = 'artifact_template';

/**
 * 把产物模板声明渲染为 skill 正文的附加段。
 * 无 artifact 声明或骨架为空时原样返回。
 */
export function renderSkillContentWithArtifact(
  skill: Pick<SkillDefinition, 'id' | 'content' | 'artifact'>,
): string {
  const content = skill.content ?? '';
  const artifact = skill.artifact;
  if (!artifact?.intentSkeleton) return content;

  const layoutLock = artifact.layoutLock === true;
  const dataToolsAttr = artifact.dataTools?.length
    ? ` dataTools="${artifact.dataTools.join(',')}"`
    : '';
  const skeletonJson = JSON.stringify(artifact.intentSkeleton, null, 2);

  const section = [
    '',
    `<${ARTIFACT_TEMPLATE_TAG} skillId="${skill.id}" layoutLock="${layoutLock}"${dataToolsAttr}>`,
    layoutLock
      ? '【产物模板】本技能已声明产物布局骨架。调用 render_generative_ui 时 intent 必须严格遵循以下骨架：只允许填充数据（props 内的值），不得增删块或改变块顺序。'
      : '【产物模板】本技能已声明产物布局骨架。调用 render_generative_ui 时 intent 应遵循以下骨架结构，可按需补充块。',
    '```json',
    skeletonJson,
    '```',
    `调用时填 skeletonRef="${skill.id}" 以声明遵循该骨架。`,
    `</${ARTIFACT_TEMPLATE_TAG}>`,
  ].join('\n');

  return content + section;
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
  /** 校验失败原因（layoutLock 语义） */
  errors: string[];
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
  const errors: string[] = [];

  if (artifact.layoutLock === true) {
    if (actual.length !== expected.length) {
      errors.push(`layoutLock 要求 ${expected.length} 个块，实际 ${actual.length} 个`);
    } else {
      for (let i = 0; i < expected.length; i++) {
        if (actual[i] !== expected[i]) {
          errors.push(`第 ${i + 1} 块应为 ${expected[i]}，实际为 ${actual[i] ?? '(缺失)'}`);
        }
      }
    }
  } else {
    const actualSet = new Set(actual);
    for (const type of expected) {
      if (!actualSet.has(type)) {
        errors.push(`缺少骨架声明的块类型 ${type}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * 在已激活 skill 集合中查找声明了骨架的模板（按 skeletonRef 精确匹配，
 * 或回退到唯一一个带骨架的激活 skill）。
 */
export function findActiveArtifactSkill(
  activeSkillIds: string[],
  getSkill: (id: string) => Pick<SkillDefinition, 'id' | 'artifact'> | undefined,
  skeletonRef?: string,
): { skillId: string; artifact: SkillArtifactDeclaration } | null {
  if (skeletonRef) {
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
